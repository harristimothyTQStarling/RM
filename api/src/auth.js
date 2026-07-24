"use strict";
/**
 * Identity + edit rights.
 *
 * Identity comes from our own signed session cookie, minted after Microsoft Entra
 * sign-in (see oidc.js). Previously Azure Static Web Apps injected a principal
 * header; on Railway nothing does that for us, so the cookie IS the identity.
 *
 * Edit rights are decided HERE, not by Entra app roles — write access is an
 * allowlist of email addresses in EDITOR_UPNS. That means adding or removing an
 * editor is an env-var change (instant, no redeploy, no Entra admin work), and
 * we don't depend on app-role assignment being configured correctly.
 *
 *   EDITOR_UPNS="tim@tqstarling.com,someone@tqstarling.com"
 *
 * Everyone else who signs in is read-only. There is no "deny" list: if the
 * allowlist is empty, nobody can edit — it must never fall open.
 *
 * Local dev: DEV_USER / DEV_ROLES impersonate a user, and are hard-disabled
 * whenever real OIDC is configured or NODE_ENV=production, so a misconfigured
 * deploy can never accept a forged identity.
 */
const oidc = require("./oidc");

const ROLE_EDITOR = "Planner.Editor";

function devImpersonationAllowed() {
  if (process.env.NODE_ENV === "production") return false;
  if (oidc.isConfigured()) return false;          // real auth present -> never impersonate
  return !!process.env.DEV_USER;
}

/** The signed-in user, or null. */
function getUser(headers = {}) {
  const s = oidc.readSession(headers);
  if (s) return { ...s, roles: rolesFor(s.upn) };
  if (devImpersonationAllowed()) {
    const upn = process.env.DEV_USER;
    return { id: "dev", upn, name: upn, roles: rolesFor(upn, process.env.DEV_ROLES) };
  }
  return null;
}

function editorUpns() {
  return (process.env.EDITOR_UPNS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function rolesFor(upn, devRoles) {
  const roles = [];
  if (devRoles) roles.push(...devRoles.split(",").map((s) => s.trim()).filter(Boolean));
  const u = String(upn || "").toLowerCase();
  if (u && editorUpns().includes(u) && !roles.includes(ROLE_EDITOR)) roles.push(ROLE_EDITOR);
  return roles;
}

const canEdit = (user) => !!user && user.roles.includes(ROLE_EDITOR);

module.exports = { getUser, canEdit, editorUpns, rolesFor, ROLE_EDITOR };
