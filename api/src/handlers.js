"use strict";
/**
 * Framework-free request handlers: (method, path, query, body, headers) -> {status, body}.
 * Azure Functions and the local dev server are both thin adapters over these,
 * so what runs in CI is what runs in Azure.
 */
const { getUser, canEdit } = require("./auth");
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
    return user ? json(200, { upn: user.upn, roles: user.roles, canEdit: canEdit(user) }) : UNAUTH;
  }
  if (!user) return UNAUTH;

  // ---- reads (any signed-in user) ----
  if (method === "GET" && path === "/api/plan") {
    return json(200, await store.getPlan(db, scenario));
  }
  if (method === "GET" && path === "/api/audit") {
    const rows = await db.all("SELECT at, actor, entity, entity_key, action, old_value, new_value FROM AuditLog ORDER BY at DESC, id DESC LIMIT 200");
    return json(200, { entries: rows });
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
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items) return json(400, { error: "items[] required" });
      if (items.length > 2000) return json(413, { error: "too many items in one batch" });
      return json(200, { results: await store.putAllocations(db, user, items.map(i => ({ ...i, scenario }))) });
    }
    if (method === "PUT" && path === "/api/capacity") {
      if (!body.resourceKey) return json(400, { error: "resourceKey required" });
      return json(200, await store.putCapacity(db, user, { ...body, scenario }));
    }
    if (method === "PUT" && path === "/api/tbh") {
      if (!body.tbhKey || !body.name) return json(400, { error: "tbhKey and name required" });
      return json(200, await store.putTbh(db, user, { ...body, scenario }));
    }
    if (method === "DELETE" && path.startsWith("/api/tbh/")) {
      return json(200, await store.deleteTbh(db, user, decodeURIComponent(path.slice("/api/tbh/".length)), scenario));
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
    throw e;
  }

  return json(404, { error: "no such route" });
}

module.exports = { handle };
