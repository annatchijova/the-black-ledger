import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertAnalysisAccess, reserveAnalysisCapacity } from "../src/analysis-access.js";

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
  const limits = { principalLimit: 2, globalLimit: 3 };
  const now = 1_800_000;
  const first = { sessionId: "session-a", principalId: "member-a" };
  reserveAnalysisCapacity(db, first, now, limits);
  reserveAnalysisCapacity(db, first, now + 1, limits);
  assert.throws(() => reserveAnalysisCapacity(db, first, now + 2, limits), (error) => error.status === 429);

  reserveAnalysisCapacity(db, { sessionId: "session-b", principalId: "member-b" }, now, limits);
  assert.throws(() => reserveAnalysisCapacity(db, { sessionId: "session-c", principalId: "member-c" }, now, limits), (error) => error.status === 429);
  reserveAnalysisCapacity(db, first, now + 60 * 60 * 1000, limits);
  db.close();
});
