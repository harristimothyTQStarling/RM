"use strict";
/**
 * Test helpers. Identity now arrives as our own signed session cookie (minted
 * after Entra sign-in) rather than Azure's principal header, so tests mint the
 * same cookie the real login flow would.
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-not-used-in-prod";

const oidc = require("../src/oidc");
const { open } = require("../src/db");
const { handle } = require("../src/handlers");

/** Headers for a signed-in user. Edit rights come from EDITOR_UPNS, not from here. */
function as(upn) {
  const value = oidc.sign(
    { upn, name: upn, oid: upn, exp: Date.now() + 3600e3 },
    process.env.SESSION_SECRET
  );
  return { cookie: `${oidc.COOKIE}=${encodeURIComponent(value)}` };
}

const ANON = {};
const fresh = () => open({ driver: "sqlite", file: ":memory:" });
const call = (db, method, path, body, headers = {}, query = {}) =>
  handle(db, { method, path, body, headers, query });

/** "YYYY-MM" for the current UTC month + n. Allocation writes to months before the
 *  current month are rejected (past months are actuals), so tests must build their
 *  months relative to the clock rather than hardcoding them. */
function fm(n = 0) {
  const d = new Date();
  const abs = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  return `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
}

module.exports = { as, ANON, fresh, call, fm };
