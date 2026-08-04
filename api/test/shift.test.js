"use strict";
/**
 * TBH -> employee forecast handover (POST /api/tbh/shift).
 * Months from the current month onward move; closed months stay; collisions and
 * bill rates follow the caller's chosen mode; the seat can be removed after.
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, fresh, fm, call: rawCall } = require("./helpers");

process.env.EDITOR_UPNS = "tim@tqstarling.com,sam@tqstarling.com";
const EDITOR = as("tim@tqstarling.com");
const VIEWER = as("jane@tqstarling.com");
const call = (db, method, path, body, headers = EDITOR, query = {}) => rawCall(db, method, path, body, headers, query);

/** Seed a seat with future forecast on two projects + the employee to receive it. */
async function seed(db) {
  db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (110,'Alex Rivera','Senior Technical Consultant','Delivery','employee',1)");
  db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (111,'Jordan Lee','Technical Consultant','Delivery','employee',1)");
  await call(db, "PUT", "/api/tbh", { tbhKey: "tc-1", name: "To Hire - TC #1", role: "Technical Consultant", dept: "Delivery", start: fm(0), cap: 160 });
  await call(db, "PUT", "/api/allocation", { resourceKey: "tbh:tc-1", targetKey: "prj:101", month: fm(0), hours: 120, version: 0 });
  await call(db, "PUT", "/api/allocation", { resourceKey: "tbh:tc-1", targetKey: "prj:101", month: fm(1), hours: 140, version: 0 });
  await call(db, "PUT", "/api/allocation", { resourceKey: "tbh:tc-1", targetKey: "prj:102", month: fm(1), hours: 60, version: 0 });
}
const allocs = async (db, rk) => (await call(db, "GET", "/api/plan")).body.allocations.filter(a => a.resourceKey === rk);

test("shift moves all future forecast to the employee and can remove the seat", async () => {
  const db = fresh(); await seed(db);
  const r = await call(db, "POST", "/api/tbh/shift", {
    tbhKey: "tc-1",
    moves: [{ targetKey: "prj:101", employeeId: 110 }, { targetKey: "prj:102", employeeId: 110 }],
    removeSeat: true,
  });
  assert.equal(r.status, 200);
  assert.deepEqual({ moved: r.body.moved, seatRemoved: r.body.seatRemoved }, { moved: 3, seatRemoved: true });
  assert.equal((await allocs(db, "tbh:tc-1")).length, 0, "nothing left on the seat");
  const mine = await allocs(db, "emp:110");
  assert.equal(mine.length, 3);
  assert.equal(mine.reduce((s, a) => s + a.hours, 0), 320, "all hours preserved");
  const plan = await call(db, "GET", "/api/plan");
  assert.equal(plan.body.tbh.length, 0, "seat gone");
});

test("projects can be split across different employees", async () => {
  const db = fresh(); await seed(db);
  const r = await call(db, "POST", "/api/tbh/shift", {
    tbhKey: "tc-1",
    moves: [{ targetKey: "prj:101", employeeId: 110 }, { targetKey: "prj:102", employeeId: 111 }],
  });
  assert.equal(r.status, 200);
  assert.equal((await allocs(db, "emp:110")).length, 2, "prj:101 months to Alex");
  assert.equal((await allocs(db, "emp:111")).length, 1, "prj:102 month to Jordan");
});

test("a partial move leaves the unselected project on the seat", async () => {
  const db = fresh(); await seed(db);
  await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }] });
  const left = await allocs(db, "tbh:tc-1");
  assert.deepEqual(left.map(a => a.targetKey), ["prj:102"], "prj:102 stays on the seat");
});

test("closed-month forecast stays behind", async () => {
  const db = fresh(); await seed(db);
  // a retained past-month forecast row on the seat (inserted directly — the API
  // rightly refuses to write past months)
  db.run("INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline','tbh:tc-1','prj:101',?,80,'x','2026-01-01',1)", [`${fm(-2)}-01`]);
  await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }] });
  const seat = await allocs(db, "tbh:tc-1");
  const p101Left = seat.filter(a => a.targetKey === "prj:101").map(a => a.month);
  assert.deepEqual(p101Left, [fm(-2)], "only prj:101's closed month remains on the seat (prj:102 wasn't moved)");
  assert.equal((await allocs(db, "emp:110")).every(a => a.month >= fm(0)), true, "employee got only open months");
});

test("collision modes: sum, replace, skip", async () => {
  for (const [mode, expectHours, expectSeatRows] of [["sum", 220, 0], ["replace", 120, 0], ["skip", 100, 1]]) {
    const db = fresh(); await seed(db);
    await call(db, "PUT", "/api/allocation", { resourceKey: "emp:110", targetKey: "prj:101", month: fm(0), hours: 100, version: 0 });
    const r = await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }], collisionMode: mode });
    assert.equal(r.status, 200, mode);
    const cell = (await allocs(db, "emp:110")).find(a => a.month === fm(0));
    assert.equal(cell.hours, expectHours, `${mode}: colliding cell hours`);
    const seatLeft = (await allocs(db, "tbh:tc-1")).filter(a => a.month === fm(0));
    assert.equal(seatLeft.length, expectSeatRows, `${mode}: seat's colliding row ${expectSeatRows ? "stays" : "gone"}`);
  }
});

test("bill rates: copy inherits but never overwrites; overwrite wins; none leaves nothing", async () => {
  const mkDb = async () => { const db = fresh(); await seed(db);
    await call(db, "PUT", "/api/rate", { resourceKey: "tbh:tc-1", targetKey: "prj:101", rate: 150, version: 0 });
    await call(db, "PUT", "/api/rate", { resourceKey: "tbh:tc-1", targetKey: "prj:102", rate: 165, version: 0 });
    await call(db, "PUT", "/api/rate", { resourceKey: "emp:110", targetKey: "prj:101", rate: 185, version: 0 });   // employee already priced
    return db; };
  const rates = async (db) => Object.fromEntries((await call(db, "GET", "/api/plan")).body.rates
    .filter(r => r.resourceKey === "emp:110").map(r => [r.targetKey, r.rate]));

  let db = await mkDb();
  await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }, { targetKey: "prj:102", employeeId: 110 }], rateMode: "copy" });
  assert.deepEqual(await rates(db), { "prj:101": 185, "prj:102": 165 }, "copy keeps the employee's existing 185");

  db = await mkDb();
  await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }], rateMode: "overwrite" });
  assert.equal((await rates(db))["prj:101"], 150, "overwrite: seat rate wins");

  db = await mkDb();
  await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:102", employeeId: 110 }], rateMode: "none" });
  assert.equal((await rates(db))["prj:102"], undefined, "none: nothing copied");
});

test("validation: unknown seat, unknown employee, bad modes; viewers 403", async () => {
  const db = fresh(); await seed(db);
  assert.equal((await call(db, "POST", "/api/tbh/shift", { tbhKey: "nope", moves: [{ targetKey: "prj:1", employeeId: 110 }] })).status, 400);
  assert.equal((await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 999 }] })).status, 400, "not an active Odoo person");
  assert.equal((await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }], collisionMode: "banana" })).status, 400);
  assert.equal((await call(db, "POST", "/api/tbh/shift", { tbhKey: "tc-1", moves: [{ targetKey: "prj:101", employeeId: 110 }] }, VIEWER)).status, 403);
});
