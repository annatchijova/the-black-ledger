const HOUR_MS = 60 * 60 * 1000;

export function assertAnalysisAccess(access, ledger) {
  if (access.role === "witness") throw Object.assign(new Error("Read-only witnesses cannot use paid analysis services."), { status: 403 });
  if (access.role === "member" && ledger.members.find((member) => member.id === access.member_id)?.status !== "active") {
    throw Object.assign(new Error("Departed or removed participants cannot use paid analysis services."), { status: 403 });
  }
}

export function reserveAnalysisCapacity(db, { sessionId, principalId }, now = Date.now(), { principalLimit = 20, globalLimit = 120 } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(principalLimit) || principalLimit < 1 || !Number.isSafeInteger(globalLimit) || globalLimit < 1) throw new Error("Analysis rate-limit configuration is invalid.");
  const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const scopes = [["analysis:global", globalLimit], [`analysis:session:${sessionId}:${principalId}`, principalLimit]];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM analysis_usage WHERE window_start < ?").run(windowStart);
    for (const [scope, limit] of scopes) {
      const current = db.prepare("SELECT window_start, request_count FROM analysis_usage WHERE scope_id = ?").get(scope);
      if (current?.window_start === windowStart && current.request_count >= limit) {
        throw Object.assign(new Error("Paid analysis rate limit reached. Try again in the next hour."), { status: 429 });
      }
      db.prepare(`INSERT INTO analysis_usage(scope_id, window_start, request_count) VALUES (?, ?, 1)
        ON CONFLICT(scope_id) DO UPDATE SET window_start = excluded.window_start,
        request_count = CASE WHEN analysis_usage.window_start = excluded.window_start THEN analysis_usage.request_count + 1 ELSE 1 END`).run(scope, windowStart);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
