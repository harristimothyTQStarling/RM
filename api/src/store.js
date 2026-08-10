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
  const [allocations, capacity, tbh, importMap, rates, proposed] = await Promise.all([
    db.all("SELECT resource_key, target_key, month, hours, version, updated_by, updated_at FROM allocation WHERE scenario = ?", [scenario]),
    db.all("SELECT resource_key, hours_per_month, version FROM capacity_override WHERE scenario = ?", [scenario]),
    db.all("SELECT tbh_key, name, role, dept, shore, start_month, capacity, version FROM tbh WHERE scenario = ?", [scenario]),
    db.all("SELECT kind, source_name, target_key FROM import_map WHERE scenario = ?", [scenario]),
    db.all("SELECT resource_key, target_key, rate, version FROM bill_rate WHERE scenario = ?", [scenario]),
    db.all("SELECT resource_key, target_key, name FROM proposed_hire WHERE scenario = ?", [scenario]),
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
  const [people, projects, opportunities, actuals, sync] = await Promise.all([
    db.all("SELECT id, name, role, dept, type FROM ref_person WHERE active = 1 ORDER BY name"),
    db.all("SELECT id, name, client, billable FROM ref_project WHERE active = 1 ORDER BY name"),
    db.all("SELECT id, name, client, stage, needs_project, expected_start, expected_months FROM ref_opportunity WHERE active = 1 ORDER BY name"),
    db.all("SELECT employee_id, project_id, month, hours, bill_rate, revenue FROM ref_actual"),
    db.all("SELECT source, synced_at, row_count, ok, message FROM sync_state"),
  ]);
  return {
    people: people.map(p => ({ id: p.id, name: p.name, role: p.role || "", dept: p.dept || "", type: p.type })),
    projects: projects.map(p => ({ id: p.id, name: p.name, client: p.client || "", billable: !!p.billable })),
    opportunities: opportunities.map(o => ({
      id: o.id, name: o.name, client: o.client || "", stage: o.stage || "", needsProject: !!o.needs_project,
      expectedStart: o.expected_start ? String(o.expected_start).slice(0, 7) : null,   // YYYY-MM
      expectedMonths: Number(o.expected_months) || 0,
    })),
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
    return { moved, merged };
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

/**
 * To-Be-Assigned model: unstaffed demand lives against the ROLE, not a named
 * seat — exactly ONE pool per role, named "TBA - <role>", with no capacity or
 * start month of its own (demand-only). This normalizer converts historical
 * To-Be-Hired seats: every tbh row is renamed to the pool convention and rows
 * sharing a role are MERGED into the canonical pool — allocations move onto the
 * pool's key (summing where both had hours on the same project/month), bill
 * rates carry over where the pool has none, capacity overrides are dropped.
 * Idempotent; runs at every boot and is a no-op once normalized.
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
      const key = `${r.scenario}|${roleSlug(r.role, r.shore)}`;
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

module.exports = { getPlan, getReference, putAllocation, putAllocations, reassignAllocations, mapOpportunityToProject, putCapacity, putRate, putTbh, deleteTbh, shiftTbhForecast, moveTbaTarget, transferHours, normalizeTbaPools, roleSlug, tbaName, normShore, putImportMap, putProposedHire, Conflict, PastMonth, monthKey, currentMonthStart };
