#!/usr/bin/env node
"use strict";
/**
 * DEV FIXTURE ONLY — populates the ref_* tables with a small sample so the UI can
 * be developed and tested before the Odoo service account exists.
 *
 * This is NOT the production path: real reference data comes from the live Odoo
 * sync (POST /api/sync -> api/src/odoo.js). Never run this against production.
 */
const { open } = require("../api/src/db");
const db = open({ file: process.env.DB_FILE || "./.dev.db" });

const people = [
  [110,"Ken Sousa","Engagement Manager","Delivery","employee"],
  [108,"Ian Brown","Senior Solution Consultant","Delivery","employee"],
  [111,"Kevin Frost","Senior Solution Consultant","Delivery","employee"],
  [142,"Jared Prim","Senior Solution Consultant","Business Advisory","employee"],
  [47,"Arvin Visco","Technical Consultant","Contractor","contractor"],
  [46,"Brenno Borges","Senior Technical Consultant","Contractor","contractor"],
];
const projects = [
  [119,"Bain Phase 2B – Discovery","Bain & Company",1],
  [99,"TD Bank – IRM Implementation (Co-Delivery)","TD Bank",1],
  [105,"Non-Billable Time","Internal",0],
];
const opps = [
  [222,"Advocate Health - BCM Design and Implementation","Advocate Health","Negotiate"],
  [388,"Medtronic - Managed Services (POD) - ITSM Instance","Medtronic","Negotiate"],
];
const actuals = [
  [110,105,"2026-05-01",135], [110,105,"2026-06-01",133],
  [108,99,"2026-05-01",151], [108,99,"2026-06-01",149],
];

(async () => {
  for (const t of ["ref_person","ref_project","ref_opportunity","ref_actual","sync_state"]) await db.run(`DELETE FROM ${t}`);
  for (const p of people)  await db.run("INSERT INTO ref_person (id,name,role,dept,type,active) VALUES (?,?,?,?,?,1)", p);
  for (const p of projects) await db.run("INSERT INTO ref_project (id,name,client,billable,active) VALUES (?,?,?,?,1)", p);
  for (const o of opps)    await db.run("INSERT INTO ref_opportunity (id,name,client,stage,active) VALUES (?,?,?,?,1)", o);
  for (const a of actuals) await db.run("INSERT INTO ref_actual (employee_id,project_id,month,hours) VALUES (?,?,?,?)", a);
  const now = new Date().toISOString();
  for (const s of ["ref_person","ref_project","ref_opportunity","ref_actual"])
    await db.run("INSERT INTO sync_state (source,synced_at,row_count,ok,message) VALUES (?,?,?,1,'dev fixture')", [s, now, 0]);
  console.log(`dev fixture: ${people.length} people, ${projects.length} projects, ${opps.length} opportunities, ${actuals.length} actuals`);
})();
