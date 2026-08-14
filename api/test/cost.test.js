"use strict";
/**
 * Costing role — the contract:
 *   - /api/cost and /api/cost/import are COSTING_UPNS-only (default tim@),
 *     fail closed, and never leak payroll-derived data to editors or viewers
 *   - import REPLACES the dataset; kind derives from the month (closed ->
 *     actual, current onward -> standard); fillForward projects each person's
 *     trailing 3-closed-month average across the remaining months
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, ANON, fresh, fm, call } = require("./helpers");

process.env.EDITOR_UPNS = "tim@tqstarling.com,melissa@tqstarling.com";
delete process.env.COSTING_UPNS;              // default: tim only
const TIM = as("tim@tqstarling.com");
const MELISSA = as("melissa@tqstarling.com"); // editor but NOT costing
const JANE = as("jane@tqstarling.com");       // viewer

test("role gating: only the costing allowlist can see or import cost data", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/cost", null, ANON)).status, 401);
  assert.equal((await call(db, "GET", "/api/cost", null, JANE)).status, 403, "viewers are refused");
  assert.equal((await call(db, "GET", "/api/cost", null, MELISSA)).status, 403, "editors without the role are refused");
  const ok = await call(db, "GET", "/api/cost", null, TIM);
  assert.equal(ok.status, 200, "tim@ is the default costing role");
  assert.deepEqual(ok.body.costs, []);

  process.env.COSTING_UPNS = "";              // fail closed
  assert.equal((await call(db, "GET", "/api/cost", null, TIM)).status, 403, "empty allowlist denies everyone");
  delete process.env.COSTING_UPNS;

  assert.equal((await call(db, "POST", "/api/cost/import", { rows: [{ employeeId: 1, month: fm(-1), cost: 100 }] }, MELISSA)).status, 403);
});

test("me/bootstrap expose canCost to exactly the costing role", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/me", null, TIM)).body.canCost, true);
  assert.equal((await call(db, "GET", "/api/me", null, MELISSA)).body.canCost, false);
});

test("import: kind derives from the month; fillForward projects the trailing average; dataset is replaced", async () => {
  const db = fresh();
  // Three closed months (avg of last 3 = (1000+1100+1200)/3 = 1100) + nothing forward.
  const rows = [
    { employeeId: 1, month: fm(-3), cost: 1000 },
    { employeeId: 1, month: fm(-2), cost: 1100 },
    { employeeId: 1, month: fm(-1), cost: 1200 },
  ];
  const r = await call(db, "POST", "/api/cost/import", { rows }, TIM);
  assert.equal(r.status, 200);
  assert.equal(r.body.provided, 3);
  assert.ok(r.body.projected >= 1, "current..December filled from the trailing average");

  const got = (await call(db, "GET", "/api/cost", null, TIM)).body;
  const actuals = got.costs.filter(c => c.kind === "actual");
  const standards = got.costs.filter(c => c.kind === "standard");
  assert.equal(actuals.length, 3, "closed months are actuals");
  assert.ok(standards.length >= 1 && standards.every(c => c.cost === 1100), "standard = avg of last 3 closed months");
  assert.equal(got.synced.by, "tim@tqstarling.com", "import attributed to the importer");

  // Re-import replaces everything.
  const r2 = await call(db, "POST", "/api/cost/import", { rows: [{ employeeId: 2, month: fm(-1), cost: 500 }], fillForward: false }, TIM);
  assert.equal(r2.status, 200);
  const got2 = (await call(db, "GET", "/api/cost", null, TIM)).body;
  assert.deepEqual(got2.costs.map(c => [c.employeeId, c.cost]), [[2, 500]], "old dataset fully replaced; fillForward=false adds nothing");
});

test("import: an explicit forward value wins over the projection; duplicates last-write-wins", async () => {
  const db = fresh();
  const rows = [
    { employeeId: 1, month: fm(-1), cost: 1000 },
    { employeeId: 1, month: fm(0), cost: 9999 },   // explicit current month
    { employeeId: 1, month: fm(-1), cost: 1200 },  // duplicate: last wins
  ];
  const r = await call(db, "POST", "/api/cost/import", { rows }, TIM);
  assert.equal(r.status, 200);
  const got = (await call(db, "GET", "/api/cost", null, TIM)).body;
  assert.equal(got.costs.find(c => c.month === fm(-1)).cost, 1200, "last duplicate wins");
  const cur = got.costs.find(c => c.month === fm(0));
  assert.deepEqual({ cost: cur.cost, kind: cur.kind }, { cost: 9999, kind: "standard" }, "explicit forward value kept");
  got.costs.filter(c => c.month > fm(0)).forEach(c => assert.equal(c.cost, 1200, "projection uses the closed-month average"));
});

test("import validation: bad rows rejected atomically", async () => {
  const db = fresh();
  assert.equal((await call(db, "POST", "/api/cost/import", {}, TIM)).status, 400);
  assert.equal((await call(db, "POST", "/api/cost/import", { rows: [] }, TIM)).status, 400);
  assert.equal((await call(db, "POST", "/api/cost/import", { rows: [{ employeeId: "x", month: fm(0), cost: 1 }] }, TIM)).status, 400);
  assert.equal((await call(db, "POST", "/api/cost/import", { rows: [{ employeeId: 1, month: "2026-1", cost: 1 }] }, TIM)).status, 400);
  assert.equal((await call(db, "POST", "/api/cost/import", { rows: [{ employeeId: 1, month: fm(0), cost: -5 }] }, TIM)).status, 400);
  assert.equal((await call(db, "GET", "/api/cost", null, TIM)).body.costs.length, 0, "nothing was written");
});
