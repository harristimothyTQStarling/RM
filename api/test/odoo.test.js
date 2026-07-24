"use strict";
/**
 * Odoo transformation logic — the parts that need no live connection.
 * The live field contract is proven separately by scripts/verify-odoo.js.
 */
const test = require("node:test");
const assert = require("node:assert");
const { shapePeople, m2oName, m2oId, Odoo } = require("../src/odoo");

test("many2one fields decode to id + display name", () => {
  assert.equal(m2oName([12, "Delivery"]), "Delivery");
  assert.equal(m2oId([12, "Delivery"]), 12);
  assert.equal(m2oName(false), "", "unset many2one comes back as false, not null");
  assert.equal(m2oId(false), null);
});

test("people are classified employee vs contractor by department", () => {
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
