"use strict";
/**
 * Odoo read-only client + reference sync.
 *
 * Target: Odoo Online 19.0 Enterprise at https://tq-starling.odoo.com (db
 * "tq-starling") — both confirmed against the live server's unauthenticated
 * version/database endpoints. Public HTTPS, so Railway reaches it directly.
 *
 * Uses Odoo's external JSON-RPC API with a READ-ONLY service account. We only
 * ever call `search_read` / `fields_get`; nothing here can write to the ERP.
 *
 * Results are cached into the ref_* tables (see db/schema.postgres.sql) so a page
 * load never blocks on Odoo and the planner survives an Odoo outage.
 *
 * !! FIELD CONTRACT — VERIFY BEFORE TRUSTING !!
 * Odoo 18+ moved job title / department onto the employee "version" record
 * (hr.version). Whether hr.employee still exposes them as related fields varies
 * by version and install. `scripts/verify-odoo.js` enumerates the real fields via
 * fields_get and reports which path this instance supports; readPeople() below
 * handles BOTH and prefers whichever is present, so it degrades rather than
 * silently returning blank roles.
 */

const DEFAULT_TIMEOUT = 20000;

class OdooError extends Error {
  constructor(msg, code) { super(msg); this.name = "OdooError"; this.code = code; }
}

class Odoo {
  constructor(opts = {}) {
    this.url = (opts.url || process.env.ODOO_URL || "").replace(/\/+$/, "").replace(/\/en$/, "");
    this.db = opts.db || process.env.ODOO_DB;
    this.user = opts.user || process.env.ODOO_USER;
    this.password = opts.password || process.env.ODOO_PASSWORD;
    this.uid = null;
  }

  get configured() { return !!(this.url && this.db && this.user && this.password); }

  async #rpc(service, method, args) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT);
    let res;
    try {
      res = await fetch(`${this.url}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new OdooError(`cannot reach Odoo at ${this.url}: ${e.message}`, "unreachable");
    } finally { clearTimeout(t); }
    if (!res.ok) throw new OdooError(`Odoo HTTP ${res.status}`, "http");
    const body = await res.json();
    if (body.error) {
      const m = body.error.data?.message || body.error.message || "unknown Odoo error";
      throw new OdooError(m, body.error.data?.name || "rpc");
    }
    return body.result;
  }

  /** Authenticate the service account; returns the uid. */
  async login() {
    if (!this.configured) throw new OdooError("ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASSWORD must all be set", "config");
    const uid = await this.#rpc("common", "login", [this.db, this.user, this.password]);
    if (!uid) throw new OdooError("Odoo rejected the service account (check user/password/db)", "auth");
    this.uid = uid;
    return uid;
  }

  /** Low-level model call. Read-only by convention — only pass read methods. */
  async call(model, method, args = [], kwargs = {}) {
    if (!this.uid) await this.login();
    return this.#rpc("object", "execute_kw", [this.db, this.uid, this.password, model, method, args, kwargs]);
  }

  searchRead(model, domain = [], fields = [], opts = {}) {
    return this.call(model, "search_read", [domain, fields], { limit: 0, ...opts });
  }
  fieldsOf(model) { return this.call(model, "fields_get", [], { attributes: ["string", "type"] }); }
  async hasFields(model, names) {
    const f = await this.fieldsOf(model);
    return Object.fromEntries(names.map((n) => [n, !!f[n]]));
  }
}

/* --------------------------------------------------------------- readers -- */
/* many2one fields come back as [id, "Display Name"] or false. */
const m2oName = (v) => (Array.isArray(v) ? v[1] : "") || "";
const m2oId = (v) => (Array.isArray(v) ? v[0] : null);

const EXCLUDED_DEPTS = ["Operations", "Sales and Marketing"];
const isContractor = (dept) => String(dept || "").trim() === "Contractor";

/**
 * Active people with role + department, excluding the non-delivery departments.
 * Handles both field layouts (see the note at the top of this file).
 */
async function readPeople(odoo) {
  const avail = await odoo.hasFields("hr.employee", ["job_title", "department_id", "current_version_id"]);
  const direct = avail.job_title && avail.department_id;

  if (direct) {
    const rows = await odoo.searchRead("hr.employee", [["active", "=", true]],
      ["name", "job_title", "department_id"]);
    return shapePeople(rows.map((r) => ({
      id: r.id, name: r.name, role: r.job_title || "", dept: m2oName(r.department_id),
    })));
  }

  // Fallback: role/department live on the employee's current hr.version record.
  const emps = await odoo.searchRead("hr.employee", [["active", "=", true]], ["name", "current_version_id"]);
  const versionIds = emps.map((e) => m2oId(e.current_version_id)).filter(Boolean);
  const versions = versionIds.length
    ? await odoo.searchRead("hr.version", [["id", "in", versionIds]], ["job_title", "department_id"])
    : [];
  const byVersion = new Map(versions.map((v) => [v.id, v]));
  return shapePeople(emps.map((e) => {
    const v = byVersion.get(m2oId(e.current_version_id)) || {};
    return { id: e.id, name: e.name, role: v.job_title || "", dept: m2oName(v.department_id) };
  }));
}

function shapePeople(list) {
  return list
    .filter((p) => p.dept && !EXCLUDED_DEPTS.includes(p.dept))       // must have a department
    .filter((p) => !/^Template_|^OdooBot$/i.test(p.name))            // template/bot rows
    .map((p) => ({ ...p, type: isContractor(p.dept) ? "contractor" : "employee", active: true }));
}

/** Active delivery projects, excluding templates/test rows. */
async function readProjects(odoo) {
  const rows = await odoo.searchRead("project.project", [["active", "=", true]], ["name", "partner_id"]);
  return rows
    .filter((r) => !/^template|^s\d+ - template|test project|^customer care$/i.test(String(r.name).trim()))
    .map((r) => ({
      id: r.id,
      name: String(r.name).replace(/\s+/g, " ").trim(),
      client: m2oName(r.partner_id),
      billable: !/non-billable|internal|website/i.test(r.name),
      active: true,
    }));
}

/** Open pipeline: opportunities that are neither Won nor Lost. */
async function readOpportunities(odoo) {
  const rows = await odoo.searchRead("crm.lead",
    [["active", "=", true], ["type", "=", "opportunity"]],
    ["name", "partner_id", "stage_id", "probability"]);
  return rows
    .map((r) => ({
      id: r.id,
      name: String(r.name).replace(/\s+/g, " ").trim(),
      client: m2oName(r.partner_id),
      stage: m2oName(r.stage_id),
      active: true,
    }))
    .filter((o) => !/^(won|lost)$/i.test(o.stage));
}

/** Actual timesheet hours per employee/project/month for a date range. */
async function readActuals(odoo, from, to) {
  const rows = await odoo.searchRead("account.analytic.line",
    [["date", ">=", from], ["date", "<", to], ["project_id", "!=", false], ["employee_id", "!=", false]],
    ["employee_id", "project_id", "date", "unit_amount"]);
  const agg = new Map();
  for (const r of rows) {
    const h = Number(r.unit_amount) || 0;
    if (h <= 0) continue;
    const key = `${m2oId(r.employee_id)}|${m2oId(r.project_id)}|${String(r.date).slice(0, 7)}-01`;
    agg.set(key, (agg.get(key) || 0) + h);
  }
  return [...agg].map(([k, hours]) => {
    const [employee_id, project_id, month] = k.split("|");
    return { employee_id: +employee_id, project_id: +project_id, month, hours: Math.round(hours * 100) / 100 };
  });
}

/* ------------------------------------------------------------------ sync -- */
/** Replace a ref_ table's contents inside one transaction. */
async function replaceAll(db, table, rows, columns) {
  await db.tx(async () => {
    await db.run(`DELETE FROM ${table}`);
    for (const r of rows) {
      const vals = columns.map((c) => r[c]);
      await db.run(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        vals
      );
    }
    await db.run("DELETE FROM sync_state WHERE source = ?", [table]);
    await db.run(
      "INSERT INTO sync_state (source, synced_at, row_count, ok, message) VALUES (?,?,?,?,?)",
      [table, new Date().toISOString(), rows.length, 1, null]
    );
  });
  return rows.length;
}

/** Full reference refresh. Safe to run on a schedule; each set is independent. */
async function syncAll(db, odoo, { actualsFrom, actualsTo } = {}) {
  const out = {};
  await odoo.login();
  out.ref_person = await replaceAll(db, "ref_person", await readPeople(odoo),
    ["id", "name", "role", "dept", "type", "active"]);
  out.ref_project = await replaceAll(db, "ref_project", await readProjects(odoo),
    ["id", "name", "client", "billable", "active"]);
  out.ref_opportunity = await replaceAll(db, "ref_opportunity", await readOpportunities(odoo),
    ["id", "name", "client", "stage", "active"]);
  if (actualsFrom && actualsTo) {
    out.ref_actual = await replaceAll(db, "ref_actual", await readActuals(odoo, actualsFrom, actualsTo),
      ["employee_id", "project_id", "month", "hours"]);
  }
  return out;
}

module.exports = {
  Odoo, OdooError, syncAll,
  readPeople, readProjects, readOpportunities, readActuals,
  shapePeople, m2oName, m2oId,
};
