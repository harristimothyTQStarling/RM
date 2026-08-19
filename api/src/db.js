"use strict";
/**
 * Data layer. One interface, two drivers:
 *   - sqlite   : local dev + tests, node's built-in node:sqlite (zero npm deps)
 *   - postgres : Railway Postgres in production, via DATABASE_URL
 *
 * Driver is chosen by DB_DRIVER (default sqlite). The handlers never see the
 * difference; SQL is kept to the common subset so behaviour — especially the
 * optimistic-concurrency logic in store.js — is identical in both. That's what
 * lets the full test suite run locally with no database server.
 *
 * Placeholders are written `?` everywhere and rewritten to $1..$n for Postgres.
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
  // Additive column migrations for EXISTING local files: the CREATE IF NOT EXISTS
  // schema above no-ops on tables that already exist, so columns added later never
  // arrive (Postgres gets them via the ALTERs in schema.postgres.sql). SQLite has
  // no ADD COLUMN IF NOT EXISTS — attempt each and ignore "duplicate column".
  for (const sql of [
    "ALTER TABLE tbh ADD COLUMN shore TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ref_opportunity ADD COLUMN needs_project INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE ref_opportunity ADD COLUMN expected_start TEXT",
    "ALTER TABLE ref_opportunity ADD COLUMN expected_months INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE ref_actual ADD COLUMN bill_rate REAL NOT NULL DEFAULT 0",
    "ALTER TABLE ref_actual ADD COLUMN revenue REAL NOT NULL DEFAULT 0",
    "ALTER TABLE ref_person ADD COLUMN hire_date TEXT",
    "ALTER TABLE cost_rate ADD COLUMN annual REAL",
  ]) { try { db.exec(sql); } catch { /* column already exists */ } }
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

/* ---------------------------------------------------------------- postgres -- */
/* Lazily required so local dev/tests never need the package. Railway injects
   DATABASE_URL; its managed Postgres requires TLS but presents a cert signed by
   an internal CA, hence rejectUnauthorized:false (standard for Railway/Heroku). */
function pgDriver(connStr) {
  const pg = require("pg");
  const { Pool } = pg;
  // node-postgres defaults that would silently corrupt this app:
  //   NUMERIC (1700) arrives as a STRING to avoid float precision loss — but every
  //   hours value would then be "100.00" and arithmetic would concatenate.
  //   DATE (1082) arrives as a JS Date in LOCAL time — 2026-08-01 can become
  //   2026-07-31T23:00 and land in the wrong month. Keep it as the raw string.
  pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
  pg.types.setTypeParser(1082, (v) => v);
  const conn = connStr || process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL is required for the postgres driver");
  const pool = new Pool({
    connectionString: conn,
    ssl: /localhost|127\.0\.0\.1/.test(conn) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  // `?` placeholders -> $1..$n  (keeps one SQL dialect across both drivers)
  const toNumbered = (s) => { let i = 0; return s.replace(/\?/g, () => `$${++i}`); };
  // Inside tx() every statement must run on the SAME client, or BEGIN/COMMIT
  // would apply to a different pooled connection than the writes.
  let txClient = null;
  const exec = async (q, params) => (txClient || pool).query(toNumbered(q), params);
  return {
    kind: "postgres",
    all: async (q, params = []) => (await exec(q, params)).rows,
    get: async (q, params = []) => (await exec(q, params)).rows[0],
    run: async (q, params = []) => ({ changes: (await exec(q, params)).rowCount || 0 }),
    tx: async (fn) => {
      if (txClient) return fn();                  // already inside a transaction
      const c = await pool.connect();
      txClient = c;
      try { await c.query("BEGIN"); const out = await fn(); await c.query("COMMIT"); return out; }
      catch (e) { await c.query("ROLLBACK"); throw e; }
      finally { txClient = null; c.release(); }
    },
    close: () => pool.end(),
  };
}

function open(opts = {}) {
  const driver = opts.driver || process.env.DB_DRIVER || "sqlite";
  if (driver === "postgres") return pgDriver(opts.conn);
  return sqliteDriver(opts.file || process.env.DB_FILE || ":memory:");
}

/* --------------------------------------------------------------- audit log -- */
async function audit(db, actor, entity, key, action, oldV, newV) {
  await db.run(
    "INSERT INTO audit_log (at, actor, entity, entity_key, action, old_value, new_value) VALUES (?,?,?,?,?,?,?)",
    [nowIso(), actor, entity, key, action, oldV == null ? null : String(oldV), newV == null ? null : String(newV)]
  );
}

module.exports = { open, nowIso, audit };
