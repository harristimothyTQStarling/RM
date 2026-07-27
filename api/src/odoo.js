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

const { bestProjectMatch } = require("./match");
const { reassignAllocations } = require("./store");

const DEFAULT_TIMEOUT = 20000;

// Actor recorded in the audit log for changes the sync makes on its own.
const SYSTEM_USER = { upn: "system@odoo-sync" };

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

/**
 * Fetch specific opportunities by id INCLUDING archived (Won/Lost) ones.
 * readOpportunities() drops closed opps, so once an opp closes we can no longer
 * see its name/client through the normal path — but a closed opp still carries
 * forecast we need to reconcile, and matching needs its name. active_test:false
 * lifts Odoo's default "active = true" filter.
 */
async function readOppsByIds(odoo, ids) {
  if (!ids.length) return [];
  const rows = await odoo.searchRead("crm.lead", [["id", "in", ids]],
    ["name", "partner_id", "stage_id", "active"], { context: { active_test: false } });
  return rows.map((r) => ({
    id: r.id,
    name: String(r.name || "").replace(/\s+/g, " ").trim(),
    client: m2oName(r.partner_id),
    stage: m2oName(r.stage_id) || "Closed",
  }));
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
      // booleans are stored as SMALLINT 0/1 in both schemas — node:sqlite won't
      // bind a JS boolean, and Postgres won't accept 1 for a BOOLEAN column, so
      // one integer representation keeps a single code path working on both.
      const vals = columns.map((c) => { const v = r[c]; return typeof v === "boolean" ? (v ? 1 : 0) : v; });
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

/* --------------------------------------------------- closed-CRM reconcile -- */
/**
 * After the reference cache is refreshed, reconcile forecast that is still parked
 * on a CRM opportunity which has since CLOSED in Odoo:
 *
 *   - matched to a delivery project  -> move the forecast crm:<id> -> prj:<pid>,
 *     keeping every hour, and let the opp drop out of the reference (migrated).
 *   - no confident match             -> keep the forecast on the CRM opp but write
 *     it back with needs_project=1 so the UI flags it; the next sync retries the
 *     match and migrates it the moment a project appears.
 *
 * "Closed" is inferred structurally: a crm target that still has allocations but
 * is no longer in the freshly-synced OPEN opportunity set. Best-effort and
 * idempotent — a failure on one opp doesn't block the others or the sync.
 */
async function reconcileClosedCrm(db, odoo, projects, openOppIds) {
  const rows = await db.all("SELECT DISTINCT target_key FROM allocation WHERE target_key LIKE 'crm:%'");
  const crmIds = rows.map((r) => parseInt(String(r.target_key).slice(4), 10)).filter(Number.isInteger);
  const closedIds = crmIds.filter((id) => !openOppIds.has(id));
  const result = { migrated: 0, flagged: 0, closed: closedIds.length };
  if (!closedIds.length) return result;

  let details = [];
  try { details = await readOppsByIds(odoo, closedIds); } catch { details = []; }
  const byId = new Map(details.map((o) => [o.id, o]));

  for (const id of closedIds) {
    const opp = byId.get(id) || { id, name: `Closed opportunity #${id}`, client: "", stage: "Closed" };
    try {
      const hit = bestProjectMatch({ name: opp.name, client: opp.client }, projects);
      if (hit) {
        await reassignAllocations(db, SYSTEM_USER, `crm:${id}`, `prj:${hit.project.id}`);
        result.migrated++;
      } else {
        // Keep the forecast where it is; retain the opp (active=1) so the UI can
        // render it, tagged needs_project. Upsert because replaceAll may have
        // deleted it moments ago (open-opp refresh) or a prior flag may exist.
        await db.run(
          `INSERT INTO ref_opportunity (id, name, client, stage, active, needs_project)
           VALUES (?,?,?,?,1,1)
           ON CONFLICT (id) DO UPDATE SET
             name=excluded.name, client=excluded.client, stage=excluded.stage,
             active=1, needs_project=1`,
          [id, opp.name, opp.client || "", opp.stage || "Closed"]
        );
        result.flagged++;
      }
    } catch (e) {
      result.error = (result.error || 0) + 1;   // leave for the next sync to retry
    }
  }
  return result;
}

/** Full reference refresh. Safe to run on a schedule; each set is independent. */
async function syncAll(db, odoo, { actualsFrom, actualsTo } = {}) {
  const out = {};
  await odoo.login();
  const people = await readPeople(odoo);
  const projects = await readProjects(odoo);
  const opps = await readOpportunities(odoo);
  out.ref_person = await replaceAll(db, "ref_person", people, ["id", "name", "role", "dept", "type", "active"]);
  out.ref_project = await replaceAll(db, "ref_project", projects, ["id", "name", "client", "billable", "active"]);
  out.ref_opportunity = await replaceAll(db, "ref_opportunity", opps, ["id", "name", "client", "stage", "active"]);
  if (actualsFrom && actualsTo) {
    // Keep only actuals for people/projects we actually show. Odoo returns
    // timesheet lines for everyone (incl. "Internal" admin time and non-delivery
    // staff); storing those would bloat ref_actual and inflate any totals with
    // rows nothing renders. Scope to the synced roster + project list.
    const personIds = new Set(people.map((p) => p.id));
    const projectIds = new Set(projects.map((p) => p.id));
    const actuals = (await readActuals(odoo, actualsFrom, actualsTo))
      .filter((a) => personIds.has(a.employee_id) && projectIds.has(a.project_id));
    out.ref_actual = await replaceAll(db, "ref_actual", actuals, ["employee_id", "project_id", "month", "hours"]);
  }
  // Migrate/flag forecast stranded on opportunities that have since closed. Runs
  // after the open-opp refresh so the "still open?" test uses fresh data.
  out.reconcile = await reconcileClosedCrm(db, odoo, projects, new Set(opps.map((o) => o.id)));
  return out;
}

module.exports = {
  Odoo, OdooError, syncAll, reconcileClosedCrm,
  readPeople, readProjects, readOpportunities, readOppsByIds, readActuals,
  shapePeople, m2oName, m2oId,
};
