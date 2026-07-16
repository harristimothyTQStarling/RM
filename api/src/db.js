"use strict";
/**
 * Data layer. One interface, two drivers:
 *   - sqlite : local dev, uses node's built-in node:sqlite (zero npm deps)
 *   - mssql  : Azure SQL, via Managed Identity (no password anywhere)
 *
 * Driver is chosen by DB_DRIVER. The handlers never see the difference; the SQL
 * is kept to the common subset so behaviour — especially optimistic concurrency —
 * is identical in both.
 */
const fs = require("fs");
const path = require("path");

const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/* ------------------------------------------------------------------ sqlite -- */
function sqliteDriver(file) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const schema = fs.readFileSync(path.join(__dirname, "../../db/schema.sqlite.sql"), "utf8");
  db.exec(schema);
  return {
    kind: "sqlite",
    all: (sql, params = []) => db.prepare(sql).all(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    run: (sql, params = []) => { const r = db.prepare(sql).run(...params); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    // MUST await fn(): the callers are async, so a synchronous COMMIT here would
    // fire before their inserts had run, silently placing every write OUTSIDE
    // the transaction and making ROLLBACK a no-op.
    tx: async (fn) => { db.exec("BEGIN"); try { const out = await fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    close: () => db.close(),
  };
}

/* ------------------------------------------------------------------- mssql -- */
/* Lazily required so local dev never needs the package installed. Auth is
   Managed Identity in Azure; DB_CONN may supply a connection string locally. */
function mssqlDriver() {
  const sql = require("mssql");
  const cfg = process.env.DB_CONN
    ? process.env.DB_CONN
    : {
        server: process.env.DB_SERVER,
        database: process.env.DB_NAME,
        authentication: { type: "azure-active-directory-msi-app-service" },
        options: { encrypt: true, trustServerCertificate: false },
      };
  let poolPromise = null;
  const pool = () => (poolPromise ||= sql.connect(cfg));
  const bind = (req, params) => { params.forEach((v, i) => req.input(`p${i + 1}`, v)); return req; };
  const toNamed = (s) => { let i = 0; return s.replace(/\?/g, () => `@p${++i}`); };
  return {
    kind: "mssql",
    all: async (q, params = []) => (await bind((await pool()).request(), params).query(toNamed(q))).recordset,
    get: async (q, params = []) => (await bind((await pool()).request(), params).query(toNamed(q))).recordset[0],
    run: async (q, params = []) => { const r = await bind((await pool()).request(), params).query(toNamed(q)); return { changes: r.rowsAffected[0] || 0 }; },
    tx: async (fn) => {
      const t = new sql.Transaction(await pool());
      await t.begin();
      try { const out = await fn(); await t.commit(); return out; } catch (e) { await t.rollback(); throw e; }
    },
    close: async () => { if (poolPromise) (await poolPromise).close(); },
  };
}

function open(opts = {}) {
  const driver = opts.driver || process.env.DB_DRIVER || "sqlite";
  return driver === "mssql" ? mssqlDriver() : sqliteDriver(opts.file || process.env.DB_FILE || ":memory:");
}

/* --------------------------------------------------------------- audit log -- */
async function audit(db, actor, entity, key, action, oldV, newV) {
  await db.run(
    "INSERT INTO AuditLog (at, actor, entity, entity_key, action, old_value, new_value) VALUES (?,?,?,?,?,?,?)",
    [nowIso(), actor, entity, key, action, oldV == null ? null : String(oldV), newV == null ? null : String(newV)]
  );
}

module.exports = { open, nowIso, audit };
