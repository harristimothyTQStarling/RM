"use strict";
/**
 * Runs the real handlers against a real (in-memory) database.
 *   node --test api/test/
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, fresh, fm, call: rawCall } = require("./helpers");

// Two named editors + one colleague who may only view.
process.env.EDITOR_UPNS = "tim@tqstarling.com,sam@tqstarling.com";

const EDITOR = as("tim@tqstarling.com");
const OTHER  = as("sam@tqstarling.com");   // the second editor
const VIEWER = as("jane@tqstarling.com");  // signed in, not an editor

const call = (db, method, path, body, headers = EDITOR, query = {}) => rawCall(db, method, path, body, headers, query);
const putAlloc = (db, hours, version, headers = EDITOR) =>
  call(db, "PUT", "/api/allocation", { resourceKey: "emp:110", targetKey: "prj:119", month: fm(0), hours, version }, headers);

test("write then read round-trips", async () => {
  const db = fresh();
  const r = await putAlloc(db, 100, 0);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  const plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.allocations.length, 1);
  assert.deepEqual(
    { rk: plan.body.allocations[0].resourceKey, m: plan.body.allocations[0].month, h: plan.body.allocations[0].hours },
    { rk: "emp:110", m: fm(0), h: 100 }
  );
  assert.equal(plan.body.allocations[0].updatedBy, "tim@tqstarling.com", "audit: who wrote it");
});

test("CRM opportunities and TBH resources are storable (no id collision)", async () => {
  const db = fresh();
  await call(db, "PUT", "/api/tbh", { tbhKey: "resource-3", name: "RESOURCE 3", role: "Business Process Consultant", dept: "", start: "2026-07", cap: 160 });
  await call(db, "PUT", "/api/allocation", { resourceKey: "tbh:resource-3", targetKey: "crm:222", month: fm(1), hours: 80, version: 0 });
  const plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.tbh[0].dept, "", "TBH with no department persists");
  assert.equal(plan.body.allocations[0].targetKey, "crm:222", "allocation against a CRM opportunity");
});

/* ---- closed months are actuals territory ---- */

test("writes to a past month are rejected (400), even from an editor", async () => {
  const db = fresh();
  const r = await call(db, "PUT", "/api/allocation",
    { resourceKey: "emp:110", targetKey: "prj:119", month: fm(-1), hours: 100, version: 0 });
  assert.equal(r.status, 400, "last month is closed");
  assert.match(r.body.error, /closed/, "the error explains why");
  assert.equal((await call(db, "GET", "/api/plan")).body.allocations.length, 0, "nothing was written");
});

test("a batch containing a past month fails atomically — nothing is applied", async () => {
  const db = fresh();
  const items = [
    { resourceKey: "emp:110", targetKey: "prj:119", month: fm(1), hours: 50, version: 0 },
    { resourceKey: "emp:110", targetKey: "prj:119", month: fm(-2), hours: 50, version: 0 },
  ];
  const r = await call(db, "POST", "/api/allocations", { items });
  assert.equal(r.status, 400);
  assert.equal((await call(db, "GET", "/api/plan")).body.allocations.length, 0, "the valid future row rolled back too");
});

/* ---- the reason this app exists: two people, one cell ---- */

test("second writer is REJECTED, not silently clobbered", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);                       // Tim writes 100 (v1)
  const jane = await putAlloc(db, 120, 1, OTHER);   // Sam edits from v1 -> 120 (v2)
  assert.equal(jane.status, 200);
  assert.equal(jane.body.version, 2);

  const stale = await putAlloc(db, 999, 1);         // Tim still holds v1
  assert.equal(stale.status, 409, "stale write must conflict");
  assert.equal(stale.body.current.hours, 120, "409 reports the value it lost to");
  assert.equal(stale.body.current.version, 2);

  const plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.allocations[0].hours, 120, "Sam's edit survives");
});

test("retrying with the fresh version succeeds", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);
  await putAlloc(db, 120, 1, OTHER);
  const ok = await putAlloc(db, 150, 2);            // Tim re-reads, then writes
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, 3);
});

test("hours=0 deletes; empty and zero are the same cell", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);
  const del = await putAlloc(db, 0, 1);
  assert.ok(del.body.deleted);
  assert.equal((await call(db, "GET", "/api/plan")).body.allocations.length, 0);
});

test("insert claiming a version conflicts when the row already exists", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);
  const dupe = await putAlloc(db, 50, 0);           // another client also thinks it's empty
  assert.equal(dupe.status, 409);
});

/* ---- map a closed CRM opportunity to a project (manual override) ---- */

test("editor can map a closed CRM opp's forecast onto a project; viewer cannot", async () => {
  const db = fresh();
  db.run("INSERT INTO ref_project (id,name,client,billable,active) VALUES (119,'Bain Phase 2B','Bain',1,1)");
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:110", targetKey: "crm:222", month: fm(1), hours: 80, version: 0 });

  const forbidden = await call(db, "POST", "/api/opportunity/map", { oppId: 222, projectId: 119 }, VIEWER);
  assert.equal(forbidden.status, 403, "viewer must not map");

  const bad = await call(db, "POST", "/api/opportunity/map", { oppId: 222, projectId: 99999 });
  assert.equal(bad.status, 400, "unknown project rejected");

  const ok = await call(db, "POST", "/api/opportunity/map", { oppId: 222, projectId: 119 });
  assert.equal(ok.status, 200);
  const plan = await call(db, "GET", "/api/plan");
  const rows = plan.body.allocations.filter((a) => a.resourceKey === "emp:110");
  assert.deepEqual(rows.map((a) => a.targetKey), ["prj:119"], "forecast now lives on the project");
});

/* ---- permissions ---- */

test("viewer can read but not write", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/plan", {}, VIEWER)).status, 200);
  const w = await putAlloc(db, 100, 0, VIEWER);
  assert.equal(w.status, 403, "viewer must not write");
});

test("anonymous is rejected", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/plan", {}, {})).status, 401);
});

test("/api/me reports role", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/me", {}, EDITOR)).body.canEdit, true);
  assert.equal((await call(db, "GET", "/api/me", {}, VIEWER)).body.canEdit, false);
});

/* ---- batch (bulk allocate / import) ---- */

test("batch write is atomic — a conflict rolls the whole import back", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);                       // existing cell at v1
  const items = [
    { resourceKey: "emp:36",  targetKey: "prj:46",  month: fm(0), hours: 168, version: 0 },
    { resourceKey: "emp:110", targetKey: "prj:119", month: fm(0), hours: 50,  version: 0 }, // stale: row is v1
  ];
  const r = await call(db, "POST", "/api/allocations", { items });
  assert.equal(r.status, 409);
  const plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.allocations.length, 1, "partial import must not persist");
  assert.equal(plan.body.allocations[0].hours, 100, "original value untouched");
});

test("bulk allocate spreads across months", async () => {
  const db = fresh();
  const items = [fm(0), fm(1), fm(2)].map(month => ({ resourceKey: "emp:110", targetKey: "prj:96", month, hours: 100, version: 0 }));
  const r = await call(db, "POST", "/api/allocations", { items });
  assert.equal(r.status, 200);
  assert.equal((await call(db, "GET", "/api/plan")).body.allocations.length, 3);
});

/* ---- shared import mappings ---- */

test("import overrides are shared, and clearable so auto-match re-runs", async () => {
  const db = fresh();
  await call(db, "PUT", "/api/importmap", { kind: "project", sourceName: "Advocate Health - BCM Implementation", targetKey: "crm:222" });
  let plan = await call(db, "GET", "/api/plan", {}, VIEWER);   // a DIFFERENT user sees it
  assert.equal(plan.body.importMap.project["Advocate Health - BCM Implementation"], "crm:222");
  await call(db, "PUT", "/api/importmap", { kind: "project", sourceName: "Advocate Health - BCM Implementation", targetKey: null });
  plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.importMap.project["Advocate Health - BCM Implementation"], undefined, "cleared → matcher re-runs");
});

/* ---- TBH cleanup ---- */

test("deleting a TBH removes its allocations (no orphan demand)", async () => {
  const db = fresh();
  await call(db, "PUT", "/api/tbh", { tbhKey: "r3", name: "TBH r3" });
  await call(db, "PUT", "/api/allocation", { resourceKey: "tbh:r3", targetKey: "prj:119", month: fm(0), hours: 40, version: 0 });
  await call(db, "DELETE", "/api/tbh/r3");
  const plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.tbh.length, 0);
  assert.equal(plan.body.allocations.length, 0, "orphaned demand must not linger");
});

/* ---- scenarios ---- */

test("scenarios are isolated", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:110", targetKey: "prj:119", month: fm(0), hours: 300, version: 0 }, EDITOR, { scenario: "win-medtronic" });
  assert.equal((await call(db, "GET", "/api/plan", {}, EDITOR, { scenario: "baseline" })).body.allocations[0].hours, 100);
  assert.equal((await call(db, "GET", "/api/plan", {}, EDITOR, { scenario: "win-medtronic" })).body.allocations[0].hours, 300);
});

/* ---- audit ---- */

test("audit log records who changed what, and the previous value", async () => {
  const db = fresh();
  await putAlloc(db, 100, 0);
  await putAlloc(db, 120, 1, OTHER);
  const a = (await call(db, "GET", "/api/audit")).body.entries;
  assert.equal(a.length, 2);
  const upd = a.find(e => e.action === "update");
  assert.equal(upd.actor, "sam@tqstarling.com");
  assert.equal(upd.old_value, "100");
  assert.equal(upd.new_value, "120");
});

/* ----------------------------------------------------------------- bill rate -- */
const putRate = (db, rate, version, headers = EDITOR) =>
  call(db, "PUT", "/api/rate", { resourceKey: "emp:110", targetKey: "prj:119", rate, version }, headers);

test("bill rate round-trips per resource x target and shows in the plan", async () => {
  const db = fresh();
  const r = await putRate(db, 185, 0);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  // the same resource carries a different rate on a different target
  await call(db, "PUT", "/api/rate", { resourceKey: "emp:110", targetKey: "prj:120", rate: 95, version: 0 });
  const plan = await call(db, "GET", "/api/plan");
  const rates = Object.fromEntries(plan.body.rates.map(x => [x.targetKey, x.rate]));
  assert.deepEqual(rates, { "prj:119": 185, "prj:120": 95 });
});

test("rate: second writer is rejected with the winning value; rate 0 deletes", async () => {
  const db = fresh();
  await putRate(db, 185, 0);
  const stale = await putRate(db, 200, 0, OTHER);   // OTHER wrote against a stale version
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.rate, 185);
  const del = await putRate(db, 0, 1);
  assert.ok(del.body.deleted);
  assert.equal((await call(db, "GET", "/api/plan")).body.rates.length, 0);
});

test("viewer cannot set a rate", async () => {
  const db = fresh();
  const r = await putRate(db, 100, 0, VIEWER);
  assert.equal(r.status, 403);
});
