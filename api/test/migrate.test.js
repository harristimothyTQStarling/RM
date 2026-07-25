"use strict";
/**
 * Schema-loader tests. This is the code that ran on the real Postgres and
 * crash-looped the first deploy ("relation allocation does not exist"), so it
 * gets its own coverage: every table must survive parsing, and no CREATE INDEX
 * may reference a table that hasn't been created yet.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { parseStatements } = require("../src/migrate");

const schema = fs.readFileSync(path.join(__dirname, "../../db/schema.postgres.sql"), "utf8");
const stmts = parseStatements(schema);

const EXPECTED_TABLES = [
  "allocation", "capacity_override", "tbh", "import_map", "audit_log",
  "ref_person", "ref_project", "ref_opportunity", "ref_actual", "sync_state",
];

test("every expected table is created (none dropped by comment stripping)", () => {
  const created = stmts
    .map((s) => (s.match(/CREATE TABLE IF NOT EXISTS (\w+)/i) || [])[1])
    .filter(Boolean);
  for (const t of EXPECTED_TABLES) assert.ok(created.includes(t), `CREATE TABLE ${t} is missing from parsed statements`);
});

test("no statement is a leftover comment or empty", () => {
  for (const s of stmts) {
    assert.ok(s.length > 0);
    assert.ok(!s.startsWith("--"), `a comment leaked through as a statement: ${s.slice(0, 40)}`);
  }
});

test("every CREATE INDEX targets a table created earlier (the crash's exact cause)", () => {
  const createdSoFar = new Set();
  for (const s of stmts) {
    const tbl = (s.match(/CREATE TABLE IF NOT EXISTS (\w+)/i) || [])[1];
    if (tbl) createdSoFar.add(tbl);
    const idx = s.match(/CREATE INDEX[\s\S]*? ON (\w+)/i);
    if (idx) assert.ok(createdSoFar.has(idx[1]), `index on "${idx[1]}" is ordered before its CREATE TABLE`);
  }
});

test("inline comments are stripped but the SQL is intact", () => {
  // e.g. `month DATE NOT NULL,  -- always the 1st of the month`
  const alloc = stmts.find((s) => /CREATE TABLE IF NOT EXISTS allocation/i.test(s));
  assert.ok(alloc, "allocation statement present");
  assert.ok(!alloc.includes("--"), "no comment residue inside the statement");
  assert.ok(/month\s+DATE\s+NOT NULL/i.test(alloc), "the month column definition survived");
  assert.ok(/UNIQUE \(scenario, resource_key, target_key, month\)/i.test(alloc), "the unique key survived");
});
