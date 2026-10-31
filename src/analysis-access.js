const HOUR_MS = 60 * 60 * 1000;

export function assertAnalysisAccess(access, ledger) {
  if (access.role === "witness") throw Object.assign(new Error("Read-only witnesses cannot use paid analysis services."), { status: 403 });
  if (access.role === "member" && ledger.members.find((member) => member.id === access.member_id)?.status !== "active") {
    throw Object.assign(new Error("Departed or removed participants cannot use paid analysis services."), { status: 403 });
  }
}

// Three ceilings, because they answer different questions.
//
// The principal and global ceilings measure spend: they exist to bound what the
// paid provider can be asked to bill. Both are released when a request turns out
// not to have been billable.
//
// The source ceiling measures attempts from one network origin and is never
// released. Session creation needs no credential, so a principal is free to
// mint: without a ceiling keyed to something costlier than a POST, an
// unauthenticated caller reaches the global ceiling by rotating sessions and
// denies analysis to everyone else. This ceiling raises that cost; it does not
// eliminate it, since a caller with many source addresses still gets one
// allowance per address.
export function reserveAnalysisCapacity(db, { sessionId, principalId, sourceId }, now = Date.now(), { principalLimit = 20, sourceLimit = 40, globalLimit = 120 } = {}) {
  const limits = [principalLimit, sourceLimit, globalLimit];
  if (!Number.isSafeInteger(now) || limits.some((limit) => !Number.isSafeInteger(limit) || limit < 1)) throw new Error("Analysis rate-limit configuration is invalid.");
  if (typeof sourceId !== "string" || !sourceId) throw new Error("Analysis rate limiting requires a request source identifier.");
  const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  // Spend scopes are refundable; the attempt scope is not.
  const spendScopes = [[`analysis:session:${sessionId}:${principalId}`, principalLimit], ["analysis:global", globalLimit]];
  const attemptScopes = [[`analysis:source:${sourceId}`, sourceLimit]];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM analysis_usage WHERE window_start < ?").run(windowStart);
    for (const [scope, limit] of [...attemptScopes, ...spendScopes]) {
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
  return { windowStart, spendScopes: spendScopes.map(([scope]) => scope) };
}

// Give back the spend allowance for a request the provider never billed. The
// attempt allowance is deliberately kept, so a failing provider cannot be used
// as free, unbounded retries. Decrements are confined to the window the
// reservation was made in, so an hour boundary crossed in between is a no-op
// rather than a corrupted counter.
export function releaseAnalysisCapacity(db, reservation) {
  if (!reservation?.spendScopes?.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const scope of reservation.spendScopes) {
      db.prepare("UPDATE analysis_usage SET request_count = request_count - 1 WHERE scope_id = ? AND window_start = ? AND request_count > 0").run(scope, reservation.windowStart);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
