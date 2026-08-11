"use strict";
/**
 * Odoo transformation logic — the parts that need no live connection.
 * The live field contract is proven separately by scripts/verify-odoo.js.
 */
const test = require("node:test");
const assert = require("node:assert");
const { shapePeople, m2oName, m2oId, Odoo, syncAll, readActuals } = require("../src/odoo");
const { open } = require("../src/db");

/* readActuals derives the ACTUAL bill rate per person×project×month from the
   timesheet's linked sale.order.line: rate = billable revenue / billable hours.
   Non-billable hours (no so_line) count in hours but not in the rate. */
test("readActuals computes realized bill rates from the linked SO lines", async () => {
  const fakeOdoo = {
    searchRead: async (model) => {
      if (model === "account.analytic.line") return [
        { employee_id: [110, "Ken"], project_id: [119, "Bain"], date: "2026-05-10", unit_amount: 100, so_line: [7, "S00043 Bain"] },
        { employee_id: [110, "Ken"], project_id: [119, "Bain"], date: "2026-05-20", unit_amount: 20, so_line: false },   // non-billable
        { employee_id: [110, "Ken"], project_id: [119, "Bain"], date: "2026-06-02", unit_amount: 10, so_line: [8, "S00099"] },
      ];
      if (model === "sale.order.line") return [ { id: 7, price_unit: 145 }, { id: 8, price_unit: 200 } ];
      return [];
    },
  };
  const out = await readActuals(fakeOdoo, "2026-01-01", "2026-12-31");
  const may = out.find((a) => a.month === "2026-05-01");
  assert.equal(may.hours, 120, "all hours counted, billable or not");
  assert.equal(may.revenue, 14500, "revenue only from the 100 billable hours × $145");
  assert.equal(may.bill_rate, 145, "rate = revenue / billable hours (not total hours)");
  const jun = out.find((a) => a.month === "2026-06-01");
  assert.deepEqual({ h: jun.hours, r: jun.bill_rate }, { h: 10, r: 200 }, "months keep their own rate");
});

test("many2one fields decode to id + display name", () => {
  assert.equal(m2oName([12, "Delivery"]), "Delivery");
  assert.equal(m2oId([12, "Delivery"]), 12);
  assert.equal(m2oName(false), "", "unset many2one comes back as false, not null");
  assert.equal(m2oId(false), null);
});

test("people are classified by the HR record's Employee Type field", () => {
  const out = shapePeople([
    { id: 1, name: "Ken Sousa", role: "Engagement Manager", dept: "Delivery", employeeType: "employee" },
    { id: 2, name: "Arvin Visco", role: "Technical Consultant", dept: "Delivery", employeeType: "contractor" },
    { id: 3, name: "Sara Diaz", role: "Developer", dept: "Delivery", employeeType: "freelance" },
    // employee_type wins over the historical Contractor-department rule
    { id: 4, name: "Lee Ford", role: "QA", dept: "Contractor", employeeType: "employee" },
  ]);
  assert.deepEqual(out.map((p) => [p.id, p.type]),
    [[1, "employee"], [2, "contractor"], [3, "contractor"], [4, "employee"]]);
});

test("hr.version layout: employee_type is read from the version record", async () => {
  // TQStarling's Odoo keeps job_title, department AND employee_type on
  // hr.version; hr.employee has none of them. readPeople must still classify
  // from the payroll Employee Type, not the department.
  const { readPeople } = require("../src/odoo");
  const fakeOdoo = {
    hasFields: async (model, names) => Object.fromEntries(names.map((n) => [n,
      model === "hr.version" ? true : n === "current_version_id"])),
    searchRead: async (model) => model === "hr.employee"
      ? [
          { id: 1, name: "Ken Sousa", current_version_id: [11, "v"] },
          { id: 2, name: "Arvin Visco", current_version_id: [12, "v"] },
        ]
      : [
          { id: 11, job_title: "Engagement Manager", department_id: [5, "Delivery"], employee_type: "employee" },
          { id: 12, job_title: "Technical Consultant", department_id: [5, "Delivery"], employee_type: "contractor" },
        ],
  };
  const out = await readPeople(fakeOdoo);
  assert.deepEqual(out.map((p) => [p.name, p.type]),
    [["Ken Sousa", "employee"], ["Arvin Visco", "contractor"]],
    "types come from hr.version employee_type even though both share the Delivery department");
});

test("without an employee_type field, classification falls back to the Contractor department", () => {
  const out = shapePeople([
    { id: 1, name: "Ken Sousa", role: "Engagement Manager", dept: "Delivery" },
    { id: 2, name: "Arvin Visco", role: "Technical Consultant", dept: "Contractor" },
  ]);
  assert.equal(out.find((p) => p.id === 1).type, "employee");
  assert.equal(out.find((p) => p.id === 2).type, "contractor");
});

test("non-delivery departments are excluded", () => {
  const out = shapePeople([
    { id: 1, name: "Ken Sousa", role: "Engagement Manager", dept: "Delivery" },
    { id: 2, name: "Tim Harris", role: "CEO", dept: "Operations" },
    { id: 3, name: "Tim Anderson", role: "Snr Client Director", dept: "Sales and Marketing" },
  ]);
  assert.deepEqual(out.map((p) => p.id), [1], "Operations and Sales are dropped");
});

test("people with no department are dropped, not shown blank", () => {
  const out = shapePeople([
    { id: 1, name: "Ken Sousa", role: "Engagement Manager", dept: "Delivery" },
    { id: 2, name: "Dan Cavanaugh", role: "", dept: "" },
  ]);
  assert.deepEqual(out.map((p) => p.id), [1]);
});

test("template and bot accounts are filtered out", () => {
  const out = shapePeople([
    { id: 1, name: "Template_Employee", role: "", dept: "Delivery" },
    { id: 2, name: "OdooBot", role: "", dept: "Delivery" },
    { id: 3, name: "Ken Sousa", role: "Engagement Manager", dept: "Delivery" },
  ]);
  assert.deepEqual(out.map((p) => p.id), [3]);
});

test("client URL is normalised (trailing slash and /en are stripped)", () => {
  // the URL you actually use in a browser is https://tq-starling.odoo.com/en
  const o = new Odoo({ url: "https://tq-starling.odoo.com/en", db: "d", user: "u", password: "p" });
  assert.equal(o.url, "https://tq-starling.odoo.com", "the /en language prefix would 404 the JSON-RPC endpoint");
  assert.equal(new Odoo({ url: "https://x.odoo.com/", db: "d", user: "u", password: "p" }).url, "https://x.odoo.com");
});

test("configured is false until every credential is present", () => {
  assert.equal(new Odoo({ url: "https://x", db: "d", user: "u" }).configured, false);
  assert.equal(new Odoo({ url: "https://x", db: "d", user: "u", password: "p" }).configured, true);
});

test("a missing config fails fast with a clear message rather than hanging", async () => {
  const o = new Odoo({ url: "", db: "", user: "", password: "" });
  await assert.rejects(() => o.login(), /must all be set/);
});

/* syncAll against a fake Odoo — verifies the sync writes ref_* and, crucially,
   scopes actuals to the synced roster + project list. */
test("syncAll caches reference data and scopes actuals to the roster", async () => {
  const FIX = {
    "hr.employee": [
      { id: 110, name: "Ken Sousa", job_title: "Engagement Manager", department_id: [1, "Delivery"] },
      { id: 2, name: "Tim Harris", job_title: "CEO", department_id: [9, "Operations"] },       // excluded dept
      { id: 47, name: "Arvin Visco", job_title: "Technical Consultant", department_id: [5, "Contractor"] },
    ],
    "project.project": [
      { id: 119, name: "Bain Phase 2B", partner_id: [1, "Bain & Company"] },
      { id: 999, name: "Template internal project", partner_id: false },                       // excluded template
    ],
    "crm.lead": [
      { id: 222, name: "Advocate Health", partner_id: [2, "Advocate Health"], stage_id: [3, "Negotiate"], probability: 50 },
      { id: 5, name: "Old", partner_id: false, stage_id: [9, "Won"], probability: 100 },        // excluded Won
    ],
    "account.analytic.line": [
      { employee_id: [110, "Ken"], project_id: [119, "Bain"], date: "2026-05-10", unit_amount: 10 }, // kept
      { employee_id: [2, "Tim"], project_id: [119, "Bain"], date: "2026-05-11", unit_amount: 5 },    // person not in roster
      { employee_id: [110, "Ken"], project_id: [999, "Tmpl"], date: "2026-05-12", unit_amount: 3 },  // project not listed
    ],
  };
  const DIRECT = new Set(["name", "active", "job_title", "department_id", "partner_id", "stage_id", "type", "employee_id", "project_id", "date", "unit_amount"]);
  const fakeOdoo = {
    login: async () => 1,
    hasFields: async (_m, names) => Object.fromEntries(names.map((n) => [n, DIRECT.has(n)])),
    searchRead: async (model) => FIX[model] || [],
  };

  const db = open({ driver: "sqlite", file: ":memory:" });
  const counts = await syncAll(db, fakeOdoo, { actualsFrom: "2026-01-01", actualsTo: "2026-07-01" });

  assert.equal(counts.ref_person, 2, "Operations person excluded from the roster");
  assert.equal(counts.ref_project, 1, "template project excluded");
  assert.equal(counts.ref_opportunity, 1, "Won opportunity excluded");
  assert.equal(counts.ref_actual, 1, "only the roster-person + listed-project actual is kept");

  const a = await db.all("SELECT employee_id, project_id, month, hours FROM ref_actual");
  assert.deepEqual(a, [{ employee_id: 110, project_id: 119, month: "2026-05-01", hours: 10 }]);
  const sync = await db.all("SELECT source FROM sync_state ORDER BY source");
  assert.deepEqual(sync.map((s) => s.source), ["ref_actual", "ref_opportunity", "ref_person", "ref_project"]);
});
