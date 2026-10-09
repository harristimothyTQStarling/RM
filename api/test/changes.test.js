"use strict";
/**
 * Plan change tracking — the contract:
 *   - daily plan_snapshot rows written idempotently per day
 *   - GET /api/changes diffs the snapshots nearest on-or-before the two dates
 *     (today's snapshot is taken lazily) and returns the audit feed between
 *   - open to every signed-in user (same plan detail viewers already see)
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, fresh, fm, call } = require("./helpers");
const store = require("../src/store");

process.env.EDITOR_UPNS = "tim@tqstarling.com";
const TIM = as("tim@tqstarling.com");
const JANE = as("jane@tqstarling.com");

const iso = (d) => d.toISOString().slice(0, 10);
const yesterday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return iso(d); };

test("changes are open to every signed-in user", async () => {
  const db = fresh();
  assert.equal((await call(db, "GET", "/api/changes", null, JANE)).status, 200, "viewers can read the history");
  assert.equal((await call(db, "GET", "/api/changes", null, TIM)).status, 200);
});

test("snapshot diff: adds, edits and removals between two dates", async () => {
  const db = fresh();
  const put = (tgt, mon, hours, version) => call(db, "PUT", "/api/allocation",
    { resourceKey: "emp:1", targetKey: tgt, month: mon, hours, version }, TIM);

  // State as of "yesterday": 100h on prj:9 in month fm(1).
  assert.equal((await put("prj:9", fm(1), 100, 0)).status, 200);
  await store.takeSnapshot(db, yesterday());

  // Today's edits: bump to 150, move 40h of it conceptually to fm(2), add a new pair.
  assert.equal((await put("prj:9", fm(1), 110, 1)).status, 200);
  assert.equal((await put("prj:9", fm(2), 40, 0)).status, 200);
  assert.equal((await put("prj:7", fm(1), 60, 0)).status, 200);

  const r = await call(db, "GET", "/api/changes", null, TIM, { from: yesterday(), to: iso(new Date()) });
  assert.equal(r.status, 200);
  assert.equal(r.body.fromSnap, yesterday(), "from resolves to the snapshot on/before the date");
  const by = Object.fromEntries(r.body.changes.map(c => [`${c.targetKey}|${c.month}`, c]));
  assert.deepEqual({ b: by[`prj:9|${fm(1)}`].before, a: by[`prj:9|${fm(1)}`].after }, { b: 100, a: 110 }, "edit diffed");
  assert.deepEqual({ b: by[`prj:9|${fm(2)}`].before, a: by[`prj:9|${fm(2)}`].after }, { b: 0, a: 40 }, "new month appears as 0 -> 40");
  assert.deepEqual({ b: by[`prj:7|${fm(1)}`].before, a: by[`prj:7|${fm(1)}`].after }, { b: 0, a: 60 }, "new pair appears");
  assert.equal(r.body.changes.length, 3, "unchanged rows are not reported");
  assert.ok(r.body.events.length >= 3, "audit feed covers the window");
  assert.ok(r.body.events.every(e => e.actor === "tim@tqstarling.com"));
});

test("takeSnapshot is idempotent per day and rate-stamped", async () => {
  const db = fresh();
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:1", targetKey: "prj:9", month: fm(1), hours: 10, version: 0 }, TIM);
  await call(db, "PUT", "/api/rate", { resourceKey: "emp:1", targetKey: "prj:9", rate: 150, version: 0 }, TIM);
  const d = "2030-01-01";
  await store.takeSnapshot(db, d);
  await store.takeSnapshot(db, d);   // second run replaces, not duplicates
  const rows = await db.all("SELECT * FROM plan_snapshot WHERE snap_date = ?", [d]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].rate), 150, "pair rate captured on the snapshot row");
});

test("a range before any snapshot falls back to the earliest one", async () => {
  const db = fresh();
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:1", targetKey: "prj:9", month: fm(1), hours: 25, version: 0 }, TIM);
  const r = await call(db, "GET", "/api/changes", null, TIM, { from: "2000-01-01", to: "2000-02-01" });
  assert.equal(r.status, 200);
  assert.equal(r.body.changes.length, 0, "same snapshot on both sides -> no changes");
});
