"use strict";
/**
 * Costing role — the contract:
 *   - /api/cost and /api/cost/rate are COSTING_UPNS-only (default tim@),
 *     fail closed, and never leak payroll-derived data to editors or viewers
 *   - costs are a per-person RATE CARD entered in-app: bi-weekly, monthly and
 *     hourly. PUT upserts a person's card; clearing all three deletes it.
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, ANON, fresh, call } = require("./helpers");

process.env.EDITOR_UPNS = "tim@tqstarling.com,amy@tqstarling.com";
delete process.env.COSTING_UPNS;              // default: tim, melissa, joe, peter
const TIM = as("tim@tqstarling.com");
const AMY = as("amy@tqstarling.com");         // editor but NOT costing
const JANE = as("jane@tqstarling.com");       // viewer

const put = (db, headers, card) => call(db, "PUT", "/api/cost/rate", card, headers);

test("role gating: only the costing allowlist can see or edit cost rates", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/cost", null, ANON)).status, 401);
  assert.equal((await call(db, "GET", "/api/cost", null, JANE)).status, 403, "viewers are refused");
  assert.equal((await call(db, "GET", "/api/cost", null, AMY)).status, 403, "editors without the role are refused");
  const ok = await call(db, "GET", "/api/cost", null, TIM);
  assert.equal(ok.status, 200, "tim@ is in the default costing role");
  assert.deepEqual(ok.body.rates, []);

  // Default allowlist covers the margin-tab group: tim, melissa, joe, peter.
  for (const upn of ["melissa@tqstarling.com", "joe@tqstarling.com", "peter@tqstarling.com"])
    assert.equal((await call(db, "GET", "/api/cost", null, as(upn))).status, 200, `${upn} has the costing role by default`);

  process.env.COSTING_UPNS = "";              // fail closed
  assert.equal((await call(db, "GET", "/api/cost", null, TIM)).status, 403, "empty allowlist denies everyone");
  process.env.COSTING_UPNS = "tim@tqstarling.com";  // explicit list overrides the default
  assert.equal((await call(db, "GET", "/api/cost", null, as("melissa@tqstarling.com"))).status, 403, "explicit COSTING_UPNS wins over the default");
  delete process.env.COSTING_UPNS;

  assert.equal((await put(db, AMY, { employeeId: 1, monthly: 20000 })).status, 403, "editors cannot write rates");
  assert.equal((await put(db, JANE, { employeeId: 1, monthly: 20000 })).status, 403);
});

test("me/bootstrap expose canCost to exactly the costing role", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/me", null, TIM)).body.canCost, true);
  assert.equal((await call(db, "GET", "/api/me", null, AMY)).body.canCost, false);
});

test("rate card round-trips: upsert, partial fields, attribution", async () => {
  const db = fresh();
  assert.equal((await put(db, TIM, { employeeId: 1, biweekly: 9500, monthly: null, hourly: null })).status, 200);
  assert.equal((await put(db, TIM, { employeeId: 2, hourly: 120.505 })).status, 200);
  // Salaried pattern: annual salary + hourly at the 2040h basis.
  assert.equal((await put(db, TIM, { employeeId: 4, annual: 180000, hourly: 88.24 })).status, 200);

  let got = (await call(db, "GET", "/api/cost", null, TIM)).body.rates;
  assert.deepEqual(got.map(r => [r.employeeId, r.annual, r.biweekly, r.monthly, r.hourly]).sort(),
    [[1, null, 9500, null, null], [2, null, null, null, 120.51], [4, 180000, null, null, 88.24]],
    "values round-trip, cents rounded");
  assert.ok(got.every(r => r.updatedBy === "tim@tqstarling.com"), "attribution recorded on the card");

  // Upsert replaces the whole card for that person (a cleared field goes null).
  assert.equal((await put(db, TIM, { employeeId: 1, monthly: 21000 })).status, 200);
  got = (await call(db, "GET", "/api/cost", null, TIM)).body.rates;
  const p1 = got.find(r => r.employeeId === 1);
  assert.deepEqual([p1.annual, p1.biweekly, p1.monthly, p1.hourly], [null, null, 21000, null]);
});

test("clearing every field deletes the person's card", async () => {
  const db = fresh();
  await put(db, TIM, { employeeId: 3, monthly: 18000 });
  const r = await put(db, TIM, { employeeId: 3, biweekly: "", monthly: "", hourly: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, true);
  assert.deepEqual((await call(db, "GET", "/api/cost", null, TIM)).body.rates, []);
});

test("validation: bad ids and negative or non-numeric costs are rejected", async () => {
  const db = fresh();
  assert.equal((await put(db, TIM, { monthly: 100 })).status, 400, "employeeId required");
  assert.equal((await put(db, TIM, { employeeId: "x", monthly: 100 })).status, 400);
  assert.equal((await put(db, TIM, { employeeId: 1, monthly: -5 })).status, 400, "negative refused");
  assert.equal((await put(db, TIM, { employeeId: 1, hourly: "abc" })).status, 400);
  assert.deepEqual((await call(db, "GET", "/api/cost", null, TIM)).body.rates, [], "nothing was written");
});

test("cost edits never reach the audit feed (visible to every signed-in user)", async () => {
  const db = fresh();
  await put(db, TIM, { employeeId: 1, monthly: 21000 });
  const audit = await call(db, "GET", "/api/audit", null, JANE);
  assert.equal(audit.status, 200);
  const leaked = JSON.stringify(audit.body).includes("21000");
  assert.equal(leaked, false, "payroll figures must not appear in the audit log");
});

test("the retired import endpoint is gone", async () => {
  const db = fresh();
  const r = await call(db, "POST", "/api/cost/import", { rows: [] }, TIM);
  assert.equal(r.status, 404, "per-month import was replaced by the rate card");
});
