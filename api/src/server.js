"use strict";
/**
 * The server — one process serving the UI, the API and the Entra sign-in flow.
 * This is what runs on Railway (and locally); there is no second code path, so
 * what the tests exercise is what ships.
 *
 * Routes
 *   /auth/login | /auth/callback | /auth/logout   Entra OpenID Connect
 *   /api/*                                        JSON API (handlers.js)
 *   /*                                            static UI from web/
 *
 * Everything requires sign-in: this holds staff names, roles and the forecast,
 * and it's on a public URL. Unauthenticated HTML requests are redirected to
 * login; unauthenticated API requests get 401 (so fetch() can react sensibly).
 *
 * Local dev without Entra:
 *   DEV_USER="you@tqstarling.com" EDITOR_UPNS="you@tqstarling.com" npm run dev
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { open } = require("./db");
const { migrate } = require("./migrate");
const { handle } = require("./handlers");
const { getUser } = require("./auth");
const oidc = require("./oidc");

const PORT = Number(process.env.PORT || 7071);          // Railway injects PORT
const WEB = path.join(__dirname, "../../web");
const db = open();

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".woff2": "font/woff2",
};

const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 5e6) req.destroy(); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("malformed json")); } });
  req.on("error", reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const json = (status, obj, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(obj));
  };
  const redirect = (location, cookies = []) => {
    const h = { location };
    if (cookies.length) h["set-cookie"] = cookies;
    res.writeHead(302, h); res.end();
  };

  try {
    /* ------------------------------------------------------------- health -- */
    // Railway probes this; must not require auth.
    if (p === "/healthz") return json(200, { ok: true, db: db.kind });

    /* --------------------------------------------------------------- auth -- */
    if (p === "/auth/login") {
      if (!oidc.isConfigured()) return json(500, { error: "sign-in is not configured (AAD_* / PUBLIC_URL / SESSION_SECRET)" });
      const { location, cookie } = oidc.beginLogin(url.searchParams.get("returnTo") || "/");
      return redirect(location, [cookie]);
    }
    if (p === "/auth/callback") {
      try {
        const q = Object.fromEntries(url.searchParams);
        const { cookies, location } = await oidc.completeLogin(q, req.headers);
        return redirect(location, cookies);
      } catch (e) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<h1>Sign-in failed</h1><p>${escapeHtml(e.message)}</p><p><a href="/auth/login">Try again</a></p>`);
      }
    }
    if (p === "/auth/logout") {
      const { cookies, location } = oidc.logout();
      return redirect(location, cookies);
    }
    // Gusto connect (costing role only): consent redirect + OAuth callback.
    if (p === "/auth/gusto" || p === "/auth/gusto/callback") {
      const { canCost } = require("./auth");
      const gusto = require("./gusto");
      const u = getUser(req.headers);
      if (!u || !canCost(u)) return json(403, { error: "costing role required" });
      try {
        if (p === "/auth/gusto") {
          const { location, cookie } = gusto.beginConnect();
          return redirect(location, [cookie]);
        }
        const q = Object.fromEntries(url.searchParams);
        const { location, cookie } = await gusto.completeConnect(db, q, req.headers);
        return redirect(location, [cookie]);
      } catch (e) {
        res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<h1>Gusto connect failed</h1><p>${escapeHtml(e.message)}</p><p><a href="/auth/gusto">Try again</a> · <a href="/">Back to the planner</a></p>`);
      }
    }

    const user = getUser(req.headers);

    /* ---------------------------------------------------------------- api -- */
    if (p.startsWith("/api/")) {
      const body = ["PUT", "POST", "PATCH"].includes(req.method) ? await readBody(req) : {};
      const out = await handle(db, {
        method: req.method, path: p,
        query: Object.fromEntries(url.searchParams),
        body, headers: req.headers,
      });
      return json(out.status, out.body);
    }

    /* ------------------------------------------------------------ the app -- */
    if (!user) {
      // Not signed in: send the browser to Microsoft, remembering where they were.
      if (!oidc.isConfigured()) {
        res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        return res.end("<h1>Not configured</h1><p>Set AAD_TENANT_ID, AAD_CLIENT_ID, AAD_CLIENT_SECRET, PUBLIC_URL and SESSION_SECRET.</p>");
      }
      return redirect(`/auth/login?returnTo=${encodeURIComponent(p)}`);
    }

    const rel = p === "/" ? "/index.html" : p;
    const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    return fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error("unhandled", e);
    if (!res.headersSent) json(500, { error: "internal error" });   // never leak internals
    else res.end();
  }
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** First run: if Odoo is configured and the reference cache is empty, populate it
 *  so a fresh deploy is usable immediately with no manual sync step. A failure
 *  here must NOT stop the server booting — the app still works, just without
 *  reference data until a sync succeeds. */
async function initialSyncIfEmpty() {
  const { Odoo, syncAll } = require("./odoo");
  const odoo = new Odoo();
  if (!odoo.configured) return "Odoo not configured (set ODOO_* to enable sync)";
  const row = await db.get("SELECT COUNT(*) AS n FROM ref_person");
  if (row && Number(row.n) > 0) return "reference cache present, skipping initial sync";
  const y = new Date().getUTCFullYear();
  const counts = await syncAll(db, odoo, { actualsFrom: `${y}-01-01`, actualsTo: `${y}-12-31` });
  return `initial sync ${JSON.stringify(counts)}`;
}

/** Nightly Odoo sync: refreshes the reference cache (actuals + realized rates,
 *  people/projects, CRM windows) and runs the closed-CRM reconciliation without
 *  anyone clicking Sync Odoo. NIGHTLY_SYNC_UTC_HOUR sets the hour (0-23 UTC,
 *  default 7 ≈ 2-3am US Eastern); "off" disables. A failed run logs and simply
 *  tries again the next night — the cache just stays a day staler. */
function scheduleNightlySync() {
  const { msUntilUtcHour, nightlyHour } = require("./schedule");
  const hour = nightlyHour(process.env.NIGHTLY_SYNC_UTC_HOUR);
  if (hour == null) return "disabled (NIGHTLY_SYNC_UTC_HOUR=off)";
  const arm = () => {
    setTimeout(async () => {
      try {
        const { Odoo, syncAll } = require("./odoo");
        const odoo = new Odoo();
        if (odoo.configured) {
          const y = new Date().getUTCFullYear();
          const counts = await syncAll(db, odoo, { actualsFrom: `${y}-01-01`, actualsTo: `${y}-12-31` });
          console.log(`[nightly-sync] ok ${JSON.stringify(counts)}`);
        } else {
          console.log("[nightly-sync] skipped: Odoo not configured");
        }
      } catch (e) {
        console.error(`[nightly-sync] FAILED (will retry tomorrow): ${e.message}`);
      }
      // Costs refresh nightly too, independently of the Odoo outcome.
      try {
        const { Gusto, syncCosts } = require("./gusto");
        const g = new Gusto();
        if (g.configured) {
          const c = await syncCosts(db, g);
          console.log(`[nightly-sync] gusto ok ${JSON.stringify(c)}`);
        }
      } catch (e) {
        console.error(`[nightly-sync] gusto FAILED (will retry tomorrow): ${e.message}`);
      }
      arm();                                   // schedule the next night
    }, msUntilUtcHour(hour)).unref();          // never keeps a dying process alive
  };
  arm();
  return `nightly at ${String(hour).padStart(2, "0")}:00 UTC`;
}

(async () => {
  const m = await migrate(db);
  // One pool per role: convert/merge any historical To-Be-Hired seats into
  // To-Be-Assigned role pools. Idempotent; a no-op once normalized.
  try {
    const n = await require("./store").normalizeTbaPools(db);
    if (n.merged || n.renamed) console.log(`  tba    : normalized role pools (${n.renamed} renamed, ${n.merged} merged)`);
  } catch (e) { console.error(`  tba    : pool normalization FAILED: ${e.message}`); }
  let odooMsg = "skipped";
  try { odooMsg = await initialSyncIfEmpty(); } catch (e) { odooMsg = `initial sync FAILED: ${e.message}`; console.error(odooMsg); }
  const syncMsg = scheduleNightlySync();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`resource-planner listening on :${PORT}`);
    console.log(`  db     : ${db.kind}${m.applied ? ` (schema applied, ${m.statements} statements)` : ""}`);
    console.log(`  auth   : ${oidc.isConfigured() ? "Entra ID" : process.env.DEV_USER ? `DEV impersonation as ${process.env.DEV_USER}` : "NOT CONFIGURED"}`);
    console.log(`  editors: ${process.env.EDITOR_UPNS || "(none — nobody can edit)"}`);
    console.log(`  odoo   : ${odooMsg}`);
    console.log(`  sync   : ${syncMsg}`);
  });
})().catch((e) => { console.error("startup failed:", e); process.exit(1); });
