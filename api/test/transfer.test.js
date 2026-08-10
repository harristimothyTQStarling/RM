"use strict";
/**
 * POST /api/allocation/transfer — move all or part of one (resource × project)
 * pair's open-month hours to another person or TBA pool.
 */
const test = require("node:test");
const assert = require("node:assert");
const { as, fresh, fm, call: rawCall } = require("./helpers");

process.env.EDITOR_UPNS = "tim@tqstarling.com";
const EDITOR = as("tim@tqstarling.com");
const VIEWER = as("jane@tqstarling.com");
const call = (db, method, path, body, headers = EDITOR) => rawCall(db, method, path, body, headers, {});

async function seed(db) {
  db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (110,'Alex Rivera','Senior Technical Consultant','Delivery','employee',1)");
  db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (112,'Riley Brooks','Technical Consultant','Contractor','contractor',1)");
  db.run("INSERT INTO tbh (scenario,tbh_key,name,role,dept,shore,updated_by,updated_at,version) VALUES ('baseline','tba-technical-consultant-offshore','TBA - Technical Consultant (Offshore)','Technical Consultant','Delivery','offshore','x','2026-01-01',1)");
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:110", targetKey: "prj:101", month: fm(0), hours: 120, version: 0 });
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:110", targetKey: "prj:101", month: fm(1), hours: 100, version: 0 });
  await call(db, "PUT", "/api/rate", { resourceKey: "emp:110", targetKey: "prj:101", rate: 150, version: 0 });
}
const allocs = async (db, rk) => (await call(db, "GET", "/api/plan")).body.allocations.filter(a => a.resourceKey === rk);
const xfer = (db, to, moves, headers) => call(db, "POST", "/api/allocation/transfer",
  { fromResourceKey: "emp:110", toResourceKey: to, targetKey: "prj:101", moves }, headers);

test("partial transfer leaves the remainder; destination sums; rate copies", async () => {
  const db = fresh(); await seed(db);
  await call(db, "PUT", "/api/allocation", { resourceKey: "emp:112", targetKey: "prj:101", month: fm(0), hours: 40, version: 0 });
  const r = await xfer(db, "emp:112", [{ month: fm(0), hours: 50 }, { month: fm(1), hours: 100 }]);
  assert.equal(r.status, 200);
  assert.deepEqual({ moved: r.body.moved, hoursMoved: r.body.hoursMoved }, { moved: 2, hoursMoved: 150 });
  const src = await allocs(db, "emp:110");
  assert.deepEqual(src.map(a => [a.month, a.hours]), [[fm(0), 70]], "50 of 120 left month 0; month 1 fully moved (row gone)");
  const dst = await allocs(db, "emp:112");
  assert.deepEqual(dst.map(a => [a.month, a.hours]).sort(), [[fm(0), 90], [fm(1), 100]], "40+50 summed; 100 landed");
  const rates = (await call(db, "GET", "/api/plan")).body.rates.filter(x => x.resourceKey === "emp:112");
  assert.deepEqual(rates.map(x => x.rate), [150], "source rate copied to the destination pair");
});

test("transfer to a TBA pool works; over-transfer and past months rejected", async () => {
  const db = fresh(); await seed(db);
  const ok = await xfer(db, "tbh:tba-technical-consultant-offshore", [{ month: fm(0), hours: 120 }]);
  assert.equal(ok.status, 200);
  assert.equal((await allocs(db, "tbh:tba-technical-consultant-offshore")).length, 1, "pool received the hours");
  const over = await xfer(db, "tbh:tba-technical-consultant-offshore", [{ month: fm(1), hours: 500 }]);
  assert.equal(over.status, 400);
  assert.match(over.body.error, /only 100h available/);
  const past = await xfer(db, "tbh:tba-technical-consultant-offshore", [{ month: fm(-1), hours: 10 }]);
  assert.equal(past.status, 400, "closed months cannot transfer");
});

test("validation: unknown destination, same-resource, bad keys; viewer 403", async () => {
  const db = fresh(); await seed(db);
  assert.equal((await xfer(db, "emp:999", [{ month: fm(0), hours: 10 }])).status, 400, "inactive person");
  assert.equal((await xfer(db, "tbh:nope", [{ month: fm(0), hours: 10 }])).status, 400, "missing pool");
  assert.equal((await xfer(db, "emp:110", [{ month: fm(0), hours: 10 }])).status, 400, "same resource");
  assert.equal((await call(db, "POST", "/api/allocation/transfer", { fromResourceKey: "bogus", toResourceKey: "emp:112", targetKey: "prj:101", moves: [{ month: fm(0), hours: 1 }] })).status, 400);
  assert.equal((await xfer(db, "emp:112", [{ month: fm(0), hours: 10 }], VIEWER)).status, 403);
});
