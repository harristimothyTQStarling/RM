"use strict";
/**
 * Azure Functions adapter (v4 programming model).
 *
 * Deliberately thin: it translates an Azure request into the same plain object
 * the local dev server builds, then calls the SAME handlers. Whatever the tests
 * exercise is exactly what runs in Azure — no second code path to drift.
 */
const { app } = require("@azure/functions");
const { open } = require("./src/db");
const { handle } = require("./src/handlers");

const db = open();   // DB_DRIVER=mssql in Azure; connects lazily via Managed Identity

app.http("api", {
  methods: ["GET", "PUT", "POST", "DELETE"],
  authLevel: "anonymous",          // Static Web Apps has already authenticated the caller
  route: "{*path}",
  handler: async (request, context) => {
    try {
      const url = new URL(request.url);
      let body = {};
      if (["PUT", "POST", "PATCH"].includes(request.method)) {
        const text = await request.text();
        if (text) { try { body = JSON.parse(text); } catch { return { status: 400, jsonBody: { error: "malformed json" } }; } }
      }
      const out = await handle(db, {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: Object.fromEntries(request.headers.entries()),
      });
      return { status: out.status, jsonBody: out.body };
    } catch (e) {
      context.error("unhandled", e);
      return { status: 500, jsonBody: { error: "internal error" } };   // never leak internals to the browser
    }
  },
});
