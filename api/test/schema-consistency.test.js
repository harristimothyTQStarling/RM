"use strict";
/**
 * Static guard for the class of bug that reached production: a table referenced
 * in the code but named differently (or cased differently) from the schema.
 *
 * Postgres folds unquoted identifiers to lowercase, so `FROM CapacityOverride`
 * silently became `capacityoverride` — which didn't match the `capacity_override`
 * the schema created. SQLite is case-insensitive, so every test passed while
 * production 500'd. This test compares under Postgres folding rules (lowercase),
 * across both the Postgres and SQLite schemas.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
const fold = (s) => s.toLowerCase();

// Tables referenced by the code (FROM/INTO/UPDATE/DELETE FROM <name>), minus the
// ${table} interpolations in odoo.js replaceAll (those are passed known-good).
const code = ["../src/store.js", "../src/db.js", "../src/handlers.js"].map(read).join("\n");
// Case-SENSITIVE uppercase keywords: in these files SQL keywords are always
// upper-cased inside the query strings, so this ignores lowercase "from"/"into"
// that appear in comments and JS. And [ \t]+ (not \s+) keeps the match on one
// line, so a keyword at a line end can't pair with the next line's token.
const referenced = new Set(
  [...code.matchAll(/\b(?:FROM|INTO|UPDATE|DELETE[ \t]+FROM|JOIN)[ \t]+([a-z_][a-z0-9_]*)\b/g)]
    .map((m) => fold(m[1]))
);

function tablesIn(schemaPath) {
  return new Set(
    [...read(schemaPath).matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)]
      .map((m) => fold(m[1]))
  );
}
const pg = tablesIn("../../db/schema.postgres.sql");
const sqlite = tablesIn("../../db/schema.sqlite.sql");

test("every table referenced in code exists in the Postgres schema (folded)", () => {
  for (const t of referenced) assert.ok(pg.has(t), `code queries "${t}" but no such table in schema.postgres.sql`);
});

test("every table referenced in code exists in the SQLite schema (folded)", () => {
  for (const t of referenced) assert.ok(sqlite.has(t), `code queries "${t}" but no such table in schema.sqlite.sql`);
});

test("the two schemas define the same set of tables", () => {
  assert.deepEqual([...pg].sort(), [...sqlite].sort(), "schema.postgres.sql and schema.sqlite.sql define different tables");
});

test("sanity: the previously-broken multi-word tables are present", () => {
  for (const t of ["allocation", "capacity_override", "import_map", "audit_log", "ref_actual", "sync_state"]) {
    assert.ok(pg.has(t) && sqlite.has(t), `${t} missing from a schema`);
    assert.ok(referenced.has(t) || ["ref_actual", "sync_state"].includes(t), `${t} not referenced (ref_/sync are read via getReference)`);
  }
});
