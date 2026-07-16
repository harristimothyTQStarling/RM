"use strict";
/**
 * Entra ID identity + role enforcement.
 *
 * Azure Static Web Apps terminates auth and forwards the signed-in principal as
 * a base64 JSON `x-ms-client-principal` header. We never parse tokens ourselves
 * and never see a credential.
 *
 * Two ways to grant write access — either is sufficient:
 *
 *   1. EDITOR_UPNS  — comma-separated allowlist, e.g. "tim@tqstarling.com".
 *      Simplest path while there is a single editor: one app setting, no App
 *      Roles to define and nobody to assign in Entra.
 *   2. Planner.Editor App Role — the scalable path once several people edit.
 *
 * Everyone else who signs in is read-only. Note there is no "deny" list: if the
 * allowlist is empty AND no role is present, the answer is simply no.
 *
 * Local dev: set DEV_USER / DEV_ROLES to impersonate. Guarded so it can only
 * ever work outside Azure — a misconfigured deploy must not fall open.
 */
const ROLE_EDITOR = "Planner.Editor";

function principalFromHeader(headers) {
  const raw = headers["x-ms-client-principal"];
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return {
      id: p.userId,
      upn: p.userDetails,
      roles: Array.isArray(p.userRoles) ? p.userRoles : [],
    };
  } catch { return null; }
}

function isAzure() { return !!process.env.WEBSITE_INSTANCE_ID || process.env.NODE_ENV === "production"; }

function getUser(headers = {}) {
  const p = principalFromHeader(headers);
  if (p) return p;
  if (!isAzure() && process.env.DEV_USER) {
    return { id: "dev", upn: process.env.DEV_USER, roles: (process.env.DEV_ROLES || ROLE_EDITOR).split(",").map(s => s.trim()).filter(Boolean) };
  }
  return null;
}

/** Allowlisted UPNs, lower-cased. Read per call so changing the app setting takes
 *  effect without a redeploy. */
function editorUpns() {
  return (process.env.EDITOR_UPNS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function canEdit(user) {
  if (!user) return false;
  if (user.roles.includes(ROLE_EDITOR)) return true;              // App Role path
  const upn = (user.upn || "").toLowerCase();
  return !!upn && editorUpns().includes(upn);                     // allowlist path
}

module.exports = { getUser, canEdit, editorUpns, ROLE_EDITOR };
