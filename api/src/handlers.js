"use strict";
/**
 * Framework-free request handlers: (method, path, query, body, headers) -> {status, body}.
 * Azure Functions and the local dev server are both thin adapters over these,
 * so what runs in CI is what runs in Azure.
 */
const { getUser, canEdit, canImport, canCost, canCostEdit } = require("./auth");
const store = require("./store");

const json = (status, body) => ({ status, body });
const UNAUTH = json(401, { error: "not signed in" });
const FORBID = json(403, { error: "Planner.Editor role required" });

async function handle(db, req) {
  const { method, path } = req;
  const q = req.query || {};
  const body = req.body || {};
  const user = getUser(req.headers || {});
  const scenario = q.scenario || body.scenario || "baseline";

  if (path === "/api/me") {
    return user ? json(200, { upn: user.upn, roles: user.roles, canEdit: canEdit(user), canImport: canImport(user), canCost: canCost(user), canCostEdit: canCostEdit(user), agentEnabled: require("./agent").enabled() }) : UNAUTH;
  }
  if (!user) return UNAUTH;

  // ---- reads (any signed-in user) ----
  if (method === "GET" && path === "/api/plan") {
    return json(200, await store.getPlan(db, scenario));
  }
  if (method === "GET" && path === "/api/reference") {
    return json(200, await store.getReference(db));
  }
  if (method === "GET" && path === "/api/bootstrap") {
    // One round-trip for page load: identity + reference + plan.
    const [reference, plan] = await Promise.all([store.getReference(db), store.getPlan(db, scenario)]);
    return json(200, { me: { upn: user.upn, name: user.name, canEdit: canEdit(user), canImport: canImport(user), canCost: canCost(user), canCostEdit: canCostEdit(user), agentEnabled: require("./agent").enabled() }, reference, plan });
  }
  if (method === "GET" && path === "/api/audit") {
    const rows = await db.all("SELECT at, actor, entity, entity_key, action, old_value, new_value FROM audit_log ORDER BY at DESC, id DESC LIMIT 200");
    return json(200, { entries: rows });
  }
  if (method === "POST" && path === "/api/sync") {
    // Refresh the Odoo reference cache on demand. Available to EVERY signed-in
    // user (viewers included): the sync is read-only against Odoo and only
    // re-caches what Odoo already says, so it can't corrupt the plan — the
    // nightly run does the same thing unattended.
    const { Odoo, syncAll } = require("./odoo");
    const odoo = new Odoo();
    if (!odoo.configured) return json(503, { error: "Odoo is not configured (ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASSWORD)" });
    const year = new Date().getUTCFullYear();
    try {
      const counts = await syncAll(db, odoo, { actualsFrom: `${year}-01-01`, actualsTo: `${year}-12-31` });
      return json(200, { ok: true, counts });
    } catch (e) {
      return json(502, { error: `Odoo sync failed: ${e.message}` });
    }
  }

  // ---- costing (COSTING_UPNS only — payroll-derived data never leaves the
  //      server for anyone else; enforcement is here, not in the UI) ----
  // Costs are a per-person rate card entered in-app by the costing role:
  // bi-weekly, monthly and hourly cost. The client derives each month's cost
  // (monthly wins, else bi-weekly × 26/12, else hourly × that month's hours).
  // Deliberately NOT written to audit_log: the audit feed is visible to every
  // signed-in user and cost figures must never leak there — attribution lives
  // in cost_rate.updated_by instead.
  if (path === "/api/cost" || path === "/api/cost/rate") {
    if (!canCost(user)) return json(403, { error: "costing role required" });
    if (method === "GET" && path === "/api/cost") {
      const rows = await db.all("SELECT employee_id, annual, biweekly, monthly, hourly, updated_by, updated_at FROM cost_rate");
      const n = (v) => (v === null || v === undefined ? null : Number(v));
      return json(200, {
        rates: rows.map(r => ({
          employeeId: r.employee_id, annual: n(r.annual), biweekly: n(r.biweekly), monthly: n(r.monthly), hourly: n(r.hourly),
          updatedBy: r.updated_by, updatedAt: String(r.updated_at),
        })),
      });
    }
    if (method === "PUT" && path === "/api/cost/rate") {
      // Editing the rate card is stricter than viewing it: COSTING_EDIT_UPNS
      // (default tim@) — the rest of the costing role sees the tabs read-only.
      if (!canCostEdit(user)) return json(403, { error: "cost editing is restricted" });
      const id = Number(body.employeeId);
      if (!Number.isInteger(id)) return json(400, { error: "employeeId required" });
      const num = (v) => {
        if (v === null || v === undefined || v === "") return null;
        const x = Number(v);
        return Number.isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : NaN;
      };
      const annual = num(body.annual), biweekly = num(body.biweekly), monthly = num(body.monthly), hourly = num(body.hourly);
      if ([annual, biweekly, monthly, hourly].some(Number.isNaN)) return json(400, { error: "costs must be numbers >= 0" });
      if (annual === null && biweekly === null && monthly === null && hourly === null) {
        await db.run("DELETE FROM cost_rate WHERE employee_id = ?", [id]);
        return json(200, { ok: true, deleted: true });
      }
      await db.run(
        `INSERT INTO cost_rate (employee_id, annual, biweekly, monthly, hourly, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (employee_id) DO UPDATE SET
           annual=excluded.annual, biweekly=excluded.biweekly, monthly=excluded.monthly, hourly=excluded.hourly,
           updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
        [id, annual, biweekly, monthly, hourly, user.upn, new Date().toISOString()]);
      return json(200, { ok: true });
    }
    return json(404, { error: "no such route" });
  }

  if (method === "POST" && path === "/api/agent") {
    // The Planner Assistant. Open to every signed-in user BEFORE the editor
    // write-gate: viewers get read-only tools, and any write the agent executes
    // goes back through handle() with this same user's headers, so the editor
    // allowlist (and every other gate) still decides what actually happens.
    const agent = require("./agent");
    if (!agent.enabled()) return json(503, { error: "assistant is not configured (set ANTHROPIC_API_KEY)" });
    try {
      return json(200, await agent.runAgentTurn(db, user, req.headers || {}, body));
    } catch (e) {
      if (e && e.code === "rate_limited") return json(429, { error: e.message });
      if (e && e.code === "bad_request") return json(400, { error: e.message });
      console.error("agent error:", e);
      return json(502, { error: `assistant failed: ${e.message}` });
    }
  }

  // ---- writes (Editor only) ----
  const write = ["PUT", "POST", "DELETE"].includes(method);
  if (write && !canEdit(user)) return FORBID;

  try {
    if (method === "PUT" && path === "/api/allocation") {
      if (!body.resourceKey || !body.targetKey || !body.month) return json(400, { error: "resourceKey, targetKey and month are required" });
      return json(200, await store.putAllocation(db, user, { ...body, scenario }));
    }
    if (method === "POST" && path === "/api/allocations") {
      // A forecast import declares itself (mode:"import") and rewrites the plan
      // wholesale — restricted to importers even among editors. Ordinary bulk
      // allocate (no mode) stays open to every editor.
      if (body.mode === "import" && !canImport(user)) return json(403, { error: "forecast import is restricted to the planning admin" });
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items) return json(400, { error: "items[] required" });
      if (items.length > 2000) return json(413, { error: "too many items in one batch" });
      return json(200, { results: await store.putAllocations(db, user, items.map(i => ({ ...i, scenario }))) });
    }
    if (method === "PUT" && path === "/api/capacity") {
      if (!body.resourceKey) return json(400, { error: "resourceKey required" });
      return json(200, await store.putCapacity(db, user, { ...body, scenario }));
    }
    if (method === "PUT" && path === "/api/rate") {
      if (!body.resourceKey || !body.targetKey) return json(400, { error: "resourceKey and targetKey required" });
      if (body.rate != null && (!Number.isFinite(Number(body.rate)) || Number(body.rate) < 0)) return json(400, { error: "rate must be a non-negative number" });
      return json(200, await store.putRate(db, user, { ...body, scenario }));
    }
    if (method === "PUT" && path === "/api/tbh") {
      if (!body.tbhKey || !body.name) return json(400, { error: "tbhKey and name required" });
      return json(200, await store.putTbh(db, user, { ...body, scenario }));
    }
    if (method === "DELETE" && path.startsWith("/api/tbh/")) {
      return json(200, await store.deleteTbh(db, user, decodeURIComponent(path.slice("/api/tbh/".length)), scenario));
    }
    if (method === "POST" && path === "/api/allocation/transfer") {
      // Move all or part of one (resource × project) pair's hours to another
      // person or TBA pool.
      const keyRx = /^(emp:\d+|tbh:[a-z0-9-]+)$/;
      if (!keyRx.test(String(body.fromResourceKey || "")) || !keyRx.test(String(body.toResourceKey || "")))
        return json(400, { error: "fromResourceKey and toResourceKey must be emp:<id> or tbh:<key>" });
      if (!/^(prj|crm):\d+$/.test(String(body.targetKey || ""))) return json(400, { error: "targetKey (prj:<id>|crm:<id>) required" });
      const moves = Array.isArray(body.moves) ? body.moves.filter(m => Number(m.hours) > 0) : null;
      if (!moves || !moves.length) return json(400, { error: "moves[] with positive hours required" });
      const to = String(body.toResourceKey);
      if (to.startsWith("emp:")) {
        const emp = await db.get("SELECT id FROM ref_person WHERE id=? AND active=1", [Number(to.slice(4))]);
        if (!emp) return json(400, { error: "destination is not an active person" });
      } else {
        const pool = await db.get("SELECT id FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, to.slice(4)]);
        if (!pool) return json(400, { error: "destination TBA pool does not exist" });
      }
      return json(200, await store.transferHours(db, user, {
        fromKey: body.fromResourceKey, toKey: to, targetKey: body.targetKey, moves, scenario,
      }));
    }
    if (method === "POST" && path === "/api/tbh/move") {
      // Reclassify one project of a TBA pool to the role's other-shore pool.
      if (!body.tbhKey || !/^(prj|crm):\d+$/.test(String(body.targetKey || ""))) return json(400, { error: "tbhKey and targetKey (prj:<id>|crm:<id>) required" });
      if (!["onshore", "offshore"].includes(body.shore)) return json(400, { error: "shore must be onshore or offshore" });
      return json(200, await store.moveTbaTarget(db, user, { tbhKey: body.tbhKey, targetKey: body.targetKey, shore: body.shore, scenario }));
    }
    if (method === "POST" && path === "/api/tbh/shift") {
      // The hire happened: move a TBH seat's forecast onto real employee(s).
      const moves = Array.isArray(body.moves) ? body.moves : null;
      if (!body.tbhKey || !moves || !moves.length) return json(400, { error: "tbhKey and moves[] required" });
      if (!moves.every(m => /^(prj|crm):\d+$/.test(String(m.targetKey)) && Number.isInteger(Number(m.employeeId))))
        return json(400, { error: "each move needs a targetKey (prj:<id>|crm:<id>) and employeeId" });
      if (!["sum", "replace", "skip"].includes(body.collisionMode || "sum")) return json(400, { error: "bad collisionMode" });
      if (!["copy", "overwrite", "none"].includes(body.rateMode || "copy")) return json(400, { error: "bad rateMode" });
      const seat = await db.get("SELECT id FROM tbh WHERE scenario=? AND tbh_key=?", [scenario, body.tbhKey]);
      if (!seat) return json(400, { error: "no such TBH seat" });
      for (const m of moves) {
        const emp = await db.get("SELECT id FROM ref_person WHERE id=? AND active=1", [Number(m.employeeId)]);
        if (!emp) return json(400, { error: `employee ${m.employeeId} is not an active person in Odoo` });
      }
      return json(200, await store.shiftTbhForecast(db, user, {
        tbhKey: body.tbhKey, moves, collisionMode: body.collisionMode || "sum",
        rateMode: body.rateMode || "copy", removeSeat: !!body.removeSeat, scenario,
      }));
    }
    if (method === "POST" && path === "/api/opportunity/map") {
      // Manually map a closed CRM opportunity's forecast onto a delivery project.
      const oppId = parseInt(body.oppId, 10);
      const projectId = parseInt(body.projectId, 10);
      if (!Number.isInteger(oppId) || !Number.isInteger(projectId)) return json(400, { error: "oppId and projectId are required" });
      const proj = await db.get("SELECT id FROM ref_project WHERE id = ? AND active = 1 AND billable = 1", [projectId]);
      if (!proj) return json(400, { error: "no such active billable project" });
      return json(200, await store.mapOpportunityToProject(db, user, oppId, projectId));
    }
    if (method === "PUT" && path === "/api/proposed") {
      // Proposed-hire name for one (TBA pool × project) pair; blank clears it.
      if (!body.resourceKey || !body.targetKey) return json(400, { error: "resourceKey and targetKey required" });
      if (String(body.name || "").length > 128) return json(400, { error: "name too long" });
      return json(200, await store.putProposedHire(db, user, { ...body, scenario }));
    }
    if (method === "PUT" && path === "/api/importmap") {
      if (!body.kind || !body.sourceName) return json(400, { error: "kind and sourceName required" });
      return json(200, await store.putImportMap(db, user, { ...body, scenario }));
    }
  } catch (e) {
    if (e && e.code === "conflict") {
      // 409 carries the winning value so the UI can say what it lost to.
      return json(409, { error: "conflict", current: e.current });
    }
    if (e && (e.code === "past_month" || e.code === "bad_request")) {
      return json(400, { error: e.message });
    }
    throw e;
  }

  return json(404, { error: "no such route" });
}

module.exports = { handle };
