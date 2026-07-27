"use strict";
/**
 * Project name matcher — shared, deterministic, no I/O.
 *
 * Mirrors the token scoring the browser uses for forecast import (guessProject in
 * web/index.html) so the server reconciles closed CRM opportunities the same way a
 * human sees them matched at import time. Kept here (not in odoo.js) so it can be
 * unit-tested in isolation and reused by a future manual "map to project" action.
 *
 * A closed opportunity almost always becomes a project for the SAME customer, so
 * this adds a same-client boost the import matcher does not need, plus an
 * ambiguity guard: when two projects score within a whisker of each other we
 * refuse to auto-pick, because moving a forecast onto the wrong project is worse
 * than leaving it flagged for a human.
 */

const STOPW = new Set("the and of for to a co inc llc company companies group sub".split(" "));

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** "Phase1" -> ["phase","1"]; drops stopwords and 1-char non-numeric noise. */
function projTokens(s) {
  return normName(s)
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(" ")
    .filter((w) => w && !STOPW.has(w) && (w.length >= 2 || /\d/.test(w)));
}

/**
 * Score one candidate project against a query {name, client}.
 * A name-token hit is worth double a client hit, and a candidate must hit the
 * NAME at all — a shared customer alone is never a match. Identical client adds a
 * fixed boost because opp->project pairs share the customer.
 */
function scoreCandidate(query, cand) {
  const nt = projTokens(query.name);
  if (!nt.length) return 0;
  const nameTok = new Set(projTokens(cand.name));
  const cliTok = new Set(projTokens(cand.client || ""));
  let nameScore = 0, cliScore = 0;
  for (const t of nt) {
    if (nameTok.has(t)) nameScore += 2;
    else if (t.length >= 3 && [...nameTok].some((x) => x.includes(t) || t.includes(x))) nameScore += 1;
    else if (cliTok.has(t)) cliScore += 1.5;
    else if (t.length >= 3 && [...cliTok].some((x) => x.includes(t) || t.includes(x))) cliScore += 0.75;
  }
  if (nameScore <= 0) return 0;                          // client-only overlap is not a match
  const qc = normName(query.client), cc = normName(cand.client);
  const clientBoost = qc && cc && qc === cc ? 1.5 : 0;
  return nameScore + cliScore + clientBoost;
}

/**
 * Best project for a closed opportunity, or null if none is confident/unambiguous.
 * Returns { project, score, runnerUp }. `minScore` is the confidence floor;
 * `margin` is how far the winner must beat the runner-up to avoid an ambiguous
 * pick (two similar same-customer projects).
 */
function bestProjectMatch(query, projects, { minScore = 3, margin = 1 } = {}) {
  let best = null, bestScore = 0, second = 0;
  for (const p of projects) {
    const sc = scoreCandidate(query, p);
    if (sc > bestScore) { second = bestScore; best = p; bestScore = sc; }
    else if (sc > second) { second = sc; }
  }
  if (!best || bestScore < minScore) return null;
  if (bestScore - second < margin) return null;          // too close to call — leave it flagged
  return { project: best, score: bestScore, runnerUp: second };
}

module.exports = { normName, projTokens, scoreCandidate, bestProjectMatch };
