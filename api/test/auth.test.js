"use strict";
/**
 * Access model: a few named editors, everyone else in the tenant read-only.
 *   node --test "test/*.test.js"
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, ANON, fresh, call } = require("./helpers");
const oidc = require("../src/oidc");

const TIM  = as("tim@tqstarling.com");     // allowlisted editor
const SAM  = as("sam@tqstarling.com");     // allowlisted editor
const JANE = as("jane@tqstarling.com");    // signed in, view only

const write = (db, headers) => call(db, "PUT", "/api/allocation",
  { resourceKey: "emp:110", targetKey: "prj:119", month: "2026-08", hours: 100, version: 0 }, headers);

test.beforeEach(() => { process.env.EDITOR_UPNS = "tim@tqstarling.com, sam@tqstarling.com"; });
test.after(() => { delete process.env.EDITOR_UPNS; });

test("named editors can write", async () => {
  const db = fresh();
  assert.equal((await write(db, TIM)).status, 200);
  const db2 = fresh();
  assert.equal((await write(db2, SAM)).status, 200, "second named editor also writes");
});

test("everyone else who signs in is read-only", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/plan", {}, JANE)).status, 200, "colleagues can view");
  assert.equal((await write(db, JANE)).status, 403, "but cannot change the plan");
});

test("/api/me tells the UI whether to render editing controls", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/me", {}, TIM)).body.canEdit, true);
  assert.equal((await call(db, "GET", "/api/me", {}, JANE)).body.canEdit, false);
});

test("allowlist is case-insensitive and tolerates spacing", async () => {
  const db = fresh();
  assert.equal((await write(db, as("Tim@TQStarling.com"))).status, 200);
});

test("empty allowlist denies rather than falling open", async () => {
  process.env.EDITOR_UPNS = "";
  const db = fresh();
  assert.equal((await write(db, TIM)).status, 403, "no allowlist must never mean 'everyone'");
});

test("a lookalike address is not admitted", async () => {
  const db = fresh();
  assert.equal((await write(db, as("evil-tim@tqstarling.com"))).status, 403);
  assert.equal((await write(db, as("tim@tqstarling.com.attacker.io"))).status, 403);
});

test("anonymous cannot read or write", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/plan", {}, ANON)).status, 401);
  assert.equal((await write(db, ANON)).status, 401);
});

/* ---- session cookie integrity: the thing standing between the plan and the internet ---- */

test("a tampered session cookie is rejected", async () => {
  const db = fresh();
  const good = as("tim@tqstarling.com").cookie;
  // flip the payload to claim a different identity, keep the original signature
  const [name, value] = good.split("=");
  const raw = decodeURIComponent(value);
  const [, mac] = raw.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ upn: "attacker@evil.com", exp: Date.now() + 3600e3 })).toString("base64url");
  const forged = { cookie: `${name}=${encodeURIComponent(forgedBody + "." + mac)}` };
  assert.equal((await call(db, "GET", "/api/plan", {}, forged)).status, 401, "signature must not verify");
});

test("a cookie signed with the wrong secret is rejected", async () => {
  const db = fresh();
  const bad = oidc.sign({ upn: "tim@tqstarling.com", exp: Date.now() + 3600e3 }, "not-the-real-secret");
  const headers = { cookie: `${oidc.COOKIE}=${encodeURIComponent(bad)}` };
  assert.equal((await call(db, "GET", "/api/plan", {}, headers)).status, 401);
});

test("an expired session is rejected", async () => {
  const db = fresh();
  const stale = oidc.sign({ upn: "tim@tqstarling.com", exp: Date.now() - 1000 }, process.env.SESSION_SECRET);
  const headers = { cookie: `${oidc.COOKIE}=${encodeURIComponent(stale)}` };
  assert.equal((await call(db, "GET", "/api/plan", {}, headers)).status, 401);
});

test("DEV_USER impersonation is inert in production", async () => {
  const db = fresh();
  process.env.DEV_USER = "attacker@example.com";
  process.env.NODE_ENV = "production";
  try {
    assert.equal((await write(db, ANON)).status, 401, "dev impersonation must never work in prod");
  } finally {
    delete process.env.DEV_USER; delete process.env.NODE_ENV;
  }
});

test("DEV_USER impersonation is inert once real OIDC is configured", async () => {
  const db = fresh();
  process.env.DEV_USER = "attacker@example.com";
  Object.assign(process.env, {
    AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", AAD_CLIENT_SECRET: "s", PUBLIC_URL: "https://x",
  });
  try {
    assert.equal((await write(db, ANON)).status, 401, "configured OIDC must disable impersonation");
  } finally {
    delete process.env.DEV_USER;
    ["AAD_TENANT_ID", "AAD_CLIENT_ID", "AAD_CLIENT_SECRET", "PUBLIC_URL"].forEach((k) => delete process.env[k]);
  }
});
