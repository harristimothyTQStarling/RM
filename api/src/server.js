"use strict";
/**
 * Local dev server — node core only, no npm install.
 *   DEV_USER="tim@tqstarling.com" DEV_ROLES="Planner.Editor" node api/src/server.js
 * Serves the API and the static UI in web/ so the whole app runs offline.
 * In Azure this file is unused: Static Web Apps serves web/ and the Functions
 * adapter serves the API — both over the same handlers.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { open } = require("./db");
const { handle } = require("./handlers");

const PORT = Number(process.env.PORT || 7071);
const WEB = path.join(__dirname, "../../web");
const db = open({ file: process.env.DB_FILE || path.join(__dirname, "../../.dev.db") });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".ico": "image/x-icon" };

const readBody = (req) => new Promise((res, rej) => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 5e6) req.destroy(); });
  req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new Error("bad json")); } });
  req.on("error", rej);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (url.pathname.startsWith("/api/")) {
    try {
      const body = ["PUT", "POST", "PATCH"].includes(req.method) ? await readBody(req) : {};
      const out = await handle(db, {
        method: req.method, path: url.pathname,
        query: Object.fromEntries(url.searchParams), body, headers: req.headers,
      });
      return send(out.status, out.body);
    } catch (e) { return send(500, { error: String(e.message || e) }); }
  }

  // static UI
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(WEB, path.normalize(p).replace(/^([.][.][/\\])+/, ""));
  if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`resource-planner dev server  http://localhost:${PORT}`);
  console.log(`  db   : ${process.env.DB_FILE || ".dev.db"}`);
  console.log(`  user : ${process.env.DEV_USER || "(none — set DEV_USER to sign in)"}`);
  console.log(`  roles: ${process.env.DEV_ROLES || "Planner.Editor"}`);
});
