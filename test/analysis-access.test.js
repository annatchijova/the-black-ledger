import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertAnalysisAccess, reserveAnalysisCapacity, releaseAnalysisCapacity } from "../src/analysis-access.js";

test("paid analysis access excludes witnesses and inactive participants", () => {
  const ledger = { members: [{ id: "active", status: "active" }, { id: "gone", status: "departed" }] };
  assert.throws(() => assertAnalysisAccess({ role: "witness", member_id: null }, ledger), (error) => error.status === 403);
  assert.throws(() => assertAnalysisAccess({ role: "member", member_id: "gone" }, ledger), (error) => error.status === 403);
  assert.doesNotThrow(() => assertAnalysisAccess({ role: "member", member_id: "active" }, ledger));
  assert.doesNotThrow(() => assertAnalysisAccess({ role: "organizer", member_id: null }, ledger));
});

test("analysis quotas enforce principal and global hourly ceilings, then reset", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE analysis_usage (scope_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL)");
  const limits = { principalLimit: 2, sourceLimit: 99, globalLimit: 3 };
  const now = 1_800_000;
  const first = { sessionId: "session-a", principalId: "member-a", sourceId: "10.0.0.1" };
  reserveAnalysisCapacity(db, first, now, limits);
  reserveAnalysisCapacity(db, first, now + 1, limits);
  assert.throws(() => reserveAnalysisCapacity(db, first, now + 2, limits), (error) => error.status === 429);

  reserveAnalysisCapacity(db, { sessionId: "session-b", principalId: "member-b", sourceId: "10.0.0.2" }, now, limits);
  assert.throws(() => reserveAnalysisCapacity(db, { sessionId: "session-c", principalId: "member-c", sourceId: "10.0.0.3" }, now, limits), (error) => error.status === 429);
  reserveAnalysisCapacity(db, first, now + 60 * 60 * 1000, limits);
  db.close();
});

test("a free-to-mint principal cannot drain the shared spend ceiling from one source", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE analysis_usage (scope_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL)");
  const limits = { principalLimit: 2, sourceLimit: 3, globalLimit: 10 };
  const now = 1_800_000;
  // Session creation needs no credential, so the caller rotates principals
  // freely. The attempt ceiling, not the principal ceiling, is what stops them.
  let calls = 0;
  assert.throws(() => {
    for (let session = 0; session < 20; session++) {
      for (let i = 0; i < limits.principalLimit; i++) { reserveAnalysisCapacity(db, { sessionId: `rotated-${session}`, principalId: "organizer", sourceId: "203.0.113.7" }, now, limits); calls++; }
    }
  }, (error) => error.status === 429);
  assert.equal(calls, limits.sourceLimit, "one source must not exceed its own attempt ceiling by rotating sessions");
  assert.ok(calls < limits.globalLimit, "the shared spend ceiling must survive a single-source caller");

  // A legitimate session from another address is unaffected.
  assert.doesNotThrow(() => reserveAnalysisCapacity(db, { sessionId: "victim", principalId: "organizer", sourceId: "198.51.100.4" }, now, limits));
  db.close();
});

test("a request the provider never billed gives back its spend allowance but not its attempt", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE analysis_usage (scope_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL)");
  const limits = { principalLimit: 2, sourceLimit: 5, globalLimit: 2 };
  const now = 1_800_000;
  const caller = { sessionId: "session-a", principalId: "member-a", sourceId: "10.0.0.1" };
  const count = (scope) => db.prepare("SELECT request_count FROM analysis_usage WHERE scope_id = ?").get(scope)?.request_count ?? 0;

  const reservation = reserveAnalysisCapacity(db, caller, now, limits);
  assert.equal(count("analysis:global"), 1);
  assert.equal(count("analysis:source:10.0.0.1"), 1);
  releaseAnalysisCapacity(db, reservation);
  assert.equal(count("analysis:global"), 0, "an unbilled request must not consume spend");
  assert.equal(count("analysis:session:session-a:member-a"), 0);
  assert.equal(count("analysis:source:10.0.0.1"), 1, "the attempt must still be counted so failures are not free retries");

  // Releasing after the window rolled over must not corrupt the next window.
  const nextWindow = now + 60 * 60 * 1000;
  const later = reserveAnalysisCapacity(db, caller, nextWindow, limits);
  releaseAnalysisCapacity(db, { ...later, windowStart: later.windowStart - 60 * 60 * 1000 });
  assert.equal(count("analysis:global"), 1, "a stale reservation must not decrement a fresh window");
  db.close();
});
