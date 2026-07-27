"use strict";
/**
 * Closed-CRM reconciliation: forecast parked on an opportunity that has closed in
 * Odoo is either migrated to its delivery project (keeping every hour) or, when no
 * confident project match exists, kept in place and flagged needs_project so the
 * next sync retries.
 */
const test = require("node:test");
const assert = require("node:assert");
const { open } = require("../src/db");
const { reconcileClosedCrm } = require("../src/odoo");
const { reassignAllocations, mapOpportunityToProject, getReference } = require("../src/store");

const U = { upn: "tester@tqstarling.com" };

function seedAlloc(db, resourceKey, targetKey, month, hours) {
  db.run(
    "INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?,?,'2026-01-01 00:00:00',1)",
    [resourceKey, targetKey, `${month}-01`, hours, U.upn]
  );
}
const allocOf = (db, targetKey) =>
  db.all("SELECT resource_key, target_key, substr(month,1,7) AS m, hours FROM allocation WHERE target_key=? ORDER BY resource_key,m", [targetKey]);

// Fake Odoo whose search_read honours the [["id","in",[…]]] domain on crm.lead,
// returning archived (closed) opportunities the normal readOpportunities() skips.
function fakeOdoo(closed) {
  return {
    searchRead: async (model, domain = []) => {
      if (model !== "crm.lead") return [];
      const idIn = (domain.find((d) => d[0] === "id" && d[1] === "in") || [])[2] || [];
      return idIn.filter((id) => closed[id]).map((id) => ({
        id: Number(id), name: closed[id].name,
        partner_id: closed[id].client ? [1, closed[id].client] : false,
        stage_id: [9, closed[id].stage || "Won"], active: false,
      }));
    },
  };
}

test("closed opp with a confident project match migrates the forecast crm -> prj", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:222", "2026-08", 100);
  seedAlloc(db, "emp:110", "crm:222", "2026-09", 120);

  const projects = [{ id: 119, name: "Advocate Health Implementation", client: "Advocate Health" }];
  const odoo = fakeOdoo({ 222: { name: "Advocate Health", client: "Advocate Health" } });

  const r = await reconcileClosedCrm(db, odoo, projects, new Set());   // 222 not open => closed
  assert.deepEqual({ migrated: r.migrated, flagged: r.flagged }, { migrated: 1, flagged: 0 });

  assert.equal(allocOf(db, "crm:222").length, 0, "nothing left on the CRM key");
  assert.deepEqual(allocOf(db, "prj:119").map((x) => [x.m, x.hours]), [["2026-08", 100], ["2026-09", 120]],
    "hours preserved on the project");
  const flagged = db.get("SELECT * FROM ref_opportunity WHERE id=222");
  assert.equal(flagged, undefined, "a migrated opp is not flagged");
});

test("closed opp with no match keeps the forecast and is flagged needs_project", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:223", "2026-08", 80);

  const odoo = fakeOdoo({ 223: { name: "Mystery Deal", client: "Nobody Inc", stage: "Lost" } });
  const r = await reconcileClosedCrm(db, odoo, [{ id: 119, name: "Advocate Health", client: "Advocate Health" }], new Set());

  assert.deepEqual({ migrated: r.migrated, flagged: r.flagged }, { migrated: 0, flagged: 1 });
  assert.equal(allocOf(db, "crm:223").length, 1, "forecast stays put");
  const row = db.get("SELECT name, stage, active, needs_project FROM ref_opportunity WHERE id=223");
  assert.deepEqual(row, { name: "Mystery Deal", stage: "Lost", active: 1, needs_project: 1 });

  const ref = await getReference(db);
  const opp = ref.opportunities.find((o) => o.id === 223);
  assert.equal(opp.needsProject, true, "the flag reaches the UI via getReference");
});

test("a previously-flagged opp migrates on the next sync once a project appears", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:223", "2026-08", 80);
  const odoo = fakeOdoo({ 223: { name: "Northwind Rollout", client: "Northwind" } });

  // sync 1: no matching project -> flagged
  await reconcileClosedCrm(db, odoo, [], new Set());
  assert.equal(db.get("SELECT needs_project FROM ref_opportunity WHERE id=223").needs_project, 1);

  // sync 2: replaceAll would have cleared the opp cache first; then the project exists
  db.run("DELETE FROM ref_opportunity");
  const r = await reconcileClosedCrm(db, odoo, [{ id: 501, name: "Northwind Rollout", client: "Northwind" }], new Set());
  assert.equal(r.migrated, 1);
  assert.equal(allocOf(db, "crm:223").length, 0);
  assert.deepEqual(allocOf(db, "prj:501").map((x) => x.hours), [80]);
});

test("migration into an existing project cell SUMS rather than dropping hours", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:222", "2026-08", 40);   // forecast on the opp
  seedAlloc(db, "emp:110", "prj:119", "2026-08", 10);   // someone also forecast the real project

  const odoo = fakeOdoo({ 222: { name: "Advocate Health", client: "Advocate Health" } });
  await reconcileClosedCrm(db, odoo, [{ id: 119, name: "Advocate Health Implementation", client: "Advocate Health" }], new Set());

  assert.equal(allocOf(db, "crm:222").length, 0);
  assert.deepEqual(allocOf(db, "prj:119").map((x) => x.hours), [50], "40 + 10 merged");
});

test("an opp that is still OPEN is left untouched", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:222", "2026-08", 100);
  const odoo = fakeOdoo({});   // never consulted

  const r = await reconcileClosedCrm(db, odoo, [], new Set([222]));   // 222 in the open set
  assert.deepEqual({ migrated: r.migrated, flagged: r.flagged, closed: r.closed }, { migrated: 0, flagged: 0, closed: 0 });
  assert.equal(allocOf(db, "crm:222").length, 1);
});

test("mapOpportunityToProject moves the forecast and retires the opp from the UI", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:223", "2026-08", 80);
  // a flagged opp as reconcile would have left it, plus the target project in cache
  db.run("INSERT INTO ref_opportunity (id,name,client,stage,active,needs_project) VALUES (223,'Mystery Deal','Nobody','Lost',1,1)");
  db.run("INSERT INTO ref_project (id,name,client,billable,active) VALUES (777,'Rescued Project','Nobody',1,1)");

  const out = await mapOpportunityToProject(db, U, 223, 777);
  assert.deepEqual({ moved: out.moved, from: out.from, to: out.to }, { moved: 1, from: "crm:223", to: "prj:777" });
  assert.equal(allocOf(db, "crm:223").length, 0);
  assert.deepEqual(allocOf(db, "prj:777").map((x) => x.hours), [80]);

  const ref = await getReference(db);
  assert.equal(ref.opportunities.find((o) => o.id === 223), undefined, "retired opp (active=0) no longer surfaces");
  const log = db.all("SELECT action FROM audit_log WHERE entity='opportunity'");
  assert.deepEqual(log.map((l) => l.action), ["map"]);
});

test("reassignAllocations audits every move", async () => {
  const db = open({ driver: "sqlite", file: ":memory:" });
  seedAlloc(db, "emp:110", "crm:222", "2026-08", 100);
  const out = await reassignAllocations(db, U, "crm:222", "prj:119");
  assert.deepEqual(out, { moved: 1, merged: 0 });
  const log = db.all("SELECT action, old_value, new_value FROM audit_log WHERE entity='allocation'");
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { action: "reassign", old_value: "crm:222", new_value: "prj:119" });
});
