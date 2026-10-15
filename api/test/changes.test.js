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

test("labels name departed people and closed opportunities (inactive rows)", async () => {
  const db = fresh();
  // History references ids the live roster no longer carries: both rows are
  // inactive, exactly as the mark-inactive sync leaves them.
  db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (155,'Donald Lort','','','contractor',0)");
  db.run("INSERT INTO ref_opportunity (id,name,client,stage,active) VALUES (222,'Advocate - SPM','Advocate','Won',0)");
  const y = yesterday(), t = iso(new Date());
  db.run("INSERT INTO plan_snapshot (snap_date,resource_key,target_key,month,hours,rate) VALUES (?,?,?,?,?,?)",
    [y, "emp:155", "crm:222", "2026-11-01", 100, 150]);
  // one live row so the lazy "today" snapshot is non-empty (a real plan never is)
  db.run("INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline','emp:1','prj:9',?,10,'x','2026-01-01',1)", [`${fm(1)}-01`]);

  const r = await call(db, "GET", "/api/changes", null, TIM, { from: y, to: t });
  assert.equal(r.status, 200);
  const c = r.body.changes.find(x => x.resourceKey === "emp:155");
  assert.ok(c && c.before === 100 && c.after === 0, "the removal is in the diff");
  assert.equal(r.body.labels["emp:155"], "Donald Lort", "departed person still has a name");
  assert.equal(r.body.labels["crm:222"], "Advocate - SPM", "closed opportunity still has a name");
});

test("a CRM -> project conversion reads as a zero-net transfer, not add+remove", async () => {
  const db = fresh();
  db.run("INSERT INTO ref_opportunity (id,name,client,stage,active) VALUES (9,'Advocate Health - BCM','Advocate','Won',1)");
  db.run("INSERT INTO ref_project (id,name,client,billable,active) VALUES (777,'Advocate Health - BCM Design','Advocate Health, Inc.',1,1)");
  const put = (tgt, mon, hours, version) => call(db, "PUT", "/api/allocation",
    { resourceKey: "emp:1", targetKey: tgt, month: mon, hours, version }, TIM);
  assert.equal((await put("crm:9", fm(1), 100, 0)).status, 200);
  assert.equal((await put("crm:9", fm(2), 60, 0)).status, 200);
  await store.takeSnapshot(db, yesterday());

  // The win converts: forecast moves crm:9 -> prj:777 (audited reassign + map)...
  assert.equal((await call(db, "POST", "/api/opportunity/map", { oppId: 9, projectId: 777 }, TIM)).status, 200);
  // ...and afterwards someone genuinely adds 10h to the first month.
  db.run("UPDATE allocation SET hours = 110 WHERE target_key='prj:777' AND month = ?", [`${fm(1)}-01`]);

  const r = await call(db, "GET", "/api/changes", null, TIM, { from: yesterday(), to: iso(new Date()) });
  assert.equal(r.status, 200);
  const trs = r.body.transfers.map(t => [t.fromKey, t.toKey, t.month, t.hours]).sort();
  assert.deepEqual(trs, [["crm:9", "prj:777", fm(1), 100], ["crm:9", "prj:777", fm(2), 60]],
    "the carried-over hours are transfers");
  assert.deepEqual(r.body.changes.map(c => [c.targetKey, c.month, c.before, c.after]),
    [["prj:777", fm(1), 0, 10]], "only the genuine post-move edit remains a change");
  assert.equal(r.body.labels["crm:9"], "Advocate Health - BCM");
  assert.equal(r.body.labels["prj:777"], "Advocate Health - BCM Design");
});

test("a range before any snapshot falls back to the earliest one", async () => {
  const db = fresh();
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:1", targetKey: "prj:9", month: fm(1), hours: 25, version: 0 }, TIM);
  const r = await call(db, "GET", "/api/changes", null, TIM, { from: "2000-01-01", to: "2000-02-01" });
  assert.equal(r.status, 200);
  assert.equal(r.body.changes.length, 0, "same snapshot on both sides -> no changes");
});
