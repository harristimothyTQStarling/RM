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

const monthKey = (m) => String(m).length === 7 ? `${m}-01` : String(m).slice(0, 10);

/* ---------------------------------------------------------------- read plan -- */
async function getPlan(db, scenario = "baseline") {
  const [allocations, capacity, tbh, importMap, rates] = await Promise.all([
    db.all("SELECT resource_key, target_key, month, hours, version, updated_by, updated_at FROM allocation WHERE scenario = ?", [scenario]),
    db.all("SELECT resource_key, hours_per_month, version FROM capacity_override WHERE scenario = ?", [scenario]),
    db.all("SELECT tbh_key, name, role, dept, start_month, capacity, version FROM tbh WHERE scenario = ?", [scenario]),
    db.all("SELECT kind, source_name, target_key FROM import_map WHERE scenario = ?", [scenario]),
    db.all("SELECT resource_key, target_key, rate, version FROM bill_rate WHERE scenario = ?", [scenario]),
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
      tbhKey: r.tbh_key, name: r.name, role: r.role, dept: r.dept,
      start: r.start_month ? String(r.start_month).slice(0, 7) : null,
      cap: r.capacity == null ? null : Number(r.capacity), version: r.version,
    })),
    importMap: importMap.reduce((acc, r) => { (acc[r.kind] ||= {})[r.source_name] = r.target_key; return acc; }, { person: {}, project: {} }),
  };
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
    db.all("SELECT id, name, client, stage, needs_project FROM ref_opportunity WHERE active = 1 ORDER BY name"),
    db.all("SELECT employee_id, project_id, month, hours FROM ref_actual"),
    db.all("SELECT source, synced_at, row_count, ok, message FROM sync_state"),
  ]);
  return {
    people: people.map(p => ({ id: p.id, name: p.name, role: p.role || "", dept: p.dept || "", type: p.type })),
    projects: projects.map(p => ({ id: p.id, name: p.name, client: p.client || "", billable: !!p.billable })),
    opportunities: opportunities.map(o => ({ id: o.id, name: o.name, client: o.client || "", stage: o.stage || "", needsProject: !!o.needs_project })),
    actuals: actuals.map(a => ({
      employeeId: a.employee_id, projectId: a.project_id,
      month: String(a.month).slice(0, 7), hours: Number(a.hours),
    })),
    sync: sync.map(s => ({ source: s.source, at: String(s.synced_at), rows: s.row_count, ok: !!s.ok, message: s.message })),
  };
}

/* -------------------------------------------------------- write allocation -- */
/** hours === 0 deletes the row: an empty cell and a 0h cell are the same thing. */
async function putAllocation(db, user, a) {
  const scenario = a.scenario || "baseline";
  const month = monthKey(a.month);
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
  const cur = await db.get("SELECT id, version FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, t.tbhKey]);
  if (!cur) {
    await db.run("INSERT INTO tbh (scenario, tbh_key, name, role, dept, start_month, capacity, updated_by, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)",
      [scenario, t.tbhKey, t.name, t.role || "", t.dept || "", start, t.cap == null ? null : Number(t.cap), user.upn, nowIso()]);
    await audit(db, user.upn, "tbh", `${scenario}|${t.tbhKey}`, "insert", null, t.name);
    return { version: 1 };
  }
  const next = cur.version + 1;
  await db.run("UPDATE tbh SET name=?, role=?, dept=?, start_month=?, capacity=?, updated_by=?, updated_at=?, version=? WHERE id=?",
    [t.name, t.role || "", t.dept || "", start, t.cap == null ? null : Number(t.cap), user.upn, nowIso(), next, cur.id]);
  await audit(db, user.upn, "tbh", `${scenario}|${t.tbhKey}`, "update", null, t.name);
  return { version: next };
}

/** Removing a TBH must take its allocations with it, or they become orphans
 *  that still count toward demand with nobody to do the work. */
async function deleteTbh(db, user, tbhKey, scenario = "baseline") {
  return db.tx(async () => {
    await db.run("DELETE FROM allocation WHERE scenario=? AND resource_key=?", [scenario, `tbh:${tbhKey}`]);
    await db.run("DELETE FROM capacity_override WHERE scenario=? AND resource_key=?", [scenario, `tbh:${tbhKey}`]);
    const r = await db.run("DELETE FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, tbhKey]);
    await audit(db, user.upn, "tbh", `${scenario}|${tbhKey}`, "delete", null, null);
    return { deleted: r.changes > 0 };
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

module.exports = { getPlan, getReference, putAllocation, putAllocations, reassignAllocations, mapOpportunityToProject, putCapacity, putRate, putTbh, deleteTbh, putImportMap, Conflict, monthKey };
