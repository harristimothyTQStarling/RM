"use strict";
/**
 * Plan storage. This is where multi-user correctness lives.
 *
 * Optimistic concurrency contract for every write:
 *   client sends the `version` it last read
 *     version === 0            -> "I believe this cell is empty"  -> insert
 *     version === row.version  -> "I'm editing what I last saw"   -> update, version+1
 *     otherwise                -> somebody changed it underneath  -> CONFLICT
 *
 * On conflict we return the CURRENT row rather than throwing it away, so the UI
 * can show "Jane set this to 120 while you were editing" instead of silently
 * clobbering her — the failure mode that destroys trust in a shared planner.
 */
const { nowIso, audit } = require("./db");

class Conflict extends Error {
  constructor(current) { super("version conflict"); this.code = "conflict"; this.current = current; }
}
class PastMonth extends Error {
  constructor(month) { super(`month ${month} is closed — past months carry Odoo actuals, not forecast`); this.code = "past_month"; }
}

const monthKey = (m) => String(m).length === 7 ? `${m}-01` : String(m).slice(0, 10);
/* First day of the current month (UTC — Railway runs UTC and Odoo actuals are
   aggregated by calendar month). Everything before this is closed. */
const currentMonthStart = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

/* ---------------------------------------------------------------- read plan -- */
async function getPlan(db, scenario = "baseline") {
  // Non-billable projects (internal/non-billable time buckets from Odoo) are
  // hidden from the app entirely: rows that target one are filtered out of every
  // read. The underlying data stays in the tables, so this is reversible.
  const notNonBillable = "NOT EXISTS (SELECT 1 FROM ref_project np WHERE np.billable = 0 AND target_key = 'prj:' || np.id)";
  const [allocations, capacity, tbh, importMap, rates, proposed] = await Promise.all([
    db.all(`SELECT resource_key, target_key, month, hours, version, updated_by, updated_at FROM allocation WHERE scenario = ? AND ${notNonBillable}`, [scenario]),
    db.all("SELECT resource_key, hours_per_month, version FROM capacity_override WHERE scenario = ?", [scenario]),
    db.all("SELECT tbh_key, name, role, dept, shore, start_month, capacity, version FROM tbh WHERE scenario = ?", [scenario]),
    db.all("SELECT kind, source_name, target_key FROM import_map WHERE scenario = ?", [scenario]),
    db.all(`SELECT resource_key, target_key, rate, version FROM bill_rate WHERE scenario = ? AND ${notNonBillable}`, [scenario]),
    db.all(`SELECT resource_key, target_key, name FROM proposed_hire WHERE scenario = ? AND ${notNonBillable}`, [scenario]),
  ]);
  return {
    scenario,
    allocations: allocations.map(r => ({
      resourceKey: r.resource_key, targetKey: r.target_key,
      month: String(r.month).slice(0, 7), hours: Number(r.hours),
      version: r.version, updatedBy: r.updated_by, updatedAt: String(r.updated_at),
    })),
    capacity: capacity.map(r => ({ resourceKey: r.resource_key, hoursPerMonth: Number(r.hours_per_month), version: r.version })),
    rates: rates.map(r => ({ resourceKey: r.resource_key, targetKey: r.target_key, rate: Number(r.rate), version: r.version })),
    tbh: tbh.map(r => ({
      tbhKey: r.tbh_key, name: r.name, role: r.role, dept: r.dept, shore: r.shore || "onshore",
      start: r.start_month ? String(r.start_month).slice(0, 7) : null,
      cap: r.capacity == null ? null : Number(r.capacity), version: r.version,
    })),
    importMap: importMap.reduce((acc, r) => { (acc[r.kind] ||= {})[r.source_name] = r.target_key; return acc; }, { person: {}, project: {} }),
    proposed: proposed.map(r => ({ resourceKey: r.resource_key, targetKey: r.target_key, name: r.name })),
  };
}

/* --------------------------------------------------------- proposed hires -- */
/** Candidate name pinned to one (TBA pool × project) pair. Free text — the
 *  person usually doesn't exist in Odoo yet. Blank name clears the entry.
 *  Last-write-wins (it's a note, not plan data), but every change is audited. */
async function putProposedHire(db, user, p) {
  const scenario = p.scenario || "baseline";
  const name = String(p.name || "").trim();
  const cur = await db.get("SELECT id, name FROM proposed_hire WHERE scenario=? AND resource_key=? AND target_key=?",
    [scenario, p.resourceKey, p.targetKey]);
  const key = `${scenario}|${p.resourceKey}|${p.targetKey}`;
  if (!name) {
    if (cur) { await db.run("DELETE FROM proposed_hire WHERE id=?", [cur.id]); await audit(db, user.upn, "proposed", key, "delete", cur.name, null); }
    return { cleared: true };
  }
  if (cur) {
    if (cur.name !== name) {
      await db.run("UPDATE proposed_hire SET name=?, updated_by=?, updated_at=? WHERE id=?", [name, user.upn, nowIso(), cur.id]);
      await audit(db, user.upn, "proposed", key, "update", cur.name, name);
    }
  } else {
    await db.run("INSERT INTO proposed_hire (scenario, resource_key, target_key, name, updated_by, updated_at) VALUES (?,?,?,?,?,?)",
      [scenario, p.resourceKey, p.targetKey, name, user.upn, nowIso()]);
    await audit(db, user.upn, "proposed", key, "insert", null, name);
  }
  return { name };
}

/* ------------------------------------------------- milestone billing plan -- */
/** Place a synced milestone's revenue in a forecast month (null clears it). */
async function putMilestoneMonth(db, user, m) {
  const id = Number(m.milestoneId);
  const ms = await db.get("SELECT id, name FROM ref_milestone WHERE id = ?", [id]);
  if (!ms) { const e = new Error("no such milestone"); e.code = "bad_request"; throw e; }
  const cur = await db.get("SELECT milestone_id, month FROM milestone_month WHERE milestone_id = ?", [id]);
  const old = cur ? String(cur.month).slice(0, 7) : null;
  if (!m.month) {
    if (cur) { await db.run("DELETE FROM milestone_month WHERE milestone_id = ?", [id]);
      await audit(db, user.upn, "milestone", String(id), "unschedule", old, null); }
    return { month: null };
  }
  const month = monthKey(m.month);
  if (cur) await db.run("UPDATE milestone_month SET month=?, updated_by=?, updated_at=? WHERE milestone_id=?", [month, user.upn, nowIso(), id]);
  else await db.run("INSERT INTO milestone_month (milestone_id, month, updated_by, updated_at) VALUES (?,?,?,?)", [id, month, user.upn, nowIso()]);
  if (old !== month.slice(0, 7)) await audit(db, user.upn, "milestone", String(id), "schedule", old, month.slice(0, 7));
  return { month: month.slice(0, 7) };
}

/** Force a target's billing type ('tm' | 'milestone'); null returns to auto. */
async function putBillingType(db, user, b) {
  const key = String(b.targetKey || "");
  if (!/^(prj|crm):\d+$/.test(key)) { const e = new Error("targetKey must be prj:<id> or crm:<id>"); e.code = "bad_request"; throw e; }
  const btype = b.btype == null ? null : String(b.btype);
  if (btype !== null && btype !== "tm" && btype !== "milestone") { const e = new Error("btype must be 'tm', 'milestone' or null"); e.code = "bad_request"; throw e; }
  const cur = await db.get("SELECT target_key, btype FROM billing_override WHERE target_key = ?", [key]);
  if (btype === null) {
    if (cur) { await db.run("DELETE FROM billing_override WHERE target_key = ?", [key]);
      await audit(db, user.upn, "billing", key, "auto", cur.btype, null); }
    return { btype: null };
  }
  if (cur) await db.run("UPDATE billing_override SET btype=?, updated_by=?, updated_at=? WHERE target_key=?", [btype, user.upn, nowIso(), key]);
  else await db.run("INSERT INTO billing_override (target_key, btype, updated_by, updated_at) VALUES (?,?,?,?)", [key, btype, user.upn, nowIso()]);
  if (!cur || cur.btype !== btype) await audit(db, user.upn, "billing", key, "override", cur ? cur.btype : null, btype);
  return { btype };
}

/* ------------------------------------------------------- reference (Odoo) -- */
/**
 * The Odoo-derived reference data the UI renders against: who exists, what they
 * can be staffed on, and what actually happened in closed months.
 *
 * Actuals are returned SEPARATELY from allocations and are never written to the
 * plan tables. Past months are a fact from Odoo, not something anyone forecasts —
 * keeping them apart is what stops the plan being polluted with history.
 */
async function getReference(db) {
  // Non-billable projects (and their timesheet actuals) are hidden from the app
  // — see getPlan. Their rows stay cached so the filter is reversible.
  const [people, projects, opportunities, actuals, holidays, sync, milestones, overrides] = await Promise.all([
    db.all("SELECT id, name, role, dept, type, hire_date, end_date FROM ref_person WHERE active = 1 ORDER BY name"),
    db.all("SELECT id, name, client, billable, billing_type FROM ref_project WHERE active = 1 AND billable = 1 ORDER BY name"),
    db.all("SELECT id, name, client, stage, needs_project, expected_start, expected_months FROM ref_opportunity WHERE active = 1 ORDER BY name"),
    db.all("SELECT employee_id, project_id, month, hours, bill_rate, revenue FROM ref_actual a WHERE NOT EXISTS (SELECT 1 FROM ref_project np WHERE np.billable = 0 AND np.id = a.project_id)"),
    db.all("SELECT id, name, date_from, date_to FROM ref_holiday ORDER BY date_from"),
    db.all("SELECT source, synced_at, row_count, ok, message FROM sync_state"),
    db.all("SELECT m.id, m.project_id, m.name, m.amount, m.reached, mm.month FROM ref_milestone m LEFT JOIN milestone_month mm ON mm.milestone_id = m.id ORDER BY m.id"),
    db.all("SELECT target_key, btype FROM billing_override"),
  ]);
  return {
    people: people.map(p => ({
      id: p.id, name: p.name, role: p.role || "", dept: p.dept || "", type: p.type,
      hireDate: p.hire_date ? String(p.hire_date).slice(0, 10) : null,
      endDate: p.end_date ? String(p.end_date).slice(0, 10) : null,
    })),
    holidays: holidays.map(h => ({
      name: h.name || "", from: String(h.date_from).slice(0, 10), to: String(h.date_to || h.date_from).slice(0, 10),
    })),
    // Effective billing type = editor override, else what the sync detected.
    projects: projects.map(p => {
      const ov = overrides.find(o => o.target_key === `prj:${p.id}`);
      return { id: p.id, name: p.name, client: p.client || "", billable: !!p.billable,
        billingType: (ov && ov.btype) || p.billing_type || "tm" };
    }),
    milestones: milestones.map(m => ({
      id: m.id, projectId: m.project_id, name: m.name || "", amount: Number(m.amount) || 0,
      reached: !!m.reached, month: m.month ? String(m.month).slice(0, 7) : null,
    })),
    billingOverrides: overrides.reduce((acc, o) => { acc[o.target_key] = o.btype; return acc; }, {}),
    opportunities: opportunities.map(o => {
      const ov = overrides.find(x => x.target_key === `crm:${o.id}`);
      return {
        id: o.id, name: o.name, client: o.client || "", stage: o.stage || "", needsProject: !!o.needs_project,
        expectedStart: o.expected_start ? String(o.expected_start).slice(0, 7) : null,   // YYYY-MM
        expectedMonths: Number(o.expected_months) || 0,
        billingType: (ov && ov.btype) || "tm",   // no SO yet, so only an override can mark it
      };
    }),
    actuals: actuals.map(a => ({
      employeeId: a.employee_id, projectId: a.project_id,
      month: String(a.month).slice(0, 7), hours: Number(a.hours),
      billRate: Number(a.bill_rate) || 0, revenue: Number(a.revenue) || 0,
    })),
    sync: sync.map(s => ({ source: s.source, at: String(s.synced_at), rows: s.row_count, ok: !!s.ok, message: s.message })),
  };
}

/* -------------------------------------------------------- write allocation -- */
/** hours === 0 deletes the row: an empty cell and a 0h cell are the same thing. */
async function putAllocation(db, user, a) {
  const scenario = a.scenario || "baseline";
  const month = monthKey(a.month);
  // Closed months are actuals territory: the UI locks them, and this guard stops a
  // stale page (opened before the month rolled over) from writing them anyway.
  // Server-side moves (reassignAllocations) bypass this deliberately — migrating a
  // closed opportunity must carry its full history.
  if (month < currentMonthStart()) throw new PastMonth(month.slice(0, 7));
  const hours = Number(a.hours) || 0;
  const expected = Number.isFinite(a.version) ? Number(a.version) : 0;

  const cur = await db.get(
    "SELECT id, hours, version FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
    [scenario, a.resourceKey, a.targetKey, month]
  );

  if (!cur) {
    if (expected !== 0) throw new Conflict(null);                 // caller thought a row existed; it's gone
    if (hours === 0) return { deleted: true, version: 0 };        // nothing to do
    await db.run(
      "INSERT INTO allocation (scenario, resource_key, target_key, month, hours, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,?,1)",
      [scenario, a.resourceKey, a.targetKey, month, hours, user.upn, nowIso()]
    );
    await audit(db, user.upn, "allocation", `${scenario}|${a.resourceKey}|${a.targetKey}|${month}`, "insert", null, hours);
    return { version: 1, hours };
  }

  if (cur.version !== expected) {
    throw new Conflict({ hours: Number(cur.hours), version: cur.version });
  }

  if (hours === 0) {
    await db.run("DELETE FROM allocation WHERE id=?", [cur.id]);
    await audit(db, user.upn, "allocation", `${scenario}|${a.resourceKey}|${a.targetKey}|${month}`, "delete", cur.hours, null);
    return { deleted: true, version: 0 };
  }

  const next = cur.version + 1;
  const r = await db.run(
    "UPDATE allocation SET hours=?, updated_by=?, updated_at=?, version=? WHERE id=? AND version=?",
    [hours, user.upn, nowIso(), next, cur.id, expected]
  );
  if (!r.changes) throw new Conflict(null);   // lost a race between SELECT and UPDATE
  await audit(db, user.upn, "allocation", `${scenario}|${a.resourceKey}|${a.targetKey}|${month}`, "update", cur.hours, hours);
  return { version: next, hours };
}

/** Batch write (bulk allocate / forecast import). Atomic: all or nothing, so a
 *  conflict midway can't leave half an import applied. */
async function putAllocations(db, user, items) {
  return db.tx(async () => {
    // Sequential, not Promise.all: writes must be ordered and a conflict must
    // stop the batch immediately so the transaction rolls back cleanly.
    const out = [];
    for (const it of items) out.push(await putAllocation(db, user, it));
    return out;
  });
}

/* --------------------------------------------------- move a target's plan -- */
/**
 * Move every allocation from one target_key to another, keeping the forecast.
 * Used when a closed CRM opportunity is matched to its delivery project
 * (crm:222 -> prj:119); also the primitive a manual "map to project" would call.
 *
 * If the destination already has a row for the same (scenario, resource, month) —
 * someone forecast against the real project too — the hours are SUMMED into it and
 * the source row deleted, rather than dropped: losing forecast is worse than a
 * rare double-count, and every move is audited so it can be traced. Runs in one
 * transaction so a mid-move failure leaves the plan wholly on the old key.
 *
 * Bill rates and proposed-hire notes are keyed per (resource, target) pair, so
 * they must move with the plan — left behind on the retired key, the migrated
 * forecast silently prices at $0. Where the destination pair already has its own
 * row, that one wins (it was set deliberately against the real project) and the
 * stranded source row is removed.
 */
async function reassignAllocations(db, user, fromKey, toKey) {
  if (fromKey === toKey) return { moved: 0, merged: 0 };
  return db.tx(async () => {
    const rows = await db.all(
      "SELECT id, scenario, resource_key, month, hours FROM allocation WHERE target_key = ?",
      [fromKey]
    );
    let moved = 0, merged = 0;
    for (const r of rows) {
      const dst = await db.get(
        "SELECT id, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
        [r.scenario, r.resource_key, toKey, r.month]
      );
      const key = `${r.scenario}|${r.resource_key}|${toKey}|${String(r.month).slice(0, 7)}`;
      if (dst) {
        const sum = Number(dst.hours) + Number(r.hours);
        await db.run("UPDATE allocation SET hours=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?",
          [sum, user.upn, nowIso(), dst.id]);
        await db.run("DELETE FROM allocation WHERE id=?", [r.id]);
        await audit(db, user.upn, "allocation", key, "merge", r.hours, sum);
        merged++;
      } else {
        await db.run("UPDATE allocation SET target_key=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?",
          [toKey, user.upn, nowIso(), r.id]);
        await audit(db, user.upn, "allocation", key, "reassign", fromKey, toKey);
      }
      moved++;
    }
    const rates = await db.all("SELECT id, scenario, resource_key, rate FROM bill_rate WHERE target_key = ?", [fromKey]);
    let ratesMoved = 0;
    for (const r of rates) {
      const dst = await db.get("SELECT id FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?",
        [r.scenario, r.resource_key, toKey]);
      if (dst) {
        await db.run("DELETE FROM bill_rate WHERE id=?", [r.id]);
      } else {
        await db.run("UPDATE bill_rate SET target_key=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?",
          [toKey, user.upn, nowIso(), r.id]);
        await audit(db, user.upn, "rate", `${r.scenario}|${r.resource_key}|${toKey}`, "reassign", fromKey, toKey);
        ratesMoved++;
      }
    }
    const props = await db.all("SELECT id, scenario, resource_key FROM proposed_hire WHERE target_key = ?", [fromKey]);
    for (const pr of props) {
      const dst = await db.get("SELECT id FROM proposed_hire WHERE scenario=? AND resource_key=? AND target_key=?",
        [pr.scenario, pr.resource_key, toKey]);
      if (dst) await db.run("DELETE FROM proposed_hire WHERE id=?", [pr.id]);
      else await db.run("UPDATE proposed_hire SET target_key=?, updated_by=?, updated_at=? WHERE id=?", [toKey, user.upn, nowIso(), pr.id]);
    }
    const bov = await db.get("SELECT target_key, btype FROM billing_override WHERE target_key = ?", [fromKey]);
    if (bov) {
      const dst = await db.get("SELECT target_key FROM billing_override WHERE target_key = ?", [toKey]);
      if (dst) await db.run("DELETE FROM billing_override WHERE target_key = ?", [fromKey]);
      else await db.run("UPDATE billing_override SET target_key=?, updated_by=?, updated_at=? WHERE target_key=?", [toKey, user.upn, nowIso(), fromKey]);
    }
    return { moved, merged, ratesMoved };
  });
}

/**
 * Manually map a closed CRM opportunity to a delivery project: the human override
 * for when the sync's matcher wasn't confident (or the names simply differ). Moves
 * the forecast crm:<oppId> -> prj:<projectId>, then retires the opportunity from
 * the reference cache (active=0) so it leaves the UI — its forecast now lives on
 * the project. Not wrapped in an outer transaction because reassignAllocations
 * runs its own, and SQLite has no nested transactions; a failure between the two
 * steps is self-healing (the next sync re-flags an opp that still has allocations).
 */
async function mapOpportunityToProject(db, user, oppId, projectId) {
  const out = await reassignAllocations(db, user, `crm:${oppId}`, `prj:${projectId}`);
  await db.run("UPDATE ref_opportunity SET active = 0, needs_project = 0 WHERE id = ?", [oppId]);
  await audit(db, user.upn, "opportunity", `crm:${oppId}`, "map", `crm:${oppId}`, `prj:${projectId}`);
  return { ...out, from: `crm:${oppId}`, to: `prj:${projectId}` };
}

/* ---------------------------------------------------------------- capacity -- */
async function putCapacity(db, user, c) {
  const scenario = c.scenario || "baseline";
  const expected = Number.isFinite(c.version) ? Number(c.version) : 0;
  const cur = await db.get("SELECT id, hours_per_month, version FROM capacity_override WHERE scenario=? AND resource_key=?", [scenario, c.resourceKey]);
  if (!cur) {
    if (expected !== 0) throw new Conflict(null);
    if (c.hoursPerMonth == null) return { deleted: true, version: 0 };
    await db.run("INSERT INTO capacity_override (scenario, resource_key, hours_per_month, updated_by, updated_at, version) VALUES (?,?,?,?,?,1)",
      [scenario, c.resourceKey, Number(c.hoursPerMonth), user.upn, nowIso()]);
    await audit(db, user.upn, "capacity", `${scenario}|${c.resourceKey}`, "insert", null, c.hoursPerMonth);
    return { version: 1 };
  }
  if (cur.version !== expected) throw new Conflict({ hoursPerMonth: Number(cur.hours_per_month), version: cur.version });
  if (c.hoursPerMonth == null) {
    await db.run("DELETE FROM capacity_override WHERE id=?", [cur.id]);
    await audit(db, user.upn, "capacity", `${scenario}|${c.resourceKey}`, "delete", cur.hours_per_month, null);
    return { deleted: true, version: 0 };
  }
  const next = cur.version + 1;
  await db.run("UPDATE capacity_override SET hours_per_month=?, updated_by=?, updated_at=?, version=? WHERE id=? AND version=?",
    [Number(c.hoursPerMonth), user.upn, nowIso(), next, cur.id, expected]);
  await audit(db, user.upn, "capacity", `${scenario}|${c.resourceKey}`, "update", cur.hours_per_month, c.hoursPerMonth);
  return { version: next };
}

/* --------------------------------------------------------------- bill rate -- */
/** One $/hr rate per (resource, target) pair — not per month. rate null/0
 *  deletes the row: an unpriced line and a $0 line are the same thing. */
async function putRate(db, user, b) {
  const scenario = b.scenario || "baseline";
  const rate = Number(b.rate) || 0;
  const expected = Number.isFinite(b.version) ? Number(b.version) : 0;
  const cur = await db.get("SELECT id, rate, version FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?",
    [scenario, b.resourceKey, b.targetKey]);
  const key = `${scenario}|${b.resourceKey}|${b.targetKey}`;
  if (!cur) {
    if (expected !== 0) throw new Conflict(null);
    if (rate === 0) return { deleted: true, version: 0 };
    await db.run("INSERT INTO bill_rate (scenario, resource_key, target_key, rate, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,1)",
      [scenario, b.resourceKey, b.targetKey, rate, user.upn, nowIso()]);
    await audit(db, user.upn, "rate", key, "insert", null, rate);
    return { version: 1, rate };
  }
  if (cur.version !== expected) throw new Conflict({ rate: Number(cur.rate), version: cur.version });
  if (rate === 0) {
    await db.run("DELETE FROM bill_rate WHERE id=?", [cur.id]);
    await audit(db, user.upn, "rate", key, "delete", cur.rate, null);
    return { deleted: true, version: 0 };
  }
  const next = cur.version + 1;
  const r = await db.run("UPDATE bill_rate SET rate=?, updated_by=?, updated_at=?, version=? WHERE id=? AND version=?",
    [rate, user.upn, nowIso(), next, cur.id, expected]);
  if (!r.changes) throw new Conflict(null);
  await audit(db, user.upn, "rate", key, "update", cur.rate, rate);
  return { version: next, rate };
}

/* --------------------------------------------------------------------- tbh -- */
async function putTbh(db, user, t) {
  const scenario = t.scenario || "baseline";
  const start = t.start ? monthKey(t.start) : null;
  const shore = normShore(t.shore);
  const cur = await db.get("SELECT id, version FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, t.tbhKey]);
  if (!cur) {
    await db.run("INSERT INTO tbh (scenario, tbh_key, name, role, dept, shore, start_month, capacity, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
      [scenario, t.tbhKey, t.name, t.role || "", t.dept || "", shore, start, t.cap == null ? null : Number(t.cap), user.upn, nowIso()]);
    await audit(db, user.upn, "tbh", `${scenario}|${t.tbhKey}`, "insert", null, t.name);
    return { version: 1 };
  }
  const next = cur.version + 1;
  await db.run("UPDATE tbh SET name=?, role=?, dept=?, shore=?, start_month=?, capacity=?, updated_by=?, updated_at=?, version=? WHERE id=?",
    [t.name, t.role || "", t.dept || "", shore, start, t.cap == null ? null : Number(t.cap), user.upn, nowIso(), next, cur.id]);
  await audit(db, user.upn, "tbh", `${scenario}|${t.tbhKey}`, "update", null, t.name);
  return { version: next };
}

/** Removing a TBH must take its allocations with it, or they become orphans
 *  that still count toward demand with nobody to do the work. */
async function deleteTbh(db, user, tbhKey, scenario = "baseline") {
  return db.tx(async () => {
    await db.run("DELETE FROM allocation WHERE scenario=? AND resource_key=?", [scenario, `tbh:${tbhKey}`]);
    await db.run("DELETE FROM capacity_override WHERE scenario=? AND resource_key=?", [scenario, `tbh:${tbhKey}`]);
    await db.run("DELETE FROM bill_rate WHERE scenario=? AND resource_key=?", [scenario, `tbh:${tbhKey}`]);
    await db.run("DELETE FROM proposed_hire WHERE scenario=? AND resource_key=?", [scenario, `tbh:${tbhKey}`]);
    const r = await db.run("DELETE FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, tbhKey]);
    await audit(db, user.upn, "tbh", `${scenario}|${tbhKey}`, "delete", null, null);
    return { deleted: r.changes > 0 };
  });
}

/* --------------------------------------------- TBA role pools (normalize) -- */
/* Shore is part of a pool's identity: "Technical Consultant (Onshore)" and
   "(Offshore)" are different roles with different pools. */
const normShore = (s) => String(s || "").trim().toLowerCase() === "offshore" ? "offshore" : "onshore";
const roleSlug = (role, shore) => {
  const s = String(role || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return "tba-" + (s || "unassigned") + "-" + normShore(shore);
};
const tbaName = (role, shore) => "TBA - " + (String(role || "").trim() || "Unassigned") + (normShore(shore) === "offshore" ? " (Offshore)" : " (Onshore)");
/* A deliberate extra seat of a role: "<role slug>-<n>", n >= 2 — a base slug
   always ends in the shore word, so a trailing number can only mean a seat. */
const seatNo = (key, slug) => { const m = String(key).match(new RegExp("^" + slug + "-(\\d+)$")); return m ? Number(m[1]) : 0; };

/**
 * To-Be-Assigned model: unstaffed demand lives against the ROLE, not a named
 * seat — ONE pool per role, named "TBA - <role>", with no capacity or start
 * month of its own (demand-only). Deliberately numbered extra seats of a role
 * ("<slug>-2", named "TBA - <role> #2") are first-class pools too, so a project
 * can carry several open positions of the same role side by side. This
 * normalizer converts historical To-Be-Hired seats: every tbh row is renamed to
 * the pool convention and rows sharing a role are MERGED into the canonical
 * pool — EXCEPT numbered seats, which are preserved (only their name and
 * demand-only shape are enforced). Allocations move onto the pool's key
 * (summing where both had hours on the same project/month), bill rates carry
 * over where the pool has none, capacity overrides are dropped. Idempotent;
 * runs at every boot and is a no-op once normalized.
 */
async function normalizeTbaPools(db) {
  /* Move every allocation and bill rate from one resource key onto another,
     summing allocation collisions and letting existing destination rates win —
     a blanket key-update would trip the UNIQUE constraints when both keys hold
     the same project/month. */
  async function mergeResource(scenario, fromKey, toKey) {
    const allocs = await db.all("SELECT id, target_key, month, hours FROM allocation WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
    for (const a of allocs) {
      const dst = await db.get("SELECT id, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
        [scenario, toKey, a.target_key, a.month]);
      if (dst) {
        await db.run("UPDATE allocation SET hours=?, version=version+1 WHERE id=?", [Number(dst.hours) + Number(a.hours), dst.id]);
        await db.run("DELETE FROM allocation WHERE id=?", [a.id]);
      } else {
        await db.run("UPDATE allocation SET resource_key=? WHERE id=?", [toKey, a.id]);
      }
    }
    const rates = await db.all("SELECT id, target_key FROM bill_rate WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
    for (const r of rates) {
      const dst = await db.get("SELECT id FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, toKey, r.target_key]);
      if (!dst) await db.run("UPDATE bill_rate SET resource_key=? WHERE id=?", [toKey, r.id]);
      else await db.run("DELETE FROM bill_rate WHERE id=?", [r.id]);
    }
    const props = await db.all("SELECT id, target_key FROM proposed_hire WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
    for (const r of props) {
      const dst = await db.get("SELECT id FROM proposed_hire WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, toKey, r.target_key]);
      if (!dst) await db.run("UPDATE proposed_hire SET resource_key=? WHERE id=?", [toKey, r.id]);
      else await db.run("DELETE FROM proposed_hire WHERE id=?", [r.id]);
    }
    await db.run("DELETE FROM capacity_override WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
  }

  return db.tx(async () => {
    const out = { merged: 0, renamed: 0 };
    const rows = await db.all("SELECT id, scenario, tbh_key, name, role, dept, shore, start_month, capacity FROM tbh ORDER BY id");
    // Historical rows carry no shore ('') — classify by the seat's average bill
    // rate: under $100/hr reads as offshore, otherwise onshore.
    for (const r of rows) {
      if (r.shore === "onshore" || r.shore === "offshore") continue;
      const avg = await db.get("SELECT AVG(rate) AS a FROM bill_rate WHERE scenario=? AND resource_key=?", [r.scenario, `tbh:${r.tbh_key}`]);
      r.shore = (avg && avg.a != null && Number(avg.a) < 100) ? "offshore" : "onshore";
    }
    const groups = new Map();   // scenario|slug(role+shore) -> [rows]
    for (const r of rows) {
      const slug = roleSlug(r.role, r.shore);
      const n = seatNo(r.tbh_key, slug);
      if (n >= 2) {
        // A numbered seat is already canonical — never merged, just kept in shape.
        const wantName = tbaName(r.role, r.shore) + " #" + n;
        if (r.name !== wantName || r.shore !== normShore(r.shore) || r.start_month != null || r.capacity != null) {
          await db.run("DELETE FROM capacity_override WHERE scenario=? AND resource_key=?", [r.scenario, `tbh:${r.tbh_key}`]);
          await db.run("UPDATE tbh SET name=?, shore=?, start_month=NULL, capacity=NULL WHERE id=?", [wantName, normShore(r.shore), r.id]);
          out.renamed++;
        }
        continue;
      }
      const key = `${r.scenario}|${slug}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, members] of groups) {
      const scenario = key.slice(0, key.lastIndexOf("|"));
      const slug = key.slice(key.lastIndexOf("|") + 1);
      // Prefer an existing row already keyed canonically; else the oldest member.
      const canon = members.find((m) => m.tbh_key === slug) || members[0];
      const canonKey = `tbh:${slug}`;
      // 1. put the canonical row on the pool key/name, demand-only
      const wantName = tbaName(canon.role, canon.shore);
      if (canon.tbh_key !== slug || canon.name !== wantName || canon.start_month != null || canon.capacity != null) {
        if (canon.tbh_key !== slug) await mergeResource(scenario, `tbh:${canon.tbh_key}`, canonKey);
        else await db.run("DELETE FROM capacity_override WHERE scenario=? AND resource_key=?", [scenario, canonKey]);
        await db.run("UPDATE tbh SET tbh_key=?, name=?, shore=?, start_month=NULL, capacity=NULL WHERE id=?", [slug, wantName, canon.shore, canon.id]);
        out.renamed++;
      }
      // 2. fold every other member of the (role, shore) group into the pool
      for (const m of members) {
        if (m.id === canon.id) continue;
        await mergeResource(scenario, `tbh:${m.tbh_key}`, canonKey);
        await db.run("DELETE FROM tbh WHERE id=?", [m.id]);
        out.merged++;
      }
    }
    return out;
  });
}

/* ------------------------------------- transfer hours between resources -- */
/**
 * Move all or part of one (resource × project) pair's forecast to another
 * resource — person to person, person to TBA pool, pool to person, any mix.
 * moves: [{month:'YYYY-MM', hours}] — per-month amounts, each capped by what the
 * source actually has; the remainder stays behind. Destination cells sum. Only
 * open months are transferable (closed months are actuals territory). The
 * source pair's bill rate is COPIED to the destination pair where it has none
 * (copied, not moved — the source may keep a remainder that still needs it).
 */
async function transferHours(db, user, { fromKey, toKey, targetKey, moves, scenario = "baseline" }) {
  if (fromKey === toKey) { const e = new Error("source and destination are the same resource"); e.code = "bad_request"; throw e; }
  const cutoff = currentMonthStart();
  return db.tx(async () => {
    let moved = 0, hoursMoved = 0;
    for (const mv of moves) {
      const month = monthKey(mv.month);
      const amt = Number(mv.hours);
      if (!(amt > 0)) continue;
      if (month < cutoff) { const e = new PastMonth(month.slice(0, 7)); throw e; }
      const src = await db.get("SELECT id, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
        [scenario, fromKey, targetKey, month]);
      if (!src || Number(src.hours) < amt - 1e-9) {
        const e = new Error(`only ${src ? src.hours : 0}h available in ${month.slice(0, 7)} — cannot transfer ${amt}h`);
        e.code = "bad_request"; throw e;
      }
      const rest = Math.round((Number(src.hours) - amt) * 100) / 100;
      if (rest > 0) await db.run("UPDATE allocation SET hours=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?", [rest, user.upn, nowIso(), src.id]);
      else await db.run("DELETE FROM allocation WHERE id=?", [src.id]);
      const dst = await db.get("SELECT id, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
        [scenario, toKey, targetKey, month]);
      if (dst) await db.run("UPDATE allocation SET hours=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?", [Number(dst.hours) + amt, user.upn, nowIso(), dst.id]);
      else await db.run("INSERT INTO allocation (scenario, resource_key, target_key, month, hours, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,?,1)",
        [scenario, toKey, targetKey, month, amt, user.upn, nowIso()]);
      await audit(db, user.upn, "allocation", `${scenario}|${toKey}|${targetKey}|${month.slice(0, 7)}`, "transfer", `${amt}h`, `from ${fromKey}`);
      moved++; hoursMoved += amt;
    }
    if (moved) {
      const srcRate = await db.get("SELECT rate FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, targetKey]);
      if (srcRate && Number(srcRate.rate) > 0) {
        const dstRate = await db.get("SELECT id FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, toKey, targetKey]);
        if (!dstRate) await db.run("INSERT INTO bill_rate (scenario, resource_key, target_key, rate, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,1)",
          [scenario, toKey, targetKey, srcRate.rate, user.upn, nowIso()]);
      }
    }
    return { moved, hoursMoved: Math.round(hoursMoved * 100) / 100 };
  });
}

/* ------------------------------------------ move one project between pools -- */
/**
 * Reclassify ONE project's demand to the role's other-shore pool: everything for
 * (pool × project) — allocations (all months, history included), the pair's bill
 * rate and proposed-hire note — moves to the role's pool of the given shore,
 * which is created on the fly if it doesn't exist. Collisions sum; every moved
 * cell is audited. The rest of the source pool is untouched.
 */
async function moveTbaTarget(db, user, { tbhKey, targetKey, shore, scenario = "baseline" }) {
  const src = await db.get("SELECT id, role, dept, shore FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, tbhKey]);
  if (!src) { const e = new Error("no such TBA pool"); e.code = "bad_request"; throw e; }
  const destShore = normShore(shore);
  const destSlug = roleSlug(src.role, destShore);
  if (destSlug === tbhKey) { const e = new Error("that project is already in the " + destShore + " pool"); e.code = "bad_request"; throw e; }
  const fromKey = `tbh:${tbhKey}`, toKey = `tbh:${destSlug}`;
  return db.tx(async () => {
    const dest = await db.get("SELECT id FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, destSlug]);
    if (!dest) {
      await db.run("INSERT INTO tbh (scenario, tbh_key, name, role, dept, shore, start_month, capacity, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,1)",
        [scenario, destSlug, tbaName(src.role, destShore), src.role, src.dept || "", destShore, user.upn, nowIso()]);
      await audit(db, user.upn, "tbh", `${scenario}|${destSlug}`, "insert", null, tbaName(src.role, destShore));
    }
    let moved = 0, merged = 0;
    const rows = await db.all("SELECT id, month, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, targetKey]);
    for (const r of rows) {
      const dst = await db.get("SELECT id, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
        [scenario, toKey, targetKey, r.month]);
      const key = `${scenario}|${toKey}|${targetKey}|${String(r.month).slice(0, 7)}`;
      if (dst) {
        await db.run("UPDATE allocation SET hours=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?", [Number(dst.hours) + Number(r.hours), user.upn, nowIso(), dst.id]);
        await db.run("DELETE FROM allocation WHERE id=?", [r.id]);
        merged++;
      } else {
        await db.run("UPDATE allocation SET resource_key=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?", [toKey, user.upn, nowIso(), r.id]);
      }
      await audit(db, user.upn, "allocation", key, "shore-move", fromKey, toKey);
      moved++;
    }
    const rate = await db.get("SELECT id FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, targetKey]);
    if (rate) {
      const dstRate = await db.get("SELECT id FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, toKey, targetKey]);
      if (!dstRate) await db.run("UPDATE bill_rate SET resource_key=? WHERE id=?", [toKey, rate.id]);
      else await db.run("DELETE FROM bill_rate WHERE id=?", [rate.id]);
    }
    const prop = await db.get("SELECT id FROM proposed_hire WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, targetKey]);
    if (prop) {
      const dstProp = await db.get("SELECT id FROM proposed_hire WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, toKey, targetKey]);
      if (!dstProp) await db.run("UPDATE proposed_hire SET resource_key=? WHERE id=?", [toKey, prop.id]);
      else await db.run("DELETE FROM proposed_hire WHERE id=?", [prop.id]);
    }
    return { moved, merged, destKey: destSlug };
  });
}

/* ------------------------------------------------- TBH -> employee handover -- */
/**
 * The person was hired: move a TBH seat's forecast onto the real employee.
 *
 * moves: [{ targetKey, employeeId }] — per-project targeting, so one seat's
 * projects can be split across different hires. Only months from the current
 * month onward move; closed-month TBH forecast stays behind (it belongs to the
 * seat's history, not the employee's variance baseline).
 *
 * collisionMode, for cells where the employee already has forecast:
 *   sum (default) — add the TBH hours in;  replace — TBH hours win;
 *   skip — leave both sides untouched (that forecast stays on the seat).
 * rateMode, for the seat's per-project bill rates:
 *   copy (default) — employee inherits where they have no rate;  overwrite —
 *   seat rate always wins;  none — rates stay behind.
 * removeSeat: also delete the TBH afterwards (its remaining rows go with it).
 */
async function shiftTbhForecast(db, user, { tbhKey, moves, collisionMode = "sum", rateMode = "copy", removeSeat = false, scenario = "baseline" }) {
  const fromKey = `tbh:${tbhKey}`;
  const cutoff = currentMonthStart();
  return db.tx(async () => {
    const out = { moved: 0, merged: 0, replaced: 0, skipped: 0, ratesCopied: 0, seatRemoved: false };
    for (const mv of moves) {
      const toKey = `emp:${mv.employeeId}`;
      const rows = await db.all(
        "SELECT id, resource_key, month, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month>=?",
        [scenario, fromKey, mv.targetKey, cutoff]);
      for (const r of rows) {
        const dst = await db.get(
          "SELECT id, hours FROM allocation WHERE scenario=? AND resource_key=? AND target_key=? AND month=?",
          [scenario, toKey, mv.targetKey, r.month]);
        const key = `${scenario}|${toKey}|${mv.targetKey}|${String(r.month).slice(0, 7)}`;
        if (!dst) {
          await db.run("UPDATE allocation SET resource_key=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?",
            [toKey, user.upn, nowIso(), r.id]);
          await audit(db, user.upn, "allocation", key, "shift", fromKey, toKey);
          out.moved++;
        } else if (collisionMode === "skip") {
          out.skipped++;
        } else {
          const hours = collisionMode === "replace" ? Number(r.hours) : Number(dst.hours) + Number(r.hours);
          await db.run("UPDATE allocation SET hours=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?",
            [hours, user.upn, nowIso(), dst.id]);
          await db.run("DELETE FROM allocation WHERE id=?", [r.id]);
          await audit(db, user.upn, "allocation", key, collisionMode === "replace" ? "shift-replace" : "shift-merge", dst.hours, hours);
          collisionMode === "replace" ? out.replaced++ : out.merged++;
          out.moved++;
        }
      }
      if (rateMode !== "none") {
        const srcRate = await db.get("SELECT rate FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, mv.targetKey]);
        if (srcRate && Number(srcRate.rate) > 0) {
          const dstRate = await db.get("SELECT id FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, toKey, mv.targetKey]);
          if (dstRate && rateMode === "overwrite") {
            await db.run("UPDATE bill_rate SET rate=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?", [srcRate.rate, user.upn, nowIso(), dstRate.id]);
            out.ratesCopied++;
          } else if (!dstRate) {
            await db.run("INSERT INTO bill_rate (scenario, resource_key, target_key, rate, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,1)",
              [scenario, toKey, mv.targetKey, srcRate.rate, user.upn, nowIso()]);
            out.ratesCopied++;
          }
          await audit(db, user.upn, "rate", `${scenario}|${toKey}|${mv.targetKey}`, "shift", fromKey, srcRate.rate);
        }
        await db.run("DELETE FROM bill_rate WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, mv.targetKey]);
      }
      // the proposed hire became a real assignment — the note has served its purpose
      await db.run("DELETE FROM proposed_hire WHERE scenario=? AND resource_key=? AND target_key=?", [scenario, fromKey, mv.targetKey]);
    }
    if (removeSeat) {
      await db.run("DELETE FROM allocation WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
      await db.run("DELETE FROM capacity_override WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
      await db.run("DELETE FROM bill_rate WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
      await db.run("DELETE FROM proposed_hire WHERE scenario=? AND resource_key=?", [scenario, fromKey]);
      const r = await db.run("DELETE FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, tbhKey]);
      out.seatRemoved = r.changes > 0;
      await audit(db, user.upn, "tbh", `${scenario}|${tbhKey}`, "delete", null, "shifted to employee");
    }
    return out;
  });
}

/* -------------------------------------------------------------- import map -- */
/** Only manual overrides get stored; target_key === null clears one (so an
 *  auto-match re-runs next import and picks up matcher improvements). */
async function putImportMap(db, user, m) {
  const scenario = m.scenario || "baseline";
  if (m.targetKey == null) {
    await db.run("DELETE FROM import_map WHERE scenario=? AND kind=? AND source_name=?", [scenario, m.kind, m.sourceName]);
    return { cleared: true };
  }
  const cur = await db.get("SELECT id FROM import_map WHERE scenario=? AND kind=? AND source_name=?", [scenario, m.kind, m.sourceName]);
  if (cur) await db.run("UPDATE import_map SET target_key=?, updated_by=?, updated_at=? WHERE id=?", [m.targetKey, user.upn, nowIso(), cur.id]);
  else await db.run("INSERT INTO import_map (scenario, kind, source_name, target_key, updated_by, updated_at) VALUES (?,?,?,?,?,?)",
    [scenario, m.kind, m.sourceName, m.targetKey, user.upn, nowIso()]);
  await audit(db, user.upn, "importmap", `${scenario}|${m.kind}|${m.sourceName}`, cur ? "update" : "insert", null, m.targetKey);
  return { ok: true };
}

/* ------------------------------------------------------- plan snapshots -- */
/** Write today's snapshot of the baseline plan (idempotent per day). The
 *  Changes view diffs two snapshot dates, so granularity is daily. */
async function takeSnapshot(db, date) {
  const day = (date || new Date().toISOString()).slice(0, 10);
  const [alloc, rates] = await Promise.all([
    db.all("SELECT resource_key, target_key, month, hours FROM allocation WHERE scenario = 'baseline'"),
    db.all("SELECT resource_key, target_key, rate FROM bill_rate WHERE scenario = 'baseline'"),
  ]);
  const rateOf = new Map(rates.map(r => [`${r.resource_key}|${r.target_key}`, Number(r.rate) || 0]));
  await db.tx(async () => {
    await db.run("DELETE FROM plan_snapshot WHERE snap_date = ?", [day]);
    for (const a of alloc) {
      await db.run(
        "INSERT INTO plan_snapshot (snap_date, resource_key, target_key, month, hours, rate) VALUES (?,?,?,?,?,?)",
        [day, a.resource_key, a.target_key, String(a.month).slice(0, 10), Number(a.hours), rateOf.get(`${a.resource_key}|${a.target_key}`) || 0]);
    }
  });
  return { day, rows: alloc.length };
}

/** Changes between two dates: diff of the snapshots nearest ON OR BEFORE each
 *  date (today's snapshot is taken lazily so "to = today" always works), plus
 *  the allocation audit entries in the window as the who/when feed. */
async function getChanges(db, from, to) {
  const today = new Date().toISOString().slice(0, 10);
  const have = await db.get("SELECT COUNT(*) AS n FROM plan_snapshot WHERE snap_date = ?", [today]);
  if (!Number(have.n)) await takeSnapshot(db, today);
  const snapAt = async (d) => {
    const r = await db.get("SELECT MAX(snap_date) AS d FROM plan_snapshot WHERE snap_date <= ?", [d]);
    if (r && r.d) return String(r.d).slice(0, 10);
    const first = await db.get("SELECT MIN(snap_date) AS d FROM plan_snapshot");
    return first && first.d ? String(first.d).slice(0, 10) : today;
  };
  const fromSnap = await snapAt(from || today);
  const toSnap = await snapAt(to || today);
  const load = async (d) => {
    const rows = await db.all("SELECT resource_key, target_key, month, hours, rate FROM plan_snapshot WHERE snap_date = ?", [d]);
    return new Map(rows.map(r => [`${r.resource_key}|${r.target_key}|${String(r.month).slice(0, 7)}`, { h: Number(r.hours), rate: Number(r.rate) || 0 }]));
  };
  const A = await load(fromSnap), B = await load(toSnap);
  const changes = [];
  const keys = new Set([...A.keys(), ...B.keys()]);
  for (const k of keys) {
    const a = A.get(k), b = B.get(k);
    const before = a ? a.h : 0, after = b ? b.h : 0;
    if (Math.abs(before - after) < 0.001) continue;
    const [resourceKey, targetKey, month] = k.split("|");
    changes.push({ resourceKey, targetKey, month, before, after,
      rate: (b && b.rate) || (a && a.rate) || 0 });
  }
  const winFrom = `${fromSnap}T00:00:00`, winTo = `${to || today}T23:59:59.999Z`;
  const events = await db.all(
    `SELECT at, actor, entity_key, action, old_value, new_value FROM audit_log
     WHERE entity = 'allocation' AND at >= ? AND at <= ? ORDER BY at DESC LIMIT 1000`,
    [winFrom, winTo]);

  // ---- fold CRM -> project conversions into TRANSFERS, not add+remove ------
  // A won deal's forecast moving onto its delivery project is a key change,
  // not a plan change: the hours are the same work. The move is audited
  // ('reassign' rows and the opportunity 'map' entry both carry from -> to),
  // so pair each drop on the old key with the matching gain on the new key for
  // the same person + month and report the overlap as a transfer; only what
  // does NOT pair up (a genuine edit made during or after the move) remains a
  // change. Queried directly rather than from `events` (that list is capped).
  const movedPairs = await db.all(
    `SELECT DISTINCT old_value AS f, new_value AS t FROM audit_log
     WHERE entity = 'allocation' AND action = 'reassign' AND at >= ? AND at <= ?
     UNION SELECT DISTINCT old_value, new_value FROM audit_log
     WHERE entity = 'opportunity' AND action = 'map' AND at >= ? AND at <= ?`,
    [winFrom, winTo, winFrom, winTo]);
  const transfers = [];
  {
    const keyRx = /^(prj|crm):\d+$/;
    const idx = new Map();
    changes.forEach(c => idx.set(`${c.resourceKey}|${c.targetKey}|${c.month}`, c));
    for (const mp of movedPairs) {
      const fromKey = String(mp.f || ""), toKey = String(mp.t || "");
      if (!keyRx.test(fromKey) || !keyRx.test(toKey) || fromKey === toKey) continue;
      for (const c of changes) {
        if (c.targetKey !== fromKey) continue;
        const drop = c.before - c.after; if (drop <= 0.001) continue;
        const b = idx.get(`${c.resourceKey}|${toKey}|${c.month}`); if (!b) continue;
        const gain = b.after - b.before; if (gain <= 0.001) continue;
        const moved = Math.round(Math.min(drop, gain) * 100) / 100;
        c.before -= moved; b.after -= moved;
        transfers.push({ resourceKey: c.resourceKey, fromKey, toKey, month: c.month, hours: moved });
      }
    }
    if (transfers.length)
      for (let i = changes.length - 1; i >= 0; i--)
        if (Math.abs(changes[i].before - changes[i].after) < 0.001) changes.splice(i, 1);
  }

  // Names for every key the window touches, resolved server-side REGARDLESS of
  // active state: history outlives the roster — a departed person or a closed
  // opportunity drops out of the UI's reference but must still read by name.
  const rk = new Set(), tk = new Set();
  for (const c of changes) { rk.add(c.resourceKey); tk.add(c.targetKey); }
  for (const t of transfers) { rk.add(t.resourceKey); tk.add(t.fromKey); tk.add(t.toKey); }
  for (const e of events) { const p = String(e.entity_key).split("|"); if (p.length >= 4) { rk.add(p[1]); tk.add(p[2]); } }
  const labels = {}, clients = {};
  const idsOf = (set, pre) => [...set].filter(k => k.startsWith(pre)).map(k => parseInt(k.slice(pre.length), 10)).filter(Number.isInteger);
  const fill = async (ids, table, pre, withClient) => {
    if (!ids.length) return;
    const rows = await db.all(`SELECT id, name${withClient ? ", client" : ""} FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    rows.forEach(r => { labels[pre + r.id] = r.name; if (withClient && r.client) clients[pre + r.id] = r.client; });
  };
  await fill(idsOf(rk, "emp:"), "ref_person", "emp:");
  await fill(idsOf(tk, "prj:"), "ref_project", "prj:", true);
  await fill(idsOf(tk, "crm:"), "ref_opportunity", "crm:", true);
  const tbhKeys = [...rk].filter(k => k.startsWith("tbh:"));
  if (tbhKeys.length) {
    const rows = await db.all(`SELECT tbh_key, name FROM tbh WHERE tbh_key IN (${tbhKeys.map(() => "?").join(",")})`, tbhKeys.map(k => k.slice(4)));
    rows.forEach(r => { labels["tbh:" + r.tbh_key] = r.name; });
  }

  return { fromSnap, toSnap, changes, transfers, labels, clients,
    events: events.map(e => ({ at: String(e.at), actor: e.actor, key: e.entity_key, action: e.action,
      oldValue: e.old_value == null ? null : String(e.old_value), newValue: e.new_value == null ? null : String(e.new_value) })) };
}

module.exports = { getPlan, getReference, putAllocation, putAllocations, reassignAllocations, mapOpportunityToProject, putCapacity, putRate, putTbh, deleteTbh, shiftTbhForecast, moveTbaTarget, transferHours, normalizeTbaPools, roleSlug, tbaName, normShore, putImportMap, putProposedHire, putMilestoneMonth, putBillingType, takeSnapshot, getChanges, Conflict, PastMonth, monthKey, currentMonthStart };
