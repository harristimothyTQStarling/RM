"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { projTokens, scoreCandidate, bestProjectMatch } = require("../src/match");

test("tokenizer splits letter/digit runs and drops stopwords/noise", () => {
  assert.deepEqual(projTokens("Bain Phase2B"), ["bain", "phase", "2b"]);
  assert.deepEqual(projTokens("The Group of Co"), []);          // all stopwords
  assert.deepEqual(projTokens("A1 x"), ["1"]);                  // "a1"->"a 1", 1-char letters dropped, "1" kept
});

test("a name hit is required — a shared client alone never scores", () => {
  const q = { name: "Rollout", client: "Advocate Health" };
  const cand = { name: "Something Unrelated", client: "Advocate Health" };
  assert.equal(scoreCandidate(q, cand), 0, "client overlap without a name hit is not a match");
});

test("exact name overlap plus same client scores well above the floor", () => {
  const q = { name: "Advocate Health Implementation", client: "Advocate Health" };
  const cand = { name: "Advocate Health Implementation", client: "Advocate Health" };
  assert.ok(scoreCandidate(q, cand) >= 5, "two name tokens (4) + same-client boost (1.5)");
});

test("bestProjectMatch picks the confident, unambiguous project", () => {
  const q = { name: "Advocate Health Implementation", client: "Advocate Health" };
  const projects = [
    { id: 119, name: "Advocate Health Implementation", client: "Advocate Health" },
    { id: 300, name: "Bain Phase 2B", client: "Bain & Company" },
  ];
  const hit = bestProjectMatch(q, projects);
  assert.equal(hit.project.id, 119);
});

test("no match below the confidence floor -> null (stays flagged)", () => {
  const q = { name: "Mystery Deal", client: "Nobody Inc" };
  const projects = [{ id: 119, name: "Advocate Health Implementation", client: "Advocate Health" }];
  assert.equal(bestProjectMatch(q, projects), null);
});

test("two near-tied same-customer projects are ambiguous -> null, not a wrong pick", () => {
  // Acme has two live projects; an "Acme" opp must not be auto-shoved onto either.
  const q = { name: "Acme Platform", client: "Acme" };
  const projects = [
    { id: 1, name: "Acme Support", client: "Acme" },
    { id: 2, name: "Acme Migration", client: "Acme" },
  ];
  assert.equal(bestProjectMatch(q, projects), null, "margin guard refuses the coin-flip");
});
