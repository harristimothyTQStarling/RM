"use strict";
/**
 * Gusto payroll -> fully loaded per-person monthly cost.
 *
 * Employees: for every PROCESSED payroll this year, each person's employer cost
 * is gross pay + employer-side taxes + employer benefit contributions
 * (401k match, health, etc.), attributed to the month of the check date —
 * bonuses land when paid. Contractors: contractor payments (wage + bonus;
 * reimbursements are pass-through and excluded).
 *
 * Cost model (per the design decision):
 *   - CLOSED months  -> 'actual'   : the real Gusto totals for that month.
 *   - current..Dec   -> 'standard' : a smoothed forward rate = the average of
 *     that person's last up-to-3 closed months with cost, so salary, benefits,
 *     employer taxes and recent bonus accrual are all embedded without
 *     hand-maintained assumptions.
 *
 * People are matched to the Odoo roster by normalized name (legal and
 * preferred first names both tried). Unmatched names are reported, never
 * silently dropped.
 *
 * Config (Railway variables): GUSTO_API_TOKEN (bearer), GUSTO_COMPANY_ID
 * (company uuid), optional GUSTO_API_BASE (default https://api.gusto.com).
 */
const { currentMonthStart } = require("./store");

class GustoError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

class Gusto {
  constructor(cfg = {}) {
    this.base = (cfg.base || process.env.GUSTO_API_BASE || "https://api.gusto.com").replace(/\/+$/, "");
    this.token = cfg.token || process.env.GUSTO_API_TOKEN || "";
    this.company = cfg.company || process.env.GUSTO_COMPANY_ID || "";
  }
  get configured() { return !!(this.token && this.company); }

  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GustoError(`Gusto ${res.status} on ${path}: ${body.slice(0, 300)}`, res.status);
    }
    return res.json();
  }
}

/* ------------------------------------------------------------- shaping ---- */
const num = (v) => Number(v) || 0;
const monthOf = (dateStr) => String(dateStr || "").slice(0, 7) + "-01";
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Fully loaded employer cost for one employee on one payroll. */
function employerCostOf(comp) {
  const gross = num(comp.gross_pay);
  const employerTaxes = (comp.taxes || []).filter((t) => t.employer).reduce((s, t) => s + num(t.amount), 0);
  const benefitContrib = (comp.benefits || []).reduce((s, b) => s + num(b.company_contribution), 0);
  return gross + employerTaxes + benefitContrib;
}

/** Accumulate one payroll detail into the per-person map. */
function addPayroll(acc, payroll) {
  const month = monthOf(payroll.check_date);
  for (const comp of payroll.employee_compensations || []) {
    if (comp.excluded) continue;
    const cost = employerCostOf(comp);
    if (!cost) continue;
    const key = "e:" + comp.employee_uuid;
    const cur = acc.get(key) || { names: nameVariants(comp), byMonth: new Map() };
    cur.byMonth.set(month, (cur.byMonth.get(month) || 0) + cost);
    acc.set(key, cur);
  }
}

function nameVariants(p) {
  const out = [];
  const last = p.last_name || "";
  if (p.first_name) out.push(`${p.first_name} ${last}`);
  if (p.preferred_first_name && p.preferred_first_name !== p.first_name) out.push(`${p.preferred_first_name} ${last}`);
  if (p.business_name) out.push(p.business_name);
  return out.filter(Boolean);
}

/** Accumulate contractor payments (wage + bonus; not reimbursements). */
function addContractorPayments(acc, paymentGroups, contractorsByUuid) {
  for (const grp of paymentGroups || []) {
    for (const pay of grp.payments || []) {
      const cost = num(pay.wage) + num(pay.bonus);
      if (!cost) continue;
      const key = "c:" + grp.contractor_uuid;
      const c = contractorsByUuid.get(grp.contractor_uuid) || {};
      const cur = acc.get(key) || { names: nameVariants(c), byMonth: new Map() };
      const m = monthOf(pay.date);
      cur.byMonth.set(m, (cur.byMonth.get(m) || 0) + cost);
      acc.set(key, cur);
    }
  }
}

/**
 * Turn the per-Gusto-person actuals into ref_cost rows against the Odoo roster.
 * Closed months -> 'actual'; current month..December -> 'standard' (trailing
 * average of the last up-to-3 closed months with cost).
 */
function buildCostRows(acc, people, current = currentMonthStart()) {
  const year = current.slice(0, 4);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  const closed = months.filter((m) => m < current);
  const forward = months.filter((m) => m >= current);

  const byNorm = new Map();
  for (const p of people) byNorm.set(normName(p.name), p.id);

  const rows = [];
  const unmatched = [];
  let matched = 0;

  for (const person of acc.values()) {
    const id = person.names.map((n) => byNorm.get(normName(n))).find((x) => x != null);
    if (id == null) { unmatched.push(person.names[0] || "(unnamed)"); continue; }
    matched++;

    for (const m of closed) {
      const cost = person.byMonth.get(m);
      if (cost) rows.push({ employee_id: id, month: m, cost: Math.round(cost * 100) / 100, kind: "actual" });
    }
    const recent = closed.filter((m) => person.byMonth.get(m)).slice(-3);
    if (recent.length) {
      const rate = Math.round(recent.reduce((s, m) => s + person.byMonth.get(m), 0) / recent.length * 100) / 100;
      for (const m of forward) rows.push({ employee_id: id, month: m, cost: rate, kind: "standard" });
    }
  }
  return { rows, unmatched, matched };
}

/* ---------------------------------------------------------------- sync ---- */
async function syncCosts(db, g = new Gusto()) {
  if (!g.configured) throw new GustoError("Gusto is not configured (GUSTO_API_TOKEN / GUSTO_COMPANY_ID)", 0);
  const year = new Date().getUTCFullYear();
  const from = `${year}-01-01`;
  const to = new Date().toISOString().slice(0, 10);

  // Every processed payroll with a check date this year (paginated).
  const payrolls = [];
  for (let page = 1; page < 30; page++) {
    const batch = await g.get(`/v1/companies/${g.company}/payrolls`, {
      processing_statuses: "processed", start_date: from, end_date: to,
      date_filter_by: "check_date", per: 100, page,
    });
    const list = Array.isArray(batch) ? batch : (batch.payrolls || []);
    payrolls.push(...list);
    if (list.length < 100) break;
  }

  const acc = new Map();
  for (const p of payrolls) {
    const uuid = p.payroll_uuid || p.uuid;
    if (!uuid) continue;
    // employee_compensations can be paginated; loop until the server says done
    for (let page = 1; page < 20; page++) {
      const detail = await g.get(`/v1/companies/${g.company}/payrolls/${uuid}`, {
        include: "taxes,benefits", employee_compensations_page: page, employee_compensations_per: 100,
      });
      addPayroll(acc, detail);
      if (!(detail.employee_compensations_pagination && detail.employee_compensations_pagination.has_more)) break;
    }
  }

  // Contractors: names first, then this year's payments.
  const contractorsRaw = await g.get(`/v1/companies/${g.company}/contractors`, { per: 200 });
  const contractors = Array.isArray(contractorsRaw) ? contractorsRaw : (contractorsRaw.contractors || []);
  const contractorsByUuid = new Map(contractors.map((c) => [c.uuid, c]));
  const paymentsRaw = await g.get(`/v1/companies/${g.company}/contractor_payments`, { start_date: from, end_date: to });
  addContractorPayments(acc, paymentsRaw.contractor_payments || [], contractorsByUuid);

  const people = await db.all("SELECT id, name FROM ref_person WHERE active = 1");
  const { rows, unmatched, matched } = buildCostRows(acc, people);

  await db.tx(async () => {
    await db.run("DELETE FROM ref_cost");
    for (const r of rows) {
      await db.run("INSERT INTO ref_cost (employee_id, month, cost, kind) VALUES (?,?,?,?)",
        [r.employee_id, r.month, r.cost, r.kind]);
    }
    await db.run("DELETE FROM sync_state WHERE source = 'gusto'");
    await db.run("INSERT INTO sync_state (source, synced_at, row_count, ok, message) VALUES ('gusto', ?, ?, 1, ?)",
      [new Date().toISOString(), rows.length, JSON.stringify({ matched, unmatched: unmatched.slice(0, 40) }).slice(0, 1000)]);
  });

  return { rows: rows.length, matched, unmatched: unmatched.length, payrolls: payrolls.length };
}

module.exports = { Gusto, GustoError, syncCosts, buildCostRows, employerCostOf, addPayroll, addContractorPayments, nameVariants };
