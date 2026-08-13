"use strict";
/**
 * Gusto OAuth — the contract:
 *   - Connect: consent URL carries client_id + exact redirect_uri + CSRF state;
 *     the callback verifies state, exchanges the code, discovers the company
 *     from token_info and persists the token pair
 *   - prepare(): uses the stored pair, refreshing (and rotating the single-use
 *     refresh token) when the access token is near expiry
 */
const test = require("node:test");
const assert = require("node:assert");
const { fresh } = require("./helpers");
const gusto = require("../src/gusto");

const ENV = { GUSTO_CLIENT_ID: "cid_123", GUSTO_CLIENT_SECRET: "sec_456", PUBLIC_URL: "https://planner.example.com" };
function withEnv(fn) {
  const saved = {};
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  delete process.env.GUSTO_API_TOKEN; delete process.env.GUSTO_COMPANY_ID;
  const restore = () => { for (const k of Object.keys(ENV)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  return fn().finally(restore);
}
function withFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  return fn().finally(() => { global.fetch = orig; });
}
const jsonRes = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) });

test("beginConnect builds the consent URL with the exact registered redirect URI", () => withEnv(async () => {
  const { location, cookie } = gusto.beginConnect();
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, "https://api.gusto.com/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "cid_123");
  assert.equal(u.searchParams.get("redirect_uri"), "https://planner.example.com/auth/gusto/callback");
  assert.equal(u.searchParams.get("response_type"), "code");
  const state = u.searchParams.get("state");
  assert.ok(state && state.length >= 32, "random CSRF state");
  assert.match(cookie, new RegExp(`tqsp_gusto=${state}`), "state persisted in a short-lived cookie");
}));

test("completeConnect exchanges the code, discovers the company, persists tokens; bad state rejected", () => withEnv(async () => {
  const db = fresh();
  const calls = [];
  await withFetch(async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/oauth/token")) {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "authcode-1");
      assert.equal(body.get("client_secret"), "sec_456");
      return jsonRes({ access_token: "at_1", refresh_token: "rt_1", expires_in: 7200 });
    }
    if (u.includes("/v1/token_info")) return jsonRes({ resource: { type: "Company", uuid: "co_999" } });
    throw new Error("unexpected fetch " + u);
  }, async () => {
    const out = await gusto.completeConnect(db, { code: "authcode-1", state: "s1" }, { cookie: "tqsp_gusto=s1" });
    assert.equal(out.location, "/?gusto=connected");
  });
  const row = await db.get("SELECT access_token, refresh_token, company_uuid FROM gusto_auth WHERE id=1");
  assert.deepEqual(row, { access_token: "at_1", refresh_token: "rt_1", company_uuid: "co_999" });

  await assert.rejects(
    gusto.completeConnect(db, { code: "x", state: "evil" }, { cookie: "tqsp_gusto=s1" }),
    /state mismatch/, "CSRF state must match the cookie");
}));

test("prepare(): not connected is a clear error; fresh tokens are used as-is; expiring tokens refresh and rotate", () => withEnv(async () => {
  const db = fresh();
  await assert.rejects(new gusto.Gusto().prepare(db), (e) => e.code === "not_connected");

  // fresh pair -> no network call at all
  await gusto.saveAuth(db, "at_fresh", "rt_fresh", 7200, "co_1");
  await withFetch(async () => { throw new Error("must not fetch"); }, async () => {
    const g = await new gusto.Gusto().prepare(db);
    assert.equal(g.token, "at_fresh");
    assert.equal(g.company, "co_1");
  });

  // expiring pair -> refresh grant, rotated pair persisted
  await gusto.saveAuth(db, "at_old", "rt_old", 30, "co_1");     // expires in 30s < 2min window
  await withFetch(async (url, opts) => {
    assert.ok(String(url).endsWith("/oauth/token"));
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "rt_old");
    return jsonRes({ access_token: "at_new", refresh_token: "rt_new", expires_in: 7200 });
  }, async () => {
    const g = await new gusto.Gusto().prepare(db);
    assert.equal(g.token, "at_new");
  });
  const row = await db.get("SELECT access_token, refresh_token FROM gusto_auth WHERE id=1");
  assert.deepEqual(row, { access_token: "at_new", refresh_token: "rt_new" }, "single-use refresh token rotated and saved");
}));
