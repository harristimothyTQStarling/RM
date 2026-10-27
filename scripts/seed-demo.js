"use strict";
/* Seed a local SQLite planner db with fictional-but-plausible sample data for
   dev verification and screenshots. Nothing here is real client data.
   Usage: node scripts/seed-demo.js <path-to-sqlite-file>                     */
const path = require("path");
const { open } = require(path.join(__dirname, "../api/src/db.js"));

const FILE = process.argv[2];
if (!FILE) { console.error("usage: node scripts/seed-demo.js <db-file>"); process.exit(1); }
const db = open({ driver: "sqlite", file: FILE });
const now = "2026-08-01 12:00:00";
const U = "tim@tqstarling.com";

const run = (sql, p) => db.run(sql, p);

(async () => {
  const people = [
    [1, "Alex Rivera", "Senior Technical Consultant", "Delivery", "employee", "2024-02-01", null],
    [2, "Jordan Lee", "Technical Consultant", "Delivery", "employee", "2025-05-12", null],
    [3, "Sam Patel", "Business Process Consultant", "Business Advisory", "employee", "2024-09-16", null],
    [4, "Morgan Chen", "Solutions Architect", "Delivery", "employee", "2023-11-01", null],
    [5, "Casey Nguyen", "Engagement Manager", "Delivery", "employee", "2024-06-03", "2026-10-16"],
    [6, "Riley Brooks", "Technical Consultant", "Contractor", "contractor", "2025-01-06", null],
    [7, "Taylor Kim", "Senior QA", "Delivery", "employee", "2026-03-16", null],
  ];
  for (const [id, name, role, dept, type, hire, end] of people)
    await run("INSERT INTO ref_person (id,name,role,dept,type,active,hire_date,end_date) VALUES (?,?,?,?,?,1,?,?)", [id, name, role, dept, type, hire, end]);

  const holidays = [
    [1, "New Year's Day", "2026-01-01"], [2, "Memorial Day", "2026-05-25"],
    [3, "Independence Day (obs)", "2026-07-03"], [4, "Labor Day", "2026-09-07"],
    [5, "Thanksgiving", "2026-11-26"], [6, "Day after Thanksgiving", "2026-11-27"],
    [7, "Christmas Day", "2026-12-25"], [8, "New Year's Day", "2027-01-01"],
  ];
  for (const [id, name, d] of holidays)
    await run("INSERT INTO ref_holiday (id,name,date_from,date_to) VALUES (?,?,?,?)", [id, name, d, d]);

  const projects = [
    [101, "Northwind - IRM Implementation", "Northwind Bank", 1, "tm"],
    [102, "Contoso - BCM Upgrade", "Contoso Energy", 1, "tm"],
    [103, "Fabrikam - CMDB Advisory", "Fabrikam Pharma", 1, "tm"],
    [104, "Non-Billable Time", "Internal", 0, "tm"],
    [105, "Lamna - BCM Design and Implementation", "Lamna Healthcare", 1, "milestone"],
  ];
  for (const [id, name, client, billable, btype] of projects)
    await run("INSERT INTO ref_project (id,name,client,billable,active,billing_type) VALUES (?,?,?,?,1,?)", [id, name, client, billable, btype]);

  const milestones = [
    [1, 105, "Phase 0-1: Enablement & Requirements", 0, 1],
    [2, 105, "Phase 2: Data Shaping & Validation", 46500, 0],
    [3, 105, "Phase 3: Configuration & Wave Execution", 27000, 0],
    [4, 105, "SOW Execution", 38500, 0],
  ];
  for (const [id, pid2, name, amount, reached] of milestones)
    await run("INSERT INTO ref_milestone (id,project_id,name,amount,reached) VALUES (?,?,?,?,?)", [id, pid2, name, amount, reached]);

  const opps = [
    [201, "Adventure Works - SPM Implementation", "Adventure Works", "Negotiate", 1, 0, "2026-09-01", 4],
    [202, "Tailspin - GRC Advisory", "Tailspin Toys", "Propose", 1, 0, "2026-10-01", 3],
    [203, "Wingtip - HRSD Phase 2", "Wingtip Airlines", "Validate", 1, 0, "2026-11-01", 2],
    [204, "Litware - AICT Implementation", "Litware Utilities", "Won", 1, 1, "2026-07-01", 6],
  ];
  for (const [id, name, client, stage, active, np, start, months] of opps)
    await run("INSERT INTO ref_opportunity (id,name,client,stage,active,needs_project,expected_start,expected_months) VALUES (?,?,?,?,?,?,?,?)",
      [id, name, client, stage, active, np, start, months]);

  const act = [];
  const A = (emp, proj, month, hours, rate) => act.push([emp, proj, `2026-0${month}-01`, hours, rate, Math.round(hours * rate)]);
  for (let m = 1; m <= 7; m++) {
    A(1, 101, m, [152, 160, 148, 155, 160, 150, 146][m - 1], 185);
    A(2, 101, m, [140, 132, 150, 128, 145, 138, 152][m - 1], 150);
    A(2, 104, m, [12, 20, 8, 24, 10, 16, 8][m - 1], 0);
    A(3, 103, m, [96, 110, 120, 104, 98, 116, 108][m - 1], 165);
    A(4, 102, m, [150, 155, 160, 140, 152, 158, 149][m - 1], 195);
    A(5, 101, m, [60, 55, 70, 64, 58, 66, 62][m - 1], 200);
    A(6, 102, m, [160, 160, 152, 160, 148, 160, 156][m - 1], 120);
    A(7, 103, m, [80, 88, 92, 76, 84, 90, 86][m - 1], 140);
  }
  for (const [e, p, mo, h, r, rev] of act)
    await run("INSERT INTO ref_actual (employee_id,project_id,month,hours,bill_rate,revenue) VALUES (?,?,?,?,?,?)", [e, p, mo, h, r, rev]);

  const al = [];
  const F = (res, tgt, month, hours) => al.push([res, tgt, month, hours]);
  const mk = (m) => `2026-${String(m).padStart(2, "0")}-01`;
  const fore = { 1: [150, 150, 150, 150, 150, 150, 150], 2: [160, 160, 160, 160, 160, 160, 150], 3: [100, 100, 120, 100, 100, 120, 110], 4: [150, 150, 150, 150, 150, 150, 150], 5: [80, 80, 80, 80, 80, 80, 60], 6: [160, 160, 160, 160, 160, 160, 160], 7: [80, 80, 90, 80, 80, 90, 80] };
  const proj = { 1: 101, 2: 101, 3: 103, 4: 102, 5: 101, 6: 102, 7: 103 };
  for (const pid of Object.keys(fore))
    fore[pid].forEach((h, i) => F(`emp:${pid}`, `prj:${proj[pid]}`, mk(i + 1), h));
  for (let m = 8; m <= 12; m++) {
    F("emp:1", "prj:101", mk(m), 140); F("emp:2", "prj:101", mk(m), 150);
    F("emp:3", "prj:103", mk(m), m <= 9 ? 110 : 0); F("emp:4", "prj:102", mk(m), 150);
    F("emp:5", "prj:101", mk(m), 60); F("emp:6", "prj:102", mk(m), 160);
    F("emp:7", "prj:103", mk(m), 80);
  }
  const mk27 = (m) => `2027-${String(m).padStart(2, "0")}-01`;
  for (let m = 1; m <= 6; m++) {
    F("emp:1", "prj:101", mk27(m), 130); F("emp:2", "prj:101", mk27(m), 140);
    F("emp:4", "prj:102", mk27(m), 150); F("emp:6", "prj:102", mk27(m), 160);
  }
  F("emp:3", "crm:202", mk27(1), 90); F("emp:3", "crm:202", mk27(2), 90);
  F("emp:1", "crm:201", mk(10), 60); F("emp:1", "crm:201", mk(11), 80); F("emp:2", "crm:201", mk(12), 80);
  F("emp:4", "crm:203", mk(11), 40); F("emp:4", "crm:203", mk(12), 40);
  F("emp:3", "crm:204", mk(8), 60); F("emp:3", "crm:204", mk(9), 60);
  // fixed-fee milestone project: hours are staffed normally, revenue comes from
  // the milestone schedule (no bill_rate rows for these pairs on purpose)
  for (let m = 10; m <= 12; m++) { F("emp:1", "prj:105", mk(m), 40); F("emp:7", "prj:105", mk(m), 60); }
  await run("INSERT INTO tbh (scenario,tbh_key,name,role,dept,shore,start_month,capacity,updated_by,updated_at,version) VALUES ('baseline','tba-technical-consultant-onshore','TBA - Technical Consultant (Onshore)','Technical Consultant','Delivery','onshore',NULL,NULL,?,?,1)", [U, now]);
  await run("INSERT INTO tbh (scenario,tbh_key,name,role,dept,shore,start_month,capacity,updated_by,updated_at,version) VALUES ('baseline','tba-technical-consultant-offshore','TBA - Technical Consultant (Offshore)','Technical Consultant','Delivery','offshore',NULL,NULL,?,?,1)", [U, now]);
  for (let m = 9; m <= 12; m++) F("tbh:tba-technical-consultant-onshore", "prj:102", mk(m), 120);
  for (let m = 10; m <= 12; m++) F("tbh:tba-technical-consultant-offshore", "prj:101", mk(m), 80);
  await run("INSERT INTO proposed_hire (scenario,resource_key,target_key,name,updated_by,updated_at) VALUES ('baseline','tbh:tba-technical-consultant-onshore','prj:102','Jason Kuhar',?,?)", [U, now]);
  await run("INSERT INTO proposed_hire (scenario,resource_key,target_key,name,updated_by,updated_at) VALUES ('baseline','tbh:tba-technical-consultant-offshore','prj:101','Rohan Panwar',?,?)", [U, now]);
  for (const [e, p, h, r] of [[1,101,42,185],[2,101,38,150],[3,103,26,165],[4,102,40,195],[6,102,44,120]])
    await run("INSERT INTO ref_actual (employee_id,project_id,month,hours,bill_rate,revenue) VALUES (?,?,?,?,?,?)", [e, p, "2026-08-01", h, r, Math.round(h*r)]);
  for (const [r, t, mo, h] of al.filter(x => x[3] > 0))
    await run("INSERT INTO allocation (scenario,resource_key,target_key,month,hours,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?,?,?,1)", [r, t, mo, h, U, now]);

  const rates = [["emp:1", "prj:101", 185], ["emp:2", "prj:101", 150], ["emp:3", "prj:103", 165], ["emp:4", "prj:102", 195], ["emp:5", "prj:101", 200], ["emp:6", "prj:102", 120], ["emp:7", "prj:103", 140], ["emp:1", "crm:201", 175], ["emp:2", "crm:201", 150], ["emp:4", "crm:203", 195], ["emp:3", "crm:202", 170], ["tbh:tba-technical-consultant-onshore", "prj:102", 150], ["tbh:tba-technical-consultant-offshore", "prj:101", 85]];
  for (const [r, t, rate] of rates)
    await run("INSERT INTO bill_rate (scenario,resource_key,target_key,rate,updated_by,updated_at,version) VALUES ('baseline',?,?,?,?,?,1)", [r, t, rate, U, now]);

  const cards = [
    [1, 180000, null, 18300, 107.65], [2, null, null, null, 80], [3, 150000, null, 15250, 89.71],
    [4, null, null, null, 120], [5, null, null, 15000, 100], [6, null, null, null, 95], [7, null, null, 12200, 70],
  ];
  for (const [id, annual, bw, mo, hr] of cards)
    await run("INSERT INTO cost_rate (employee_id,annual,biweekly,monthly,hourly,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)",
      [id, annual, bw, mo, hr, U, now]);
  // projected cost of one unfilled seat (the offshore pool stays uncosted on purpose)
  await run("INSERT INTO cost_rate_tbh (tbh_key,annual,biweekly,monthly,hourly,updated_by,updated_at) VALUES ('tba-technical-consultant-onshore',130000,5874.07,13216.67,77.75,?,?)", [U, now]);

  for (const s of ["ref_person", "ref_project", "ref_opportunity", "ref_actual"])
    await run("INSERT INTO sync_state (source,synced_at,row_count,ok) VALUES (?,?,?,1)", [s, "2026-08-01T07:00:00Z", 42]);

  console.log("seeded", FILE);
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
