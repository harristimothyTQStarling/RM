"use strict";
/**
 * Applies the schema on boot. Idempotent (every statement is CREATE ... IF NOT
 * EXISTS), so it's safe to run on every deploy — Railway restarts containers
 * freely and we don't want a separate migration step to forget.
 *
 * SQLite applies its schema inside the driver itself, so this is a no-op there.
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * Split a schema file into runnable statements.
 *
 * Strip line comments FIRST, then split on ';'. The earlier version split first
 * and dropped any chunk that began with '--', which silently deleted the
 * `CREATE TABLE allocation` block (it follows the file header comment) — the
 * next statement then referenced a table that was never created. The schema has
 * no string literals containing '--' and no functions/DO blocks, so this is safe.
 */
function parseStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, "")          // remove line comments (incl. trailing ones)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrate(db) {
  if (db.kind !== "postgres") return { applied: false, reason: "sqlite applies its own schema" };
  const file = path.join(__dirname, "../../db/schema.postgres.sql");
  const statements = parseStatements(fs.readFileSync(file, "utf8"));
  for (const stmt of statements) await db.run(stmt);
  return { applied: true, statements: statements.length };
}

module.exports = { migrate, parseStatements };
