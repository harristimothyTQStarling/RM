"use strict";
/**
 * Non-billable projects are hidden from the app: they never appear in the
 * reference, their actuals are excluded, plan rows targeting them are filtered
 * out of every read, and nothing can be mapped onto them. The rows stay in the
 * tables — the filter is read-side and reversible.
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, fresh, fm, call } = require("./helpers");

process.env.EDITOR_UPNS = "tim@tqstarling.com";
const EDITOR = as("tim@tqstarling.com");

async function seed(db) {
  db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (1,'Alex Rivera','Senior TC','Delivery','employee',1)");
  db.run("INSERT INTO ref_project (id,name,client,billable,active) VALUES (101,'Northwind - IRM','Northwind Bank',1,1)");
  db.run("INSERT INTO ref_project (id,name,client,billable,active) VALUES (104,'Non-Billable Time','Internal',0,1)");
  db.run("INSERT INTO ref_actual (employee_id,project_id,month,hours,bill_rate,revenue) VALUES (1,101,'2026-01-01',150,185,27750)");
  db.run("INSERT INTO ref_actual (employee_id,project_id,month,hours,bill_rate,revenue) VALUES (1,104,'2026-01-01',20,0,0)");
  // plan rows on both projects (allocation, rate, proposed)
  for (const t of ["prj:101", "prj:104"]) {
    await call(db, "PUT", "/api/allocation", { resourceKey: "emp:1", targetKey: t, month: fm(1), hours: 40, version: 0 }, EDITOR);
    await call(db, "PUT", "/api/rate", { resourceKey: "emp:1", targetKey: t, rate: 150, version: 0 }, EDITOR);
  }
}

test("reference hides non-billable projects and their actuals", async () => {
  const db = fresh(); await seed(db);
  const r = (await call(db, "GET", "/api/reference", null, EDITOR)).body;
  assert.deepEqual(r.projects.map(p => p.id), [101], "project 104 is gone");
  assert.deepEqual(r.actuals.map(a => a.projectId), [101], "its 20h of actuals are gone too");
});

test("plan reads filter rows that target a non-billable project (data stays in the table)", async () => {
  const db = fresh(); await seed(db);
  const p = (await call(db, "GET", "/api/plan", null, EDITOR)).body;
  assert.deepEqual(p.allocations.map(a => a.targetKey), ["prj:101"], "allocation on 104 filtered");
  assert.deepEqual(p.rates.map(x => x.targetKey), ["prj:101"], "rate on 104 filtered");
  const raw = await db.all("SELECT target_key FROM allocation ORDER BY target_key");
  assert.equal(raw.length, 2, "the underlying rows are NOT deleted");
});

test("closed opportunities cannot be mapped onto a non-billable project", async () => {
  const db = fresh(); await seed(db);
  db.run("INSERT INTO ref_opportunity (id,name,client,stage,active,needs_project) VALUES (201,'Adventure Works - SPM','Adventure Works','Won',1,1)");
  const r = await call(db, "POST", "/api/opportunity/map", { oppId: 201, projectId: 104 }, EDITOR);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /billable/);
  assert.equal((await call(db, "POST", "/api/opportunity/map", { oppId: 201, projectId: 101 }, EDITOR)).status, 200, "billable projects still map fine");
});
