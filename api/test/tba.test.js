"use strict";
/**
 * To-Be-Assigned pools: one demand-only pool per (role, shore) — the same role
 * on- and offshore are DIFFERENT pools. normalizeTbaPools converts historical
 * To-Be-Hired seats: classifies unlabelled seats by average bill rate (< $100/hr
 * => offshore), renames to "TBA - <role> (Onshore|Offshore)", merges same-group
 * seats (summing allocation collisions), drops capacity/start. Idempotent.
 */
const test = require("node:test");
const assert = require("node:assert");
const { open } = require("../src/db");
const { normalizeTbaPools, roleSlug, tbaName, normShore } = require("../src/store");

const seedSeat = (db, key, name, role, opts = {}) =>
  db.run("INSERT INTO tbh (scenario,tbh_key,name,role,dept,shore,start_month,capacity,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?,?,?,?,'x','2026-01-01',1)",
    [key, name, role, opts.dept || "", opts.shore || "", opts.start || null, opts.cap ?? null]);
const seedAlloc = (db, rk, tgt, month, hours) =>
  db.run("INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?, 'x','2026-01-01',1)", [rk, tgt, `${month}-01`, hours]);
const seedRate = (db, rk, tgt, rate) =>
  db.run("INSERT INTO bill_rate (scenario,resource_key,target_key,rate,updated_by,updated_at,version) VALUES ('baseline',?,?,?, 'x','2026-01-01',1)", [rk, tgt, rate]);

test("slug, naming and shore normalization", () => {
  assert.equal(roleSlug("Technical Consultant"), "tba-technical-consultant-onshore", "shore defaults onshore");
  assert.equal(roleSlug("Technical Consultant", "Offshore"), "tba-technical-consultant-offshore");
  assert.equal(roleSlug("  "), "tba-unassigned-onshore");
  assert.equal(tbaName("Technical Consultant"), "TBA - Technical Consultant (Onshore)");
  assert.equal(tbaName("Technical Consultant", "offshore"), "TBA - Technical Consultant (Offshore)");
  assert.equal(normShore("OFFSHORE "), "offshore");
  assert.equal(normShore("anything else"), "onshore");
});

test("same role, different rates: <$100 seats become the OFFSHORE pool, others onshore", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedSeat(db, "imp-jason", "To Hire - TC #1", "Technical Consultant");           // rate 150 -> onshore
  seedSeat(db, "imp-dilip", "To Hire - TC #2", "Technical Consultant");           // rate 44  -> offshore
  seedAlloc(db, "tbh:imp-jason", "prj:101", "2026-09", 100);
  seedAlloc(db, "tbh:imp-dilip", "prj:101", "2026-09", 80);
  seedRate(db, "tbh:imp-jason", "prj:101", 150);
  seedRate(db, "tbh:imp-dilip", "prj:101", 44);

  await normalizeTbaPools(db);
  const pools = db.all("SELECT tbh_key, name, shore FROM tbh ORDER BY tbh_key");
  assert.deepEqual(pools, [
    { tbh_key: "tba-technical-consultant-offshore", name: "TBA - Technical Consultant (Offshore)", shore: "offshore" },
    { tbh_key: "tba-technical-consultant-onshore",  name: "TBA - Technical Consultant (Onshore)",  shore: "onshore" },
  ], "one pool per (role, shore) — NOT merged together");
  const on = db.get("SELECT hours FROM allocation WHERE resource_key='tbh:tba-technical-consultant-onshore'");
  const off = db.get("SELECT hours FROM allocation WHERE resource_key='tbh:tba-technical-consultant-offshore'");
  assert.deepEqual([on.hours, off.hours], [100, 80], "each pool keeps its own hours");
});

test("same (role, shore) seats merge, collisions sum, demand-only; idempotent", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedSeat(db, "a1", "TC A", "Technical Consultant", { start: "2026-09-01", cap: 160 });
  seedSeat(db, "a2", "TC B", "Technical Consultant");
  seedAlloc(db, "tbh:a1", "prj:101", "2026-09", 100);
  seedAlloc(db, "tbh:a2", "prj:101", "2026-09", 60);      // collision -> 160
  seedRate(db, "tbh:a1", "prj:101", 150);
  seedRate(db, "tbh:a2", "prj:101", 175);                 // both >=100 -> same onshore pool

  const r1 = await normalizeTbaPools(db);
  assert.deepEqual({ merged: r1.merged, renamed: r1.renamed }, { merged: 1, renamed: 1 });
  const pools = db.all("SELECT tbh_key, shore, start_month, capacity FROM tbh");
  assert.deepEqual(pools, [{ tbh_key: "tba-technical-consultant-onshore", shore: "onshore", start_month: null, capacity: null }]);
  const a = db.get("SELECT hours FROM allocation WHERE resource_key='tbh:tba-technical-consultant-onshore'");
  assert.equal(a.hours, 160, "collision summed");

  const r2 = await normalizeTbaPools(db);
  assert.deepEqual({ merged: r2.merged, renamed: r2.renamed }, { merged: 0, renamed: 0 }, "idempotent");
});

test("an explicit shore label wins over the rate heuristic", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedSeat(db, "b1", "cheap onshore", "Senior QA", { shore: "onshore" });
  seedRate(db, "tbh:b1", "prj:103", 60);                  // <100 but labelled onshore
  await normalizeTbaPools(db);
  const p = db.get("SELECT tbh_key, shore FROM tbh");
  assert.deepEqual(p, { tbh_key: "tba-senior-qa-onshore", shore: "onshore" }, "label respected, heuristic skipped");
});

test("no rates -> onshore; blank role pools as Unassigned", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedSeat(db, "a", "TBH · Solutions Architect", "Solutions Architect");
  seedSeat(db, "b", "RESOURCE 3", "");
  await normalizeTbaPools(db);
  const pools = db.all("SELECT tbh_key, name FROM tbh ORDER BY tbh_key");
  assert.deepEqual(pools, [
    { tbh_key: "tba-solutions-architect-onshore", name: "TBA - Solutions Architect (Onshore)" },
    { tbh_key: "tba-unassigned-onshore", name: "TBA - Unassigned (Onshore)" },
  ]);
});
