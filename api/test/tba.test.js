"use strict";
/**
 * To-Be-Assigned pools: one demand-only pool per role. normalizeTbaPools converts
 * historical To-Be-Hired seats — renames to "TBA - <role>", merges same-role seats
 * (summing allocation collisions), drops capacity/start — and is idempotent.
 */
const test = require("node:test");
const assert = require("node:assert");
const { open } = require("../src/db");
const { normalizeTbaPools, roleSlug, tbaName } = require("../src/store");

const seedSeat = (db, key, name, role, opts = {}) =>
  db.run("INSERT INTO tbh (scenario,tbh_key,name,role,dept,start_month,capacity,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?,?,?,'x','2026-01-01',1)",
    [key, name, role, opts.dept || "", opts.start || null, opts.cap ?? null]);
const seedAlloc = (db, rk, tgt, month, hours) =>
  db.run("INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?, 'x','2026-01-01',1)", [rk, tgt, `${month}-01`, hours]);
const seedRate = (db, rk, tgt, rate) =>
  db.run("INSERT INTO bill_rate (scenario,resource_key,target_key,rate,updated_by,updated_at,version) VALUES ('baseline',?,?,?, 'x','2026-01-01',1)", [rk, tgt, rate]);

test("slug and pool naming", () => {
  assert.equal(roleSlug("Technical Consultant"), "tba-technical-consultant");
  assert.equal(roleSlug("  "), "tba-unassigned");
  assert.equal(tbaName("Technical Consultant"), "TBA - Technical Consultant");
  assert.equal(tbaName(""), "TBA - Unassigned");
});

test("same-role seats merge into one pool; collisions sum; demand-only", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedSeat(db, "imp-jason", "To Hire - Technical Consultant #1", "Technical Consultant", { start: "2026-09-01", cap: 160 });
  seedSeat(db, "imp-maria", "To Hire - Technical Consultant #2", "Technical Consultant", { cap: 160 });
  seedAlloc(db, "tbh:imp-jason", "prj:101", "2026-09", 100);
  seedAlloc(db, "tbh:imp-maria", "prj:101", "2026-09", 60);    // collision -> 160
  seedAlloc(db, "tbh:imp-maria", "prj:102", "2026-10", 80);    // straight move
  seedRate(db, "tbh:imp-jason", "prj:101", 150);
  seedRate(db, "tbh:imp-maria", "prj:101", 175);               // pool keeps first, drops this

  const r1 = await normalizeTbaPools(db);
  assert.deepEqual({ merged: r1.merged, renamed: r1.renamed }, { merged: 1, renamed: 1 });

  const pools = db.all("SELECT tbh_key, name, role, start_month, capacity FROM tbh");
  assert.equal(pools.length, 1, "one pool per role");
  assert.deepEqual(pools[0], { tbh_key: "tba-technical-consultant", name: "TBA - Technical Consultant", role: "Technical Consultant", start_month: null, capacity: null });

  const allocs = db.all("SELECT target_key, substr(month,1,7) m, hours FROM allocation WHERE resource_key='tbh:tba-technical-consultant' ORDER BY target_key");
  assert.deepEqual(allocs, [
    { target_key: "prj:101", m: "2026-09", hours: 160 },
    { target_key: "prj:102", m: "2026-10", hours: 80 },
  ], "hours pooled, collision summed");
  assert.equal(db.all("SELECT 1 FROM allocation WHERE resource_key LIKE 'tbh:imp-%'").length, 0, "old keys gone");

  const rate = db.get("SELECT rate FROM bill_rate WHERE resource_key='tbh:tba-technical-consultant' AND target_key='prj:101'");
  assert.equal(rate.rate, 150, "canonical member's rate wins");

  const r2 = await normalizeTbaPools(db);
  assert.deepEqual({ merged: r2.merged, renamed: r2.renamed }, { merged: 0, renamed: 0 }, "idempotent");
});

test("different roles stay separate; blank role pools as Unassigned", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedSeat(db, "a", "TBH · Solutions Architect", "Solutions Architect");
  seedSeat(db, "b", "RESOURCE 3", "");
  await normalizeTbaPools(db);
  const pools = db.all("SELECT tbh_key, name FROM tbh ORDER BY tbh_key");
  assert.deepEqual(pools, [
    { tbh_key: "tba-solutions-architect", name: "TBA - Solutions Architect" },
    { tbh_key: "tba-unassigned", name: "TBA - Unassigned" },
  ]);
});
