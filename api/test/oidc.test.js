"use strict";
/**
 * OIDC flow state handling — the contract:
 *   - the temp cookie holds a short STACK of pending attempts, so a second
 *     tab starting sign-in no longer invalidates the first ("state mismatch")
 *   - lost/raced/expired state throws RECOVERABLE errors (the server silently
 *     restarts the flow); unknown states still never proceed (CSRF guard)
 */
const test = require("node:test");
const assert = require("node:assert");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-not-used-in-prod";
process.env.AAD_TENANT_ID = "tenant-1";
process.env.AAD_CLIENT_ID = "client-1";
process.env.AAD_CLIENT_SECRET = "s";
process.env.PUBLIC_URL = "https://planner.example";

const oidc = require("../src/oidc");

const stateOf = (loc) => new URL(loc).searchParams.get("state");
const cookieHeader = (setCookie) => ({ cookie: setCookie.split(";")[0] });

test("two parallel sign-in attempts both stay pending in the cookie", () => {
  const a = oidc.beginLogin("/a");
  const b = oidc.beginLogin("/b", cookieHeader(a.cookie));   // tab 2 starts with tab 1's cookie
  const tmp = oidc.unsign(decodeURIComponent(b.cookie.split(";")[0].split("=").slice(1).join("=")), process.env.SESSION_SECRET);
  assert.ok(Array.isArray(tmp.att) && tmp.att.length === 2, "both attempts kept");
  assert.deepEqual(tmp.att.map(x => x.state), [stateOf(a.location), stateOf(b.location)]);
  assert.deepEqual(tmp.att.map(x => x.returnTo), ["/a", "/b"]);
});

test("the OLDER attempt still completes after a newer one started (the race fix)", async () => {
  const a = oidc.beginLogin("/a");
  const b = oidc.beginLogin("/b", cookieHeader(a.cookie));
  // Completing attempt A with the cookie B wrote used to throw "state mismatch".
  // Stub the token exchange: reaching it proves the state guard passed.
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "stub" }) });
  try {
    await assert.rejects(
      () => oidc.completeLogin({ state: stateOf(a.location), code: "c" }, cookieHeader(b.cookie)),
      /token exchange failed/, "A's state matched; flow proceeded to the exchange");
  } finally { global.fetch = realFetch; }
});

test("unknown or missing state is refused but marked recoverable; CSRF guard holds", async () => {
  const b = oidc.beginLogin("/");
  const err1 = await oidc.completeLogin({ state: "forged-state", code: "c" }, cookieHeader(b.cookie)).catch(e => e);
  assert.match(err1.message, /state mismatch/);
  assert.equal(err1.recoverable, true, "raced/forged state restarts the flow instead of dead-ending");

  const err2 = await oidc.completeLogin({ state: stateOf(b.location), code: "c" }, { cookie: "" }).catch(e => e);
  assert.match(err2.message, /state lost/);
  assert.equal(err2.recoverable, true);
});

test("at most three attempts are kept; the newest always survives", () => {
  let cookie = null;
  const states = [];
  for (let i = 0; i < 5; i++) {
    const r = oidc.beginLogin("/" + i, cookie ? cookieHeader(cookie) : {});
    states.push(stateOf(r.location)); cookie = r.cookie;
  }
  const tmp = oidc.unsign(decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("=")), process.env.SESSION_SECRET);
  assert.equal(tmp.att.length, 3, "stack capped");
  assert.deepEqual(tmp.att.map(x => x.state), states.slice(-3), "newest three kept, oldest dropped");
});
