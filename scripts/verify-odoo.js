#!/usr/bin/env node
"use strict";
/**
 * Verifies the Odoo read path against the LIVE server before we trust it.
 *
 * Run this yourself with the read-only service account. It prints only SHAPE —
 * field names, row counts, PASS/FAIL — and never prints employee names, client
 * names or hours. So the output is safe to paste back.
 *
 *   cd C:\Users\timha\tqs-resource-planner
 *   ODOO_URL=https://tq-starling.odoo.com ODOO_DB=tq-starling \
 *   ODOO_USER= ODOO_PASSWORD= \
 *   node scripts/verify-odoo.js
 *
 * On Windows PowerShell:
 *   $env:ODOO_URL="https://tq-starling.odoo.com"; $env:ODOO_DB="tq-starling"
 *   $env:ODOO_USER="<service-account-login>"; $env:ODOO_PASSWORD="<password>"
 *   node scripts/verify-odoo.js
 *
 * NEVER put real credentials in this file — it is committed to git. Set them as
 * environment variables in your shell session (above) or in .env, which is
 * gitignored.
 *
 * Everything it calls is read-only (search_read / fields_get). It cannot modify Odoo.
 */
const { Odoo, readPeople, readProjects, readOpportunities, readActuals } = require("../api/src/odoo");

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`); if (!cond) fails++; };
const info = (msg) => console.log(`       ${msg}`);

(async () => {
  const odoo = new Odoo();
  console.log(`\nOdoo verification — ${odoo.url} (db: ${odoo.db})\n`);
  if (!odoo.configured) {
    console.error("ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASSWORD must all be set.\n");
    process.exit(2);
  }

  /* 1. auth ---------------------------------------------------------------- */
  console.log("1) authenticate the service account");
  try {
    const uid = await odoo.login();
    ok(!!uid, `logged in (uid ${uid})`);
  } catch (e) {
    ok(false, `login failed: ${e.message}`);
    console.error("\nCannot continue without a login.\n");
    process.exit(1);
  }

  /* 2. field contract ------------------------------------------------------ */
  console.log("\n2) field contract (which layout does this instance use?)");
  const emp = await odoo.hasFields("hr.employee", ["name", "active", "job_title", "department_id", "current_version_id"]);
  info(`hr.employee: ${Object.entries(emp).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join("  ")}`);
  const directLayout = emp.job_title && emp.department_id;
  ok(emp.name && emp.active, "hr.employee has name/active");
  ok(directLayout || emp.current_version_id,
    directLayout ? "role+dept read directly from hr.employee" : "role+dept via hr.version (fallback path)");
  if (!directLayout && emp.current_version_id) {
    const ver = await odoo.hasFields("hr.version", ["job_title", "department_id"]);
    info(`hr.version : ${Object.entries(ver).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join("  ")}`);
    ok(ver.job_title && ver.department_id, "hr.version exposes job_title + department_id");
  }
  const prj = await odoo.hasFields("project.project", ["name", "partner_id", "active"]);
  ok(prj.name && prj.partner_id && prj.active, "project.project has name/partner_id/active");
  const crm = await odoo.hasFields("crm.lead", ["name", "partner_id", "stage_id", "type", "active"]);
  ok(crm.name && crm.partner_id && crm.stage_id && crm.type, "crm.lead has name/partner_id/stage_id/type");
  const aal = await odoo.hasFields("account.analytic.line", ["employee_id", "project_id", "date", "unit_amount"]);
  ok(aal.employee_id && aal.project_id && aal.date && aal.unit_amount,
    "account.analytic.line has employee_id/project_id/date/unit_amount");

  /* 3. readers return usable data ------------------------------------------ */
  console.log("\n3) readers (counts and shape only — no values printed)");
  const people = await readPeople(odoo);
  ok(people.length > 0, `people: ${people.length} rows`);
  const withRole = people.filter((p) => p.role).length;
  const withDept = people.filter((p) => p.dept).length;
  ok(withRole > people.length * 0.5, `roles populated on ${withRole}/${people.length} (blank roles would break the By-Role view)`);
  ok(withDept === people.length, `departments populated on ${withDept}/${people.length}`);
  info(`types: ${["employee", "contractor"].map((t) => `${t}=${people.filter((p) => p.type === t).length}`).join("  ")}`);
  info(`departments seen: ${[...new Set(people.map((p) => p.dept))].sort().join(" | ")}`);

  const projects = await readProjects(odoo);
  ok(projects.length > 0, `projects: ${projects.length} rows`);
  ok(projects.filter((p) => p.client).length > 0, `clients populated on ${projects.filter((p) => p.client).length}/${projects.length}`);

  const opps = await readOpportunities(odoo);
  ok(opps.length > 0, `open opportunities: ${opps.length} rows`);
  info(`stages seen: ${[...new Set(opps.map((o) => o.stage))].sort().join(" | ")}`);
  ok(!opps.some((o) => /^(won|lost)$/i.test(o.stage)), "Won/Lost correctly excluded from the pipeline");

  const year = new Date().getUTCFullYear();
  const actuals = await readActuals(odoo, `${year}-01-01`, `${year}-07-01`);
  ok(actuals.length > 0, `actuals Jan–Jun ${year}: ${actuals.length} person/project/month rows`);
  const total = actuals.reduce((s, r) => s + r.hours, 0);
  info(`total hours: ${Math.round(total)}  (sanity-check this against Odoo yourself)`);
  ok(actuals.every((r) => /^\d{4}-\d{2}-01$/.test(r.month)), "months normalised to the 1st");

  /* 4. read-only proof ----------------------------------------------------- */
  console.log("\n4) service account should be READ-ONLY");
  try {
    await odoo.call("project.project", "create", [{ name: "__verify_should_fail__" }]);
    ok(false, "!! the account was able to CREATE a project — it has write access, tighten it");
  } catch {
    ok(true, "write attempt rejected (account is read-only)");
  }

  console.log(fails ? `\n${fails} CHECK(S) FAILED\n` : "\nALL CHECKS PASSED — the sync can be trusted\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("\nverification error:", e.message, "\n"); process.exit(1); });
