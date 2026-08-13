"use strict";
/**
 * Costing role — the contract:
 *   - /api/cost and /api/cost/sync are COSTING_UPNS-only (default tim@), fail
 *     closed, and never leak payroll data to editors or viewers
 *   - Gusto payroll shaping: fully loaded cost = gross + employer taxes +
 *     employer benefit contributions; contractors = wage + bonus
 *   - closed months are 'actual'; current..Dec get the trailing-average
 *     'standard' rate; unmatched Gusto names are reported, not dropped
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, ANON, fresh, call } = require("./helpers");
const { buildCostRows, employerCostOf, addPayroll, addContractorPayments } = require("../src/gusto");

process.env.EDITOR_UPNS = "tim@tqstarling.com,melissa@tqstarling.com";
delete process.env.COSTING_UPNS;              // default: tim only
const TIM = as("tim@tqstarling.com");
const MELISSA = as("melissa@tqstarling.com"); // editor but NOT costing
const JANE = as("jane@tqstarling.com");       // viewer

test("role gating: only the costing allowlist can see cost data", async () => {
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

  assert.equal((await call(db, "POST", "/api/cost/sync", {}, MELISSA)).status, 403);
  assert.equal((await call(db, "POST", "/api/cost/sync", {}, TIM)).status, 503, "no Gusto config -> 503, not a crash");
});

test("me/bootstrap expose canCost to exactly the costing role", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/me", null, TIM)).body.canCost, true);
  assert.equal((await call(db, "GET", "/api/me", null, MELISSA)).body.canCost, false);
});

test("employer cost = gross + employer-side taxes + company benefit contributions", () => {
  // Shape copied from a real Gusto payroll response.
  const comp = {
    gross_pay: 5769.23,
    taxes: [
      { name: "Federal Income Tax", employer: false, amount: 1177.53 },
      { name: "Social Security", employer: false, amount: 356.52 },
      { name: "Social Security", employer: true, amount: 356.52 },
      { name: "Medicare", employer: true, amount: 83.37 },
    ],
    benefits: [{ name: "Medical", company_contribution: "402.10", employee_deduction: "120.00" }],
  };
  assert.equal(Math.round(employerCostOf(comp) * 100) / 100, 5769.23 + 356.52 + 83.37 + 402.10);
});

test("payrolls land in the month of the check date; bonus off-cycles add on", () => {
  const acc = new Map();
  const emp = (gross) => ({ employee_uuid: "u1", first_name: "Timothy", preferred_first_name: "Tim", last_name: "Harris", gross_pay: gross, taxes: [], benefits: [] });
  addPayroll(acc, { check_date: "2026-06-18", employee_compensations: [emp(5000)] });
  addPayroll(acc, { check_date: "2026-06-26", employee_compensations: [emp(900)] });   // bonus run
  addPayroll(acc, { check_date: "2026-07-03", employee_compensations: [emp(5000)] });
  const p = acc.get("e:u1");
  assert.equal(p.byMonth.get("2026-06-01"), 5900);
  assert.equal(p.byMonth.get("2026-07-01"), 5000);
});

test("cost rows: actuals for closed months, trailing-average standard rate forward, names matched incl. preferred", () => {
  const acc = new Map([
    ["e:u1", { names: ["Timothy Harris", "Tim Harris"], byMonth: new Map([
      ["2026-04-01", 10000], ["2026-05-01", 11000], ["2026-06-01", 12000], ["2026-07-01", 13000],
    ]) }],
    ["c:u2", { names: ["Riley Brooks"], byMonth: new Map([["2026-07-01", 8000]]) }],
    ["e:u3", { names: ["Nobody Known"], byMonth: new Map([["2026-07-01", 5000]]) }],
  ]);
  const people = [{ id: 1, name: "Tim Harris" }, { id: 6, name: "Riley Brooks" }];
  const { rows, unmatched, matched } = buildCostRows(acc, people, "2026-08-01");

  assert.equal(matched, 2);
  assert.deepEqual(unmatched, ["Nobody Known"], "unknown Gusto names are surfaced");

  const tim = rows.filter(r => r.employee_id === 1);
  assert.deepEqual(tim.filter(r => r.kind === "actual").map(r => [r.month, r.cost]),
    [["2026-04-01", 10000], ["2026-05-01", 11000], ["2026-06-01", 12000], ["2026-07-01", 13000]]);
  const std = tim.filter(r => r.kind === "standard");
  assert.deepEqual(std.map(r => r.month), ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"]);
  assert.ok(std.every(r => r.cost === 12000), "standard = avg of last 3 closed months (11k,12k,13k)");

  const riley = rows.filter(r => r.employee_id === 6);
  assert.deepEqual(riley.find(r => r.month === "2026-07-01"), { employee_id: 6, month: "2026-07-01", cost: 8000, kind: "actual" });
  assert.ok(riley.filter(r => r.kind === "standard").every(r => r.cost === 8000), "single closed month becomes the forward rate");
});

test("contractor payments: wage + bonus count, reimbursements do not", () => {
  const acc = new Map();
  const contractors = new Map([["cu1", { first_name: "Riley", last_name: "Brooks" }]]);
  addContractorPayments(acc, [
    { contractor_uuid: "cu1", payments: [
      { date: "2026-07-06", wage: "1485.0", bonus: "100.0", reimbursement: "250.0" },
      { date: "2026-07-27", wage: "3160.0", bonus: "0.0", reimbursement: "0.0" },
    ] },
  ], contractors);
  assert.equal(acc.get("c:cu1").byMonth.get("2026-07-01"), 1485 + 100 + 3160);
  assert.deepEqual(acc.get("c:cu1").names, ["Riley Brooks"]);
});
