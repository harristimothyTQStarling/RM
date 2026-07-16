"use strict";
/**
 * Entra ID identity + role enforcement.
 *
 * Azure Static Web Apps terminates auth and forwards the signed-in principal as
 * a base64 JSON `x-ms-client-principal` header. We never parse tokens ourselves
 * and never see a credential.
 *
 * Roles come from the Entra app registration:
 *   Planner.Editor -> may write
 *   Planner.Viewer -> read only (also the default for anyone in the tenant)
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

const canEdit = (user) => !!user && user.roles.includes(ROLE_EDITOR);

module.exports = { getUser, canEdit, ROLE_EDITOR };
