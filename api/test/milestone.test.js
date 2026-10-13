"use strict";
/**
 * Milestone billing — the contract:
 *   - ref_milestone is a read-only Odoo snapshot; WHICH month a milestone's
 *     revenue lands in is app-side (milestone_month, editor-set)
 *   - billing type: sync-detected on projects, editor override on any target
 *   - getReference merges both so the UI gets billingType + placed milestones
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, fresh, fm, call } = require("./helpers");
const store = require("../src/store");

process.env.EDITOR_UPNS = "tim@tqstarling.com";
const TIM = as("tim@tqstarling.com");
const JANE = as("jane@tqstarling.com");

function seed(db) {
  db.run("INSERT INTO ref_project (id,name,client,billable,active,billing_type) VALUES (128,'Advocate Health - BCM','Advocate Health',1,1,'milestone')");
  db.run("INSERT INTO ref_project (id,name,client,billable,active,billing_type) VALUES (119,'Bain T&M','Bain',1,1,'tm')");
  db.run("INSERT INTO ref_opportunity (id,name,client,stage,active) VALUES (301,'Fixed Fee Deal','Acme','Negotiate',1)");
  db.run("INSERT INTO ref_milestone (id,project_id,name,amount,reached) VALUES (2,128,'Phase 2',46500,0)");
  db.run("INSERT INTO ref_milestone (id,project_id,name,amount,reached) VALUES (3,128,'Phase 3',27000,1)");
}

test("milestone month placement: set, move, clear; editors only; validated", async () => {
  const db = fresh(); seed(db);
  const mon = fm(1);

  assert.equal((await call(db, "PUT", "/api/milestone/month", { milestoneId: 2, month: mon }, JANE)).status, 403, "viewers cannot schedule");
  assert.equal((await call(db, "PUT", "/api/milestone/month", { milestoneId: 999, month: mon }, TIM)).status, 400, "unknown milestone rejected");
  assert.equal((await call(db, "PUT", "/api/milestone/month", { milestoneId: 2, month: "nope" }, TIM)).status, 400, "bad month rejected");

  const r = await call(db, "PUT", "/api/milestone/month", { milestoneId: 2, month: mon }, TIM);
  assert.deepEqual({ s: r.status, m: r.body.month }, { s: 200, m: mon });

  let ref = await store.getReference(db);
  assert.equal(ref.milestones.find(m => m.id === 2).month, mon, "placement reaches the UI");
  assert.equal(ref.milestones.find(m => m.id === 3).month, null, "unscheduled milestone has no month");
  assert.deepEqual(ref.milestones.map(m => [m.id, m.amount, m.reached]), [[2, 46500, false], [3, 27000, true]]);

  const mon2 = fm(3);
  await call(db, "PUT", "/api/milestone/month", { milestoneId: 2, month: mon2 }, TIM);
  await call(db, "PUT", "/api/milestone/month", { milestoneId: 3, month: null }, TIM);   // clearing the unset one is a no-op
  ref = await store.getReference(db);
  assert.equal(ref.milestones.find(m => m.id === 2).month, mon2, "moved");
  const log = await db.all("SELECT action, old_value, new_value FROM audit_log WHERE entity='milestone'");
  assert.deepEqual(log.map(l => l.action), ["schedule", "schedule"], "placements audited");
});

test("billing type: sync detection serves projects, override forces any target", async () => {
  const db = fresh(); seed(db);
  let ref = await store.getReference(db);
  assert.equal(ref.projects.find(p => p.id === 128).billingType, "milestone", "sync-detected");
  assert.equal(ref.projects.find(p => p.id === 119).billingType, "tm");
  assert.equal(ref.opportunities.find(o => o.id === 301).billingType, "tm", "opps default to T&M");

  assert.equal((await call(db, "PUT", "/api/billing-type", { targetKey: "crm:301", btype: "milestone" }, JANE)).status, 403);
  assert.equal((await call(db, "PUT", "/api/billing-type", { targetKey: "bogus", btype: "milestone" }, TIM)).status, 400);
  assert.equal((await call(db, "PUT", "/api/billing-type", { targetKey: "crm:301", btype: "fixed" }, TIM)).status, 400);

  assert.equal((await call(db, "PUT", "/api/billing-type", { targetKey: "crm:301", btype: "milestone" }, TIM)).status, 200);
  assert.equal((await call(db, "PUT", "/api/billing-type", { targetKey: "prj:128", btype: "tm" }, TIM)).status, 200, "override can force T&M over detection");
  ref = await store.getReference(db);
  assert.equal(ref.opportunities.find(o => o.id === 301).billingType, "milestone");
  assert.equal(ref.projects.find(p => p.id === 128).billingType, "tm", "override wins");

  assert.equal((await call(db, "PUT", "/api/billing-type", { targetKey: "prj:128", btype: null }, TIM)).status, 200, "null returns to auto");
  ref = await store.getReference(db);
  assert.equal(ref.projects.find(p => p.id === 128).billingType, "milestone", "back to sync detection");
});

test("a billing override moves with the forecast when a CRM opp converts", async () => {
  const db = fresh(); seed(db);
  db.run("INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline','emp:1','crm:301',?,40,'x','2026-01-01',1)", [`${fm(1)}-01`]);
  await call(db, "PUT", "/api/billing-type", { targetKey: "crm:301", btype: "milestone" }, TIM);

  await store.mapOpportunityToProject(db, { upn: "tim@tqstarling.com" }, 301, 119);
  const ref = await store.getReference(db);
  assert.equal(ref.projects.find(p => p.id === 119).billingType, "milestone", "tag travelled crm:301 -> prj:119");
  assert.equal((await db.all("SELECT 1 FROM billing_override WHERE target_key='crm:301'")).length, 0, "nothing stranded");
});
