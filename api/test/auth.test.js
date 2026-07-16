"use strict";
/**
 * Single-editor access model.
 *   node --test api/test/auth.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const { open } = require("../src/db");
const { handle } = require("../src/handlers");

const principal = (upn, roles = ["authenticated"]) => ({
  "x-ms-client-principal": Buffer.from(JSON.stringify({ userId: upn, userDetails: upn, userRoles: roles })).toString("base64"),
});

const TIM  = principal("tim@tqstarling.com");                              // allowlisted, no role
const JANE = principal("jane@tqstarling.com");                             // signed in, nothing else
const SAM  = principal("sam@tqstarling.com", ["authenticated", "Planner.Editor"]);  // role, not allowlisted

const fresh = () => open({ driver: "sqlite", file: ":memory:" });
const call = (db, method, path, body, headers) => handle(db, { method, path, body, headers, query: {} });
const write = (db, headers) => call(db, "PUT", "/api/allocation",
  { resourceKey: "emp:110", targetKey: "prj:119", month: "2026-08", hours: 100, version: 0 }, headers);

test.beforeEach(() => { process.env.EDITOR_UPNS = "tim@tqstarling.com"; });
test.after(() => { delete process.env.EDITOR_UPNS; });

test("the allowlisted user can write", async () => {
  const db = fresh();
  assert.equal((await write(db, TIM)).status, 200);
});

test("everyone else in the tenant is read-only", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/plan", {}, JANE)).status, 200, "colleagues can see the plan");
  assert.equal((await write(db, JANE)).status, 403, "but cannot change it");
});

test("/api/me tells the UI whether to render editing at all", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/me", {}, TIM)).body.canEdit, true);
  assert.equal((await call(db, "GET", "/api/me", {}, JANE)).body.canEdit, false);
});

test("allowlist is case-insensitive (Entra casing varies)", async () => {
  const db = fresh();
  assert.equal((await write(db, principal("Tim@TQStarling.com"))).status, 200);
});

test("App Role still grants write — the growth path works without redeploy", async () => {
  const db = fresh();
  assert.equal((await write(db, SAM)).status, 200);
});

test("empty allowlist denies rather than falling open", async () => {
  process.env.EDITOR_UPNS = "";
  const db = fresh();
  assert.equal((await write(db, TIM)).status, 403, "no allowlist must not mean 'everyone'");
  assert.equal((await write(db, SAM)).status, 200, "the role path still works");
});

test("allowlist tolerates spaces and blanks", async () => {
  process.env.EDITOR_UPNS = " tim@tqstarling.com , , ";
  const db = fresh();
  assert.equal((await write(db, TIM)).status, 200);
  assert.equal((await write(db, JANE)).status, 403, "a stray comma must not admit anyone");
});

test("a substring of an allowlisted address is not admitted", async () => {
  process.env.EDITOR_UPNS = "tim@tqstarling.com";
  const db = fresh();
  assert.equal((await write(db, principal("tim@tqstarling.com.attacker.io"))).status, 403);
  assert.equal((await write(db, principal("evil-tim@tqstarling.com"))).status, 403);
});

test("anonymous cannot read or write", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/plan", {}, {})).status, 401);
  assert.equal((await write(db, {})).status, 401);
});

test("DEV_USER impersonation cannot work in Azure", async () => {
  const db = fresh();
  process.env.DEV_USER = "attacker@example.com";
  process.env.DEV_ROLES = "Planner.Editor";
  process.env.WEBSITE_INSTANCE_ID = "pretend-azure";
  try {
    assert.equal((await write(db, {})).status, 401, "dev impersonation must be inert in Azure");
  } finally {
    delete process.env.DEV_USER; delete process.env.DEV_ROLES; delete process.env.WEBSITE_INSTANCE_ID;
  }
});
