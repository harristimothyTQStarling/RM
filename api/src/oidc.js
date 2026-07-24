"use strict";
/**
 * Microsoft Entra ID sign-in (OpenID Connect authorization-code flow + PKCE).
 *
 * Azure Static Web Apps used to terminate auth for us; on Railway it's ours to do.
 * Split deliberately:
 *   - the REDIRECT + TOKEN EXCHANGE are plain, well-specified HTTP and written here
 *   - the SECURITY-CRITICAL part (ID-token signature / issuer / audience / expiry)
 *     is delegated to `jose`, which is a maintained, audited implementation.
 *     Hand-rolling JWT validation is how auth bugs get shipped.
 *
 * After a successful sign-in we mint our own short-lived signed session cookie and
 * never touch Microsoft again for that browser. We ask only for `openid profile
 * email` — no Graph access, no tokens worth stealing.
 *
 * Tenant lock: the `tid` claim must equal AAD_TENANT_ID, so only your own
 * organisation can sign in even though the app is on a public URL.
 *
 * Env:
 *   AAD_TENANT_ID, AAD_CLIENT_ID, AAD_CLIENT_SECRET   from the app registration
 *   PUBLIC_URL          e.g. https://planner.up.railway.app (no trailing slash)
 *   SESSION_SECRET      random 32+ chars; signs the session cookie
 */
const crypto = require("node:crypto");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const COOKIE = "tqsp_session";
const STATE_COOKIE = "tqsp_oidc";
const SESSION_HOURS = 10;                       // a working day, then sign in again

const cfg = () => ({
  tenant: process.env.AAD_TENANT_ID,
  clientId: process.env.AAD_CLIENT_ID,
  clientSecret: process.env.AAD_CLIENT_SECRET,
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  secret: process.env.SESSION_SECRET,
});
const isConfigured = () => { const c = cfg(); return !!(c.tenant && c.clientId && c.clientSecret && c.publicUrl && c.secret); };
const issuer = (t) => `https://login.microsoftonline.com/${t}/v2.0`;
const authorizeUrl = (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`;
const tokenUrl = (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`;
const redirectUri = () => `${cfg().publicUrl}/auth/callback`;

let _jwks = null;
const jwks = (t) => (_jwks ||= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${t}/discovery/v2.0/keys`)));

/* ------------------------------------------------------------- cookie utils -- */
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

function sign(payloadObj, secret) {
  const body = b64u(JSON.stringify(payloadObj));
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function unsign(value, secret) {
  if (typeof value !== "string" || !value.includes(".")) return null;
  const [body, mac] = value.split(".");
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  // timingSafeEqual throws on length mismatch — guard first
  const a = Buffer.from(mac || "", "utf8"), b = Buffer.from(expect, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(unb64u(body).toString("utf8")); } catch { return null; }
}

function parseCookies(header = "") {
  const out = {};
  String(header).split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function serializeCookie(name, value, { maxAge, secure = true } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (secure) s += "; Secure";
  s += `; Max-Age=${maxAge == null ? 0 : maxAge}`;
  return s;
}

/* ------------------------------------------------------------------ session -- */
function readSession(headers = {}) {
  const c = cfg();
  if (!c.secret) return null;
  const raw = parseCookies(headers.cookie || headers.Cookie || "")[COOKIE];
  if (!raw) return null;
  const s = unsign(raw, c.secret);
  if (!s || !s.upn || !s.exp || Date.now() > s.exp) return null;   // expired or tampered
  return { id: s.oid || s.upn, upn: s.upn, name: s.name || s.upn, roles: [] };
}
function sessionCookie(claims) {
  const c = cfg();
  const payload = {
    upn: claims.upn, name: claims.name, oid: claims.oid,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  };
  return serializeCookie(COOKIE, sign(payload, c.secret), { maxAge: SESSION_HOURS * 3600, secure: !isLocal() });
}
const clearCookie = (name) => serializeCookie(name, "", { maxAge: 0, secure: !isLocal() });
const isLocal = () => /^http:\/\/localhost|^http:\/\/127\./.test(cfg().publicUrl || "");

/* -------------------------------------------------------------- login start -- */
/** Returns {location, cookie} — redirect the browser and set the temp state cookie. */
function beginLogin(returnTo = "/") {
  const c = cfg();
  const state = crypto.randomBytes(16).toString("base64url");
  const nonce = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");                   // PKCE
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: "openid profile email",
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const tmp = sign({ state, nonce, verifier, returnTo, exp: Date.now() + 10 * 60 * 1000 }, c.secret);
  return {
    location: `${authorizeUrl(c.tenant)}?${params}`,
    cookie: serializeCookie(STATE_COOKIE, tmp, { maxAge: 600, secure: !isLocal() }),
  };
}

/* ----------------------------------------------------------- login callback -- */
/** Exchange the code, validate the ID token, return {cookies[], location} or throws. */
async function completeLogin(query, headers) {
  const c = cfg();
  if (query.error) throw new Error(`sign-in failed: ${query.error_description || query.error}`);

  const tmp = unsign(parseCookies(headers.cookie || "")[STATE_COOKIE] || "", c.secret);
  if (!tmp || Date.now() > tmp.exp) throw new Error("sign-in expired — please try again");
  if (!query.state || query.state !== tmp.state) throw new Error("state mismatch");   // CSRF guard
  if (!query.code) throw new Error("no authorization code returned");

  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: "authorization_code",
    code: query.code,
    redirect_uri: redirectUri(),
    code_verifier: tmp.verifier,
    scope: "openid profile email",
  });
  const res = await fetch(tokenUrl(c.tenant), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const tok = await res.json();
  if (!tok.id_token) throw new Error("no id_token in token response");

  // jose validates signature, issuer, audience and expiry.
  const { payload } = await jwtVerify(tok.id_token, jwks(c.tenant), {
    issuer: issuer(c.tenant),
    audience: c.clientId,
  });
  if (payload.nonce !== tmp.nonce) throw new Error("nonce mismatch");                // replay guard
  if (payload.tid !== c.tenant) throw new Error("account is outside this tenant");    // tenant lock

  const upn = String(payload.preferred_username || payload.email || payload.upn || "").toLowerCase();
  if (!upn) throw new Error("no email/UPN in token");

  return {
    cookies: [sessionCookie({ upn, name: payload.name, oid: payload.oid }), clearCookie(STATE_COOKIE)],
    location: typeof tmp.returnTo === "string" && tmp.returnTo.startsWith("/") ? tmp.returnTo : "/",
    upn,
  };
}

const logout = () => ({ cookies: [clearCookie(COOKIE)], location: "/" });

module.exports = {
  isConfigured, beginLogin, completeLogin, logout, readSession,
  COOKIE, STATE_COOKIE, parseCookies, sign, unsign, sessionCookie,
};
