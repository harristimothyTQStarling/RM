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

async function migrate(db) {
  if (db.kind !== "postgres") return { applied: false, reason: "sqlite applies its own schema" };
  const file = path.join(__dirname, "../../db/schema.postgres.sql");
  const sql = fs.readFileSync(file, "utf8");
  // Split on semicolons at end-of-line; the schema deliberately contains no
  // functions/DO blocks, so this simple split is safe.
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
  for (const stmt of statements) await db.run(stmt);
  return { applied: true, statements: statements.length };
}

module.exports = { migrate };
