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

/**
 * Who may IMPORT a forecast — a stricter allowlist than editing, because an import
 * rewrites the whole plan in one shot. It is an editor capability (an importer must
 * also be an editor). IMPORTER_UPNS follows the EDITOR_UPNS idiom:
 *   unset        -> defaults to the primary planner (tim@tqstarling.com)
 *   empty string -> nobody can import (fail closed, like the editor allowlist)
 */
function importerUpns() {
  const raw = process.env.IMPORTER_UPNS;
  return (raw == null ? "tim@tqstarling.com" : raw)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const canImport = (user) =>
  canEdit(user) && importerUpns().includes(String((user && user.upn) || "").toLowerCase());

/**
 * Who may see COSTS AND PROFIT — the fully loaded per-person cost rate card
 * (entered in-app) and the margin it implies. Payroll data, so its own allowlist,
 * independent of edit rights, following the IMPORTER_UPNS idiom:
 *   unset        -> defaults to tim, melissa, joe and peter @tqstarling.com
 *   empty string -> nobody (fail closed)
 * Enforced server-side: /api/cost never returns data to anyone else, so the
 * numbers are not merely hidden in the UI — they never reach the browser.
 */
const DEFAULT_COSTING = "tim@tqstarling.com,melissa@tqstarling.com,joe@tqstarling.com,peter@tqstarling.com";
function costingUpns() {
  const raw = process.env.COSTING_UPNS;
  return (raw == null ? DEFAULT_COSTING : raw)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const canCost = (user) =>
  !!user && costingUpns().includes(String(user.upn || "").toLowerCase());

/** Who may EDIT the cost rate card (a stricter subset of the costing role —
 *  the others see the margin tabs read-only). Same idiom: unset -> tim only,
 *  empty -> nobody. Must also hold the costing role. */
function costingEditUpns() {
  const raw = process.env.COSTING_EDIT_UPNS;
  return (raw == null ? "tim@tqstarling.com" : raw)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const canCostEdit = (user) =>
  canCost(user) && costingEditUpns().includes(String(user.upn || "").toLowerCase());

module.exports = { getUser, canEdit, canImport, canCost, canCostEdit, editorUpns, importerUpns, costingUpns, costingEditUpns, rolesFor, ROLE_EDITOR };
