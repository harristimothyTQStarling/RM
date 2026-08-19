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
  const avail = await odoo.hasFields("hr.employee", ["job_title", "department_id", "current_version_id", "employee_type"]);
  const direct = avail.job_title && avail.department_id;
  const typeField = avail.employee_type ? ["employee_type"] : [];

  let people;
  if (direct) {
    const rows = await odoo.searchRead("hr.employee", [["active", "=", true]],
      ["name", "job_title", "department_id", ...typeField]);
    people = shapePeople(rows.map((r) => ({
      id: r.id, name: r.name, role: r.job_title || "", dept: m2oName(r.department_id),
      employeeType: r.employee_type || "",
    })));
  } else {
    // Fallback: role/department live on the employee's current hr.version record —
    // and in this layout (TQStarling's Odoo included) employee_type does too, so
    // read it from whichever model actually has it.
    const vAvail = await odoo.hasFields("hr.version", ["employee_type"]);
    const vTypeField = vAvail.employee_type ? ["employee_type"] : [];
    const emps = await odoo.searchRead("hr.employee", [["active", "=", true]], ["name", "current_version_id", ...typeField]);
    const versionIds = emps.map((e) => m2oId(e.current_version_id)).filter(Boolean);
    const versions = versionIds.length
      ? await odoo.searchRead("hr.version", [["id", "in", versionIds]], ["job_title", "department_id", ...vTypeField])
      : [];
    const byVersion = new Map(versions.map((v) => [v.id, v]));
    people = shapePeople(emps.map((e) => {
      const v = byVersion.get(m2oId(e.current_version_id)) || {};
      return { id: e.id, name: e.name, role: v.job_title || "", dept: m2oName(v.department_id), employeeType: v.employee_type || e.employee_type || "" };
    }));
  }
  const emp = await readEmploymentDates(odoo, people.map((p) => p.id));
  return people.map((p) => {
    const e = emp.get(p.id) || {};
    return { ...p, hire_date: e.hire || null, end_date: e.end || null };
  });
}

/** Employment window per employee, from hr.version — the same basis the
 *  board-pack utilization report uses:
 *    hire = earliest date_version (contract_date_start is often blank, so it is
 *           deliberately NOT used)
 *    end  = departure_date on the LATEST version — a rehired person's current
 *           version has no departure, which correctly clears an older one.
 *  Missing model/field degrades to "no dates". */
async function readEmploymentDates(odoo, empIds) {
  if (!empIds.length) return new Map();
  let avail;
  try { avail = await odoo.hasFields("hr.version", ["date_version", "employee_id", "departure_date"]); }
  catch { return new Map(); }
  if (!avail.date_version || !avail.employee_id) return new Map();
  const fields = ["employee_id", "date_version", ...(avail.departure_date ? ["departure_date"] : [])];
  const rows = await odoo.searchRead("hr.version", [["employee_id", "in", empIds]], fields);
  const m = new Map();
  for (const r of rows) {
    const id = m2oId(r.employee_id); if (!id) continue;
    const d = r.date_version ? String(r.date_version).slice(0, 10) : null;
    const dep = r.departure_date ? String(r.departure_date).slice(0, 10) : null;
    const e = m.get(id) || { hire: null, end: null, latest: null };
    if (d && (!e.hire || d < e.hire)) e.hire = d;
    if (d && (!e.latest || d > e.latest)) { e.latest = d; e.end = dep; }
    m.set(id, e);
  }
  return m;
}

/** Company-wide public holidays: resource_calendar_leaves rows with no resource
 *  and time_type='leave'. Used client-side to prorate monthly capacity. */
async function readHolidays(odoo) {
  const rows = await odoo.searchRead("resource.calendar.leaves",
    [["resource_id", "=", false], ["time_type", "=", "leave"]],
    ["name", "date_from", "date_to"]);
  return rows
    .map((r) => ({
      id: r.id,
      name: String(r.name || "").trim(),
      date_from: String(r.date_from || "").slice(0, 10),
      date_to: String(r.date_to || r.date_from || "").slice(0, 10),
    }))
    .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date_from));
}

function shapePeople(list) {
  return list
    .filter((p) => p.dept && !EXCLUDED_DEPTS.includes(p.dept))       // must have a department
    .filter((p) => !/^Template_|^OdooBot$/i.test(p.name))            // template/bot rows
    .map((p) => ({ ...p, type: personType(p), active: true }));
}

/** Employee vs contractor comes from the HR record's Employee Type selection
 *  (hr.employee.employee_type: employee / contractor / freelance / …). Older
 *  databases without that field fall back to the historical rule — membership
 *  of the "Contractor" department. TBA pools are app-side and unaffected. */
function personType(p) {
  const t = String(p.employeeType || "").trim().toLowerCase();
  if (t) return (t === "contractor" || t === "freelance") ? "contractor" : "employee";
  return isContractor(p.dept) ? "contractor" : "employee";
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

/** Open pipeline: opportunities that are neither Won nor Lost. Also carries the
 *  CRM planning window (expected start / projected months — Studio fields, so
 *  their presence is verified rather than assumed) for forecast cross-checks. */
async function readOpportunities(odoo) {
  const PLAN_FIELDS = ["x_studio_expected_start_date", "x_studio_projected_number_of_months"];
  const avail = await odoo.hasFields("crm.lead", PLAN_FIELDS);
  const fields = ["name", "partner_id", "stage_id", "probability", ...PLAN_FIELDS.filter((f) => avail[f])];
  const rows = await odoo.searchRead("crm.lead",
    [["active", "=", true], ["type", "=", "opportunity"]], fields);
  return rows
    .map((r) => ({
      id: r.id,
      name: String(r.name).replace(/\s+/g, " ").trim(),
      client: m2oName(r.partner_id),
      stage: m2oName(r.stage_id),
      active: true,
      // Odoo returns false for unset fields; store null / 0 instead.
      expected_start: r.x_studio_expected_start_date || null,
      expected_months: Number(r.x_studio_projected_number_of_months) || 0,
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

/**
 * Actual timesheet hours AND realized bill rates per employee/project/month.
 *
 * The rate comes from the timesheet's linked Sales Order Item
 * (account.analytic.line.so_line -> sale.order.line.price_unit): that is the
 * price each logged hour was actually billed at. Per cell we accumulate total
 * hours, billable hours (those carrying an SO line) and billable revenue
 * Σ(hours × price_unit), then bill_rate = revenue / billable hours — the true
 * rate on billed work. Hours without an SO line are non-billable: they count in
 * `hours` but neither in revenue nor in the rate.
 */
async function readActuals(odoo, from, to) {
  const rows = await odoo.searchRead("account.analytic.line",
    [["date", ">=", from], ["date", "<", to], ["project_id", "!=", false], ["employee_id", "!=", false]],
    ["employee_id", "project_id", "date", "unit_amount", "so_line"]);

  // one batched fetch of every referenced SO line's unit price
  const solIds = [...new Set(rows.map((r) => m2oId(r.so_line)).filter(Boolean))];
  const priceBySol = new Map();
  if (solIds.length) {
    const sols = await odoo.searchRead("sale.order.line", [["id", "in", solIds]], ["price_unit"]);
    sols.forEach((s) => priceBySol.set(s.id, Number(s.price_unit) || 0));
  }

  const agg = new Map();   // key -> {hours, billable, revenue}
  for (const r of rows) {
    const h = Number(r.unit_amount) || 0;
    if (h <= 0) continue;
    const key = `${m2oId(r.employee_id)}|${m2oId(r.project_id)}|${String(r.date).slice(0, 7)}-01`;
    const a = agg.get(key) || { hours: 0, billable: 0, revenue: 0 };
    a.hours += h;
    const sol = m2oId(r.so_line);
    if (sol && priceBySol.has(sol)) { a.billable += h; a.revenue += h * priceBySol.get(sol); }
    agg.set(key, a);
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return [...agg].map(([k, a]) => {
    const [employee_id, project_id, month] = k.split("|");
    return {
      employee_id: +employee_id, project_id: +project_id, month,
      hours: r2(a.hours),
      bill_rate: a.billable > 0 ? r2(a.revenue / a.billable) : 0,
      revenue: r2(a.revenue),
    };
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
      // Never migrate revenue forecast onto a non-billable/internal project.
      const hit = bestProjectMatch({ name: opp.name, client: opp.client }, projects.filter((p) => p.billable !== false));
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
  out.ref_person = await replaceAll(db, "ref_person", people, ["id", "name", "role", "dept", "type", "active", "hire_date", "end_date"]);
  out.ref_project = await replaceAll(db, "ref_project", projects, ["id", "name", "client", "billable", "active"]);
  // Holidays feed capacity proration; an install without the resource module
  // just keeps whatever was cached rather than failing the whole sync.
  try { out.ref_holiday = await replaceAll(db, "ref_holiday", await readHolidays(odoo), ["id", "name", "date_from", "date_to"]); }
  catch (e) { out.ref_holiday = `skipped (${e.message})`; }
  out.ref_opportunity = await replaceAll(db, "ref_opportunity", opps, ["id", "name", "client", "stage", "active", "expected_start", "expected_months"]);
  if (actualsFrom && actualsTo) {
    // Keep only actuals for people/projects we actually show. Odoo returns
    // timesheet lines for everyone (incl. "Internal" admin time and non-delivery
    // staff); storing those would bloat ref_actual and inflate any totals with
    // rows nothing renders. Scope to the synced roster + project list.
    const personIds = new Set(people.map((p) => p.id));
    const projectIds = new Set(projects.map((p) => p.id));
    const actuals = (await readActuals(odoo, actualsFrom, actualsTo))
      .filter((a) => personIds.has(a.employee_id) && projectIds.has(a.project_id));
    out.ref_actual = await replaceAll(db, "ref_actual", actuals, ["employee_id", "project_id", "month", "hours", "bill_rate", "revenue"]);
  }
  // Migrate/flag forecast stranded on opportunities that have since closed. Runs
  // after the open-opp refresh so the "still open?" test uses fresh data.
  out.reconcile = await reconcileClosedCrm(db, odoo, projects, new Set(opps.map((o) => o.id)));
  return out;
}

module.exports = {
  Odoo, OdooError, syncAll, reconcileClosedCrm,
  readPeople, readProjects, readOpportunities, readOppsByIds, readActuals,
  readEmploymentDates, readHolidays,
  shapePeople, m2oName, m2oId,
};
