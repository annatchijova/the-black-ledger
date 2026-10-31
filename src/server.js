import http from "node:http";
import { createReadStream, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalStringify } from "./domain/canonical.js";
import { deriveNarrativeEvents, narrativePattern } from "./domain/narrative.js";
import { deriveLedger, parseEventLog, parseAmountToMinor, simulateLedger, findPossibleDuplicates } from "./domain.js";
import { assertAnalysisAccess, reserveAnalysisCapacity } from "./analysis-access.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYPAL_APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;
if (existsSync(resolve(root, ".env")) && typeof process.loadEnvFile === "function") process.loadEnvFile(resolve(root, ".env"));
const dataPath = resolve(process.env.LEDGER_DATA_DIR ?? resolve(root, "data"));
mkdirSync(dataPath, { recursive: true });
const db = new DatabaseSync(resolve(dataPath, "ledger.sqlite"));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, base_currency TEXT NOT NULL, created_at TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, head_hash TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL, previous_hash TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(session_id, sequence), UNIQUE(session_id, event_id));
CREATE TABLE IF NOT EXISTS requests (session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, request_id));
CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, media_type TEXT NOT NULL, byte_length INTEGER NOT NULL, content BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS session_tokens (token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, member_id TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS paypal_orders (order_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), from_member_id TEXT NOT NULL, to_member_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, status TEXT NOT NULL, capture_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paypal_order_requests (session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, from_member_id TEXT NOT NULL, to_member_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, status TEXT NOT NULL, order_id TEXT, approval_url TEXT, created_at TEXT NOT NULL, PRIMARY KEY(session_id, request_id));
CREATE TABLE IF NOT EXISTS paypal_reconciliations (capture_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), from_member_id TEXT NOT NULL, to_member_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, occurred_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS session_patterns (session_id TEXT PRIMARY KEY REFERENCES sessions(id), pattern TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analysis_usage (scope_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_session_digest ON evidence(session_id, sha256);
`);

// Persist the provider key so retries survive upgrades without creating a
// second external order. Existing rows retain the legacy key on first retry.
if (!db.prepare("PRAGMA table_info(paypal_order_requests)").all().some((column) => column.name === "provider_request_id")) {
  db.exec("ALTER TABLE paypal_order_requests ADD COLUMN provider_request_id TEXT");
}

// Preserve the provider's own amount claim verbatim alongside the parsed value.
// A capture this ledger cannot interpret must still be recorded as evidence that
// money moved, so it reaches the organizer instead of being discarded.
for (const column of ["provider_amount_value TEXT", "provider_currency TEXT", "parse_error TEXT"]) {
  const name = column.split(" ")[0];
  if (!db.prepare("PRAGMA table_info(paypal_reconciliations)").all().some((existing) => existing.name === name)) {
    db.exec(`ALTER TABLE paypal_reconciliations ADD COLUMN ${column}`);
  }
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const send = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const sha = (value) => createHash("sha256").update(value).digest("hex");

function paypalConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID; const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret || !process.env.PAYPAL_MERCHANT_ID || !process.env.PAYPAL_PAYEE_MEMBER_ID) throw Object.assign(new Error("PayPal Sandbox credentials and the organizer payee mapping are not configured on the server."), { status: 503 });
  return { clientId, secret, base: process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com", payee: process.env.PAYPAL_MERCHANT_ID, payeeMemberId: process.env.PAYPAL_PAYEE_MEMBER_ID };
}

async function paypalRequest(path, options = {}) {
  const config = paypalConfig();
  const auth = Buffer.from(`${config.clientId}:${config.secret}`).toString("base64");
  const tokenResponse = await fetch(`${config.base}/v1/oauth2/token`, { method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(12_000) });
  if (!tokenResponse.ok) throw Object.assign(new Error("PayPal authentication failed."), { status: 502 });
  const token = await tokenResponse.json();
  const response = await fetch(`${config.base}${path}`, { ...options, headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", ...(options.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`PayPal request failed with status ${response.status}.`), { status: 502 });
  return result;
}

async function readJson(req, maxBytes = 1_000_000) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

function getEvents(sessionId) {
  const rows = db.prepare("SELECT sequence, event_json, previous_hash, content_hash FROM events WHERE session_id = ? ORDER BY sequence").all(sessionId);
  let previous = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; const event = JSON.parse(row.event_json);
    if (row.sequence !== i + 1 || row.previous_hash !== previous || sha(`${previous}\n${canonicalStringify(event)}`) !== row.content_hash) throw new Error("The stored event chain failed integrity verification.");
    previous = row.content_hash;
  }
  return { events: rows.map((row) => JSON.parse(row.event_json)), proofs: rows.map((row) => ({ sequence: row.sequence, previousHash: row.previous_hash, contentHash: row.content_hash })), headHash: previous };
}

function append(sessionId, event, requestId, { trustedProvider = false } = {}) {
  const session = db.prepare("SELECT id, base_currency, event_count, head_hash FROM sessions WHERE id = ?").get(sessionId);
  if (!session) throw Object.assign(new Error("Session not found."), { status: 404 });
  const fingerprint = sha(canonicalStringify(event));
  if (event.type === "SETTLEMENT_RECORDED") throw Object.assign(new Error("Legacy settlement assertions cannot be appended through the shared API."), { status: 422 });
  if (event.type === "OBLIGATION_CARRIED" || event.type === "OBLIGATION_CARRIED_OUT") throw Object.assign(new Error("Cross-session debt transfers must use the atomic carry endpoint."), { status: 422 });
  if (event.type === "SETTLEMENT_CONFIRMED" && event.confirmationSource === "provider_capture" && !trustedProvider) throw Object.assign(new Error("Provider-confirmed payments can only be recorded by the server capture flow."), { status: 403 });
  const priorRequest = db.prepare("SELECT fingerprint, response_json FROM requests WHERE session_id = ? AND request_id = ?").get(sessionId, requestId);
  if (priorRequest) {
    if (priorRequest.fingerprint !== fingerprint) throw Object.assign(new Error("This idempotency key was already used for a different event."), { status: 409 });
    return JSON.parse(priorRequest.response_json);
  }
  const current = getEvents(sessionId);
  if (event.type === "SETTLEMENT_CONFIRMED" && !trustedProvider) {
    const previousLedger = deriveLedger(current.events, { baseCurrency: session.base_currency });
    const payment = previousLedger.settlements.find((item) => item.settlementId === event.settlementId);
    if (payment?.rail === "paypal") throw Object.assign(new Error("PayPal settlements can only be confirmed by the server capture flow."), { status: 403 });
  }
  const candidate = parseEventLog([...current.events, event], session.base_currency);
  const next = deriveLedger(candidate, { baseCurrency: session.base_currency });
  const sequence = session.event_count + 1;
  const contentHash = sha(`${session.head_hash}\n${canonicalStringify(event)}`);
  const response = { event, sequence, previousHash: session.head_hash, contentHash, headHash: contentHash, state: publicState(next) };
  db.exec("BEGIN IMMEDIATE");
  try {
    const actual = db.prepare("SELECT event_count, head_hash FROM sessions WHERE id = ?").get(sessionId);
    if (actual.event_count !== session.event_count || actual.head_hash !== session.head_hash) throw Object.assign(new Error("Session changed concurrently; reload before retrying."), { status: 409 });
    db.prepare("INSERT INTO events(session_id, sequence, event_id, event_json, previous_hash, content_hash) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, sequence, event.id, JSON.stringify(event), session.head_hash, contentHash);
    db.prepare("UPDATE sessions SET event_count = ?, head_hash = ? WHERE id = ?").run(sequence, contentHash, sessionId);
    db.prepare("INSERT INTO requests(session_id, request_id, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, requestId, fingerprint, JSON.stringify(response), new Date().toISOString());
    if (event.type === "SESSION_CLOSED_FINAL") db.prepare("INSERT INTO session_patterns(session_id, pattern, recorded_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET pattern = excluded.pattern, recorded_at = excluded.recorded_at").run(sessionId, narrativePattern(next), event.at);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return response;
}

function completeOrderRows(sessionId, orderId, captureId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE paypal_orders SET status = 'completed', capture_id = ? WHERE order_id = ? AND session_id = ?").run(captureId, orderId, sessionId);
    db.prepare("UPDATE paypal_order_requests SET status = 'completed' WHERE order_id = ? AND session_id = ?").run(orderId, sessionId);
    db.prepare("UPDATE paypal_reconciliations SET status = 'resolved', resolved_at = ?, reason = NULL WHERE capture_id = ? AND session_id = ?").run(new Date().toISOString(), captureId, sessionId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function preserveCapturedPayment(sessionId, order, payment, amountMinor, currency, occurredAt, parseError = null) {
  db.prepare(`INSERT INTO paypal_reconciliations(capture_id, order_id, session_id, from_member_id, to_member_id, amount_minor, currency, occurred_at, status, reason, created_at, provider_amount_value, provider_currency, parse_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'Provider capture received; ledger posting has not completed.', ?, ?, ?, ?)
    ON CONFLICT(capture_id) DO UPDATE SET amount_minor = excluded.amount_minor, currency = excluded.currency, occurred_at = excluded.occurred_at, provider_amount_value = excluded.provider_amount_value, provider_currency = excluded.provider_currency, parse_error = excluded.parse_error`)
    .run(payment.id, order.order_id, sessionId, order.from_member_id, order.to_member_id, amountMinor ?? 0, currency ?? "", occurredAt, new Date().toISOString(), payment.amount?.value ?? null, payment.amount?.currency_code ?? null, parseError);
}

function markReconciliationRequired(sessionId, orderId, captureId, reason) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE paypal_reconciliations SET status = 'pending', reason = ? WHERE capture_id = ? AND session_id = ?").run(reason, captureId, sessionId);
    db.prepare("UPDATE paypal_orders SET status = 'reconciliation_required', capture_id = ? WHERE order_id = ? AND session_id = ?").run(captureId, orderId, sessionId);
    db.prepare("UPDATE paypal_order_requests SET status = 'reconciliation_required' WHERE order_id = ? AND session_id = ?").run(orderId, sessionId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function publicState(ledger, access = {}) {
  const expenses = ledger.expenses.map((expense) => {
    const gift = expense.giftId ? ledger.gifts.find((item) => item.giftId === expense.giftId) : null;
    return { ...expense, description: gift && access.member_id === gift.recipientMemberId ? "Confidential surprise gift" : expense.description, totalCents: expense.baseAmountMinor };
  });
  return {
    session: ledger.session,
    members: ledger.members,
    groups: ledger.groups,
    expenses,
    settlements: ledger.settlements,
    commitments: ledger.commitments,
    discrepancies: ledger.discrepancies,
    balances: Object.fromEntries(ledger.balances),
    balanceBreakdowns: Object.fromEntries(ledger.balanceBreakdowns),
    paymentReconciliations: access.role === "organizer" && ledger.session ? db.prepare("SELECT capture_id AS captureId, order_id AS orderId, from_member_id AS fromMemberId, to_member_id AS toMemberId, amount_minor AS amountMinor, currency, occurred_at AS occurredAt, status, reason, provider_amount_value AS providerAmountValue, provider_currency AS providerCurrency, parse_error AS parseError FROM paypal_reconciliations WHERE session_id = ? AND status = 'pending' ORDER BY occurred_at").all(ledger.session.id) : [],
    outstanding: ledger.outstanding,
    totalExpensesMinor: ledger.totalExpensesMinor,
    closure: ledger.closure,
    closureBlockers: ledger.closureBlockers,
    narrativeEvents: deriveNarrativeEvents(ledger, { priorLedgers: ledger.session ? db.prepare("SELECT pattern FROM session_patterns WHERE session_id <> ? ORDER BY recorded_at DESC LIMIT 100").all(ledger.session.id) : [] }),
    archived: ledger.archived
  };
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, storage: "sqlite", apiVersion: 1 });
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req, 16_000); const sessionId = body.sessionId ?? randomUUID().replaceAll("-", "");
    const accessToken = randomBytes(32).toString("base64url");
    const currency = String(body.baseCurrency ?? "USD").toUpperCase();
    const createdAt = new Date().toISOString();
    const createEvent = { id: randomUUID().replaceAll("-", ""), at: createdAt, type: "SESSION_CREATED", sessionId, name: body.name, baseCurrency: currency };
    parseEventLog([createEvent], currency); deriveLedger([createEvent], { baseCurrency: currency });
    db.prepare("INSERT INTO sessions(id, base_currency, created_at) VALUES (?, ?, ?)").run(sessionId, currency, createdAt);
    db.prepare("INSERT INTO session_tokens(token_hash, session_id, role, created_at) VALUES (?, ?, 'organizer', ?)").run(sha(accessToken), sessionId, createdAt);
    const response = append(sessionId, createEvent, `create:${sessionId}`);
    return send(res, 201, { sessionId, accessToken, ...response });
  }
  const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,100})(?:\/(events|evidence|export|analysis\/(?:receipt|scenario)|simulate|invitations|carry-debt|payments(?:\/[A-Z0-9-]+\/(?:capture|cancel|reconcile))?))?$/.exec(url.pathname);
  if (match) {
    const [, sessionId, resource] = match;
    const session = db.prepare("SELECT id, base_currency FROM sessions WHERE id = ?").get(sessionId);
    if (!session) return send(res, 404, { error: "Session not found." });
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,100})$/.exec(req.headers.authorization ?? "")?.[1];
    const access = bearer ? db.prepare("SELECT role, member_id FROM session_tokens WHERE token_hash = ? AND session_id = ? AND revoked_at IS NULL").get(sha(bearer), sessionId) : null;
    if (!access) return send(res, 401, { error: "A valid session access token is required." });
    if (req.method === "POST" && ["analysis/receipt", "analysis/scenario"].includes(resource)) {
      const analysisLedger = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
      assertAnalysisAccess(access, analysisLedger);
    }
    if (req.method === "POST" && ["events", "payments", "evidence", "invitations"].includes((resource ?? "").split("/")[0]) && access.role === "witness") return send(res, 403, { error: "Witness access is read-only." });
    if (req.method === "GET" && (!resource || resource === "events")) {
      const { events, headHash } = getEvents(sessionId); const ledger = deriveLedger(events, { baseCurrency: session.base_currency });
      const visibleEvents = events.map((event) => event.type === "SURPRISE_GIFT_RECORDED" && event.recipientMemberId === access.member_id ? { ...event, privateDescription: "[hidden from recipient]" } : event);
      return send(res, 200, { sessionId, baseCurrency: session.base_currency, access: { role: access.role, memberId: access.member_id }, events: visibleEvents, headHash, state: publicState(ledger, access) });
    }
    if (req.method === "GET" && resource === "export") {
      if (access.role !== "organizer") return send(res, 403, { error: "Only the organizer can export the complete evidence package." });
      const chain = getEvents(sessionId);
      const rows = db.prepare("SELECT id, sha256, media_type, byte_length, content FROM evidence WHERE session_id = ? ORDER BY id").all(sessionId);
      const attachments = rows.map((row) => ({ id: row.id, sha256: row.sha256, mediaType: row.media_type, byteLength: row.byte_length, dataBase64: Buffer.from(row.content).toString("base64") }));
      const manifest = { format: "the-black-ledger-evidence-package", version: 1, sessionId, baseCurrency: session.base_currency, events: chain.events, eventProofs: chain.proofs, eventHeadHash: chain.headHash, evidence: attachments.map(({ dataBase64, ...metadata }) => metadata), evidenceData: attachments };
      const packageHash = sha(canonicalStringify(manifest));
      return send(res, 200, { ...manifest, packageHash, verification: { algorithm: "SHA-256", canonicalization: "The Black Ledger v1", verifiesContent: true } });
    }
    if (req.method === "POST" && resource === "invitations") {
      if (access.role !== "organizer") return send(res, 403, { error: "Only the organizer can invite participants." });
      const body = await readJson(req, 16_000);
      if (!new Set(["member", "witness"]).has(body.role)) return send(res, 400, { error: "Invite role must be member or witness." });
      const memberId = randomUUID().replaceAll("-", ""); const token = randomBytes(32).toString("base64url");
      const event = { id: randomUUID().replaceAll("-", ""), at: new Date().toISOString(), type: "MEMBER_INVITED", memberId, name: body.name, role: body.role };
      const created = append(sessionId, event, `invite-${event.id}`);
      db.prepare("INSERT INTO session_tokens(token_hash, session_id, role, member_id, created_at) VALUES (?, ?, ?, ?, ?)").run(sha(token), sessionId, body.role, memberId, event.at);
      return send(res, 201, { memberId, role: body.role, accessToken: token, invitePath: `/#join/${sessionId}/${token}`, event: created.event, state: created.state });
    }
    if (req.method === "POST" && resource === "carry-debt") {
      if (access.role !== "organizer") return send(res, 403, { error: "Only the organizer can carry obligations between sessions." });
      const body = await readJson(req, 16_000);
      const requestId = req.headers["idempotency-key"];
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)) return send(res, 400, { error: "A valid Idempotency-Key header is required." });
      if (body.originSessionId === sessionId) return send(res, 400, { error: "Choose a different origin session." });
      const origin = db.prepare("SELECT id, base_currency, event_count, head_hash FROM sessions WHERE id = ?").get(body.originSessionId);
      if (!origin) return send(res, 404, { error: "Origin session not found." });
      const originToken = req.headers["x-origin-token"];
      const originAccess = typeof originToken === "string" ? db.prepare("SELECT role FROM session_tokens WHERE token_hash = ? AND session_id = ? AND revoked_at IS NULL").get(sha(originToken), origin.id) : null;
      if (originAccess?.role !== "organizer") return send(res, 403, { error: "An organizer token for the origin session is required." });
      if (origin.base_currency !== session.base_currency) return send(res, 422, { error: "Carry obligations between sessions with the same base currency so the amount is not reinterpreted." });
      const fingerprint = sha(canonicalStringify(body));
      const previousRequest = db.prepare("SELECT fingerprint, response_json FROM requests WHERE session_id = ? AND request_id = ?").get(sessionId, requestId);
      if (previousRequest) {
        if (previousRequest.fingerprint !== fingerprint) return send(res, 409, { error: "This idempotency key was used for a different carry operation." });
        return send(res, 200, JSON.parse(previousRequest.response_json));
      }
      const originChain = getEvents(origin.id); const targetSession = db.prepare("SELECT id, base_currency, event_count, head_hash FROM sessions WHERE id = ?").get(sessionId);
      const targetChain = getEvents(sessionId);
      const originLedger = deriveLedger(originChain.events, { baseCurrency: origin.base_currency });
      const originDue = originLedger.outstanding.find((item) => item.debtorId === body.sourceDebtorId && item.creditorId === body.sourceCreditorId)?.amountMinor ?? 0;
      const amountMinor = body.amountMinor;
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor !== originDue) return send(res, 409, { error: "Carry the full current obligation once; partial carries could duplicate the remaining origin balance.", outstandingMinor: originDue });
      const targetLedger = deriveLedger(targetChain.events, { baseCurrency: session.base_currency });
      if (!targetLedger.members.some((member) => member.id === body.debtorId) || !targetLedger.members.some((member) => member.id === body.creditorId)) return send(res, 422, { error: "Map the carried obligation to participants already in the new session." });
      const originObligationId = `carry_${sha(`${origin.id}:${body.sourceDebtorId}:${body.sourceCreditorId}`)}`;
      if (targetLedger.carriedObligations.some((item) => item.originSessionId === origin.id && item.originObligationId === originObligationId)) return send(res, 409, { error: "This origin obligation has already been carried into this session." });
      const transferId = `transfer_${sha(`${sessionId}:${origin.id}:${requestId}`).slice(0, 40)}`; const at = new Date().toISOString();
      const outbound = { id: `carryout_${sha(transferId).slice(0, 32)}`, at, type: "OBLIGATION_CARRIED_OUT", targetSessionId: sessionId, transferId, debtorId: body.sourceDebtorId, creditorId: body.sourceCreditorId, amountMinor };
      const inbound = { id: `carryin_${sha(transferId).slice(0, 32)}`, at, type: "OBLIGATION_CARRIED", originSessionId: origin.id, originObligationId, sourceDebtorId: body.sourceDebtorId, sourceCreditorId: body.sourceCreditorId, debtorId: body.debtorId, creditorId: body.creditorId, amountMinor };
      const originEvents = parseEventLog([...originChain.events, outbound], origin.base_currency);
      const targetEvents = parseEventLog([...targetChain.events, inbound], targetSession.base_currency);
      const originNext = deriveLedger(originEvents, { baseCurrency: origin.base_currency });
      const targetNext = deriveLedger(targetEvents, { baseCurrency: targetSession.base_currency });
      const originHash = sha(`${origin.head_hash}\n${canonicalStringify(outbound)}`); const targetHash = sha(`${targetSession.head_hash}\n${canonicalStringify(inbound)}`);
      const response = { transferId, source: { sessionId: origin.id, event: outbound, headHash: originHash, state: publicState(originNext) }, destination: { sessionId, event: inbound, headHash: targetHash, state: publicState(targetNext) } };
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentSource = db.prepare("SELECT event_count, head_hash FROM sessions WHERE id = ?").get(origin.id);
        const currentTarget = db.prepare("SELECT event_count, head_hash FROM sessions WHERE id = ?").get(sessionId);
        if (currentSource.event_count !== origin.event_count || currentSource.head_hash !== origin.head_hash || currentTarget.event_count !== targetSession.event_count || currentTarget.head_hash !== targetSession.head_hash) throw Object.assign(new Error("One of the ledgers changed concurrently; reload before retrying."), { status: 409 });
        db.prepare("INSERT INTO events(session_id, sequence, event_id, event_json, previous_hash, content_hash) VALUES (?, ?, ?, ?, ?, ?)").run(origin.id, origin.event_count + 1, outbound.id, JSON.stringify(outbound), origin.head_hash, originHash);
        db.prepare("INSERT INTO events(session_id, sequence, event_id, event_json, previous_hash, content_hash) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, targetSession.event_count + 1, inbound.id, JSON.stringify(inbound), targetSession.head_hash, targetHash);
        db.prepare("UPDATE sessions SET event_count = event_count + 1, head_hash = ? WHERE id = ?").run(originHash, origin.id);
        db.prepare("UPDATE sessions SET event_count = event_count + 1, head_hash = ? WHERE id = ?").run(targetHash, sessionId);
        db.prepare("INSERT INTO requests(session_id, request_id, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, requestId, fingerprint, JSON.stringify(response), at);
        db.prepare("INSERT INTO requests(session_id, request_id, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?)").run(origin.id, requestId, fingerprint, JSON.stringify(response), at);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return send(res, 201, response);
    }
    if (req.method === "POST" && resource === "analysis/receipt") {
      const body = await readJson(req, 11_000_000);
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return send(res, 503, { error: "Receipt proposal service is not configured." });
      if (typeof body.dataBase64 !== "string" || body.dataBase64.length > 10_700_000) return send(res, 413, { error: "Receipt image exceeds the 8 MB limit." });
      const mediaType = String(body.mediaType ?? "");
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mediaType)) return send(res, 415, { error: "Upload a JPEG, PNG, or WebP receipt image." });
      const image = Buffer.from(body.dataBase64, "base64");
      if (!image.length || image.length > 8_000_000 || image.toString("base64").replace(/=+$/, "") !== body.dataBase64.replace(/=+$/, "")) return send(res, 400, { error: "Receipt image encoding is invalid or exceeds the 8 MB limit." });
      const schema = { type: "object", additionalProperties: false, required: ["merchant", "date", "currency", "total", "items", "uncertainties"], properties: { merchant: { type: ["string", "null"] }, date: { type: ["string", "null"] }, currency: { type: ["string", "null"] }, total: { type: ["string", "null"] }, items: { type: "array", items: { type: "object", additionalProperties: false, required: ["description", "quantity", "amount", "confidence"], properties: { description: { type: "string" }, quantity: { type: ["string", "null"] }, amount: { type: ["string", "null"] }, confidence: { type: "number" } } } }, uncertainties: { type: "array", items: { type: "string" } } } };
      reserveAnalysisCapacity(db, { sessionId, principalId: access.member_id ?? access.role });
      const aiResponse = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_RECEIPT_MODEL ?? "gpt-4.1-mini", store: false, input: [{ role: "user", content: [{ type: "input_text", text: "Extract only facts visible on this receipt. Preserve decimal strings exactly. Do not infer missing values. Mark ambiguity in uncertainties. This is a proposal for human review and will not be recorded automatically." }, { type: "input_image", image_url: `data:${mediaType};base64,${body.dataBase64}` }] }], text: { format: { type: "json_schema", name: "receipt_proposal", strict: true, schema } } }), signal: AbortSignal.timeout(40_000) });
      if (!aiResponse.ok) return send(res, 502, { error: "Receipt analysis provider returned an error." });
      const result = await aiResponse.json();
      const outputText = result.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
      if (!outputText) return send(res, 502, { error: "Receipt analysis returned no structured proposal." });
      let proposal;
      try { proposal = JSON.parse(outputText); } catch { return send(res, 502, { error: "Receipt analysis returned invalid structured data." }); }
      return send(res, 200, { proposal, requiresHumanReview: true, recorded: false });
    }
    if (req.method === "POST" && resource === "analysis/scenario") {
      const body = await readJson(req, 8_000);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt || prompt.length > 1_200) return send(res, 400, { error: "Describe a scenario in 1 to 1,200 characters." });
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return send(res, 503, { error: "Scenario proposal service is not configured." });
      const currentEvents = getEvents(sessionId).events;
      const ledger = deriveLedger(currentEvents, { baseCurrency: session.base_currency });
      const schema = { type: "object", additionalProperties: false, required: ["expenses", "uncertainties"], properties: { expenses: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["description", "payerId", "amount", "allocations"], properties: { description: { type: "string" }, payerId: { type: "string" }, amount: { type: "string" }, allocations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["memberId", "amount"], properties: { memberId: { type: "string" }, amount: { type: "string" } } } } } } }, uncertainties: { type: "array", maxItems: 20, items: { type: "string" } } } };
      const promptContext = { request: prompt, baseCurrency: session.base_currency, participants: ledger.members.map((member) => ({ id: member.id, name: member.name })), currentBalancesMinor: Object.fromEntries(ledger.balances) };
      reserveAnalysisCapacity(db, { sessionId, principalId: access.member_id ?? access.role });
      const aiResponse = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_RECEIPT_MODEL ?? "gpt-4.1-mini", store: false, max_output_tokens: 3000, input: [{ role: "user", content: [{ type: "input_text", text: `Translate the user's hypothetical into at most five proposed shared expenses. Use only participant IDs provided. Express amounts as ordinary decimal strings in ${session.base_currency}; do not calculate balances or infer missing facts. Return uncertainties when a payer, beneficiary, amount, or split is unclear. These records are simulation-only and must never be saved. Context: ${JSON.stringify(promptContext)}` }] }], text: { format: { type: "json_schema", name: "scenario_proposal", strict: true, schema } } }), signal: AbortSignal.timeout(40_000) });
      if (!aiResponse.ok) return send(res, 502, { error: "Scenario analysis provider returned an error." });
      const aiResult = await aiResponse.json();
      const outputText = aiResult.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
      if (!outputText) return send(res, 502, { error: "Scenario analysis returned no structured proposal." });
      let proposal;
      try { proposal = JSON.parse(outputText); } catch { return send(res, 502, { error: "Scenario analysis returned invalid structured data." }); }
      const proposedEvents = proposal.expenses.map((expense) => ({ id: `simulation_${randomUUID().replaceAll("-", "")}`, at: new Date().toISOString(), type: "EXPENSE_RECORDED", expenseId: `simulation_expense_${randomUUID().replaceAll("-", "")}`, description: expense.description, paidByMemberId: expense.payerId, amountMinor: parseAmountToMinor(expense.amount, session.base_currency), baseAmountMinor: parseAmountToMinor(expense.amount, session.base_currency), currency: session.base_currency, allocations: expense.allocations.map((row) => ({ memberId: row.memberId, baseMinor: parseAmountToMinor(row.amount, session.base_currency) })) }));
      const simulation = simulateLedger(currentEvents, proposedEvents, { baseCurrency: session.base_currency });
      return send(res, 200, { proposal, simulation, requiresHumanReview: true, persisted: false });
    }
    if (req.method === "POST" && resource === "events") {
      const requestId = req.headers["idempotency-key"];
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)) return send(res, 400, { error: "A valid Idempotency-Key header is required." });
      const body = await readJson(req); const event = body.event;
      const before = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
      const organizerOnly = new Set(["MEMBER_ADDED", "MEMBER_INVITED", "MEMBER_JOINED", "MEMBER_STATUS_CHANGED", "GROUP_CREATED", "GROUP_MEMBERS_CHANGED", "EXPENSE_CORRECTED", "EXPENSE_DISCREPANCY_RESOLVED", "SETTLEMENT_REVERSED", "SETTLEMENT_STATUS_RECORDED", "SETTLEMENT_REFUNDED", "SESSION_CLOSED_PROVISIONAL", "SESSION_CLOSED_FINAL", "SESSION_REOPENED", "SESSION_ARCHIVED", "SESSION_RULES_RECORDED", "BUDGET_SET", "RECURRING_RULE_APPROVED", "RECURRING_INSTANCE_RECORDED", "SURPRISE_GIFT_RECORDED"]);
      if (organizerOnly.has(event?.type) && access.role !== "organizer") return send(res, 403, { error: "This ledger action is restricted to its organizer." });
      const actor = access.member_id;
      if (actor && before.members.find((member) => member.id === actor)?.status !== "active") return send(res, 403, { error: "Departed or removed participants cannot change this ledger." });
      if (actor && ["EXPENSE_RECORDED", "EXPENSE_UNASSIGNED"].includes(event?.type) && event.recurringRuleId) return send(res, 403, { error: "Only the organizer can generate an expense from an approved recurring rule." });
      if (actor && ["EXPENSE_RECORDED", "EXPENSE_UNASSIGNED"].includes(event?.type) && (event.paidByMemberId ?? event.payerId) !== actor) return send(res, 403, { error: "A participant can only enter an expense they paid." });
      if (actor && ["EXPENSE_RECORDED", "EXPENSE_UNASSIGNED"].includes(event?.type)) {
        const commitment = before.commitments.find((item) => item.commitmentId === event.commitmentId);
        const priorCommitmentMembers = new Set(commitment?.allocations.map((row) => row.memberId) ?? []);
        if ((event.allocations ?? []).some((row) => before.members.find((member) => member.id === row.memberId)?.status !== "active" && !priorCommitmentMembers.has(row.memberId))) return send(res, 403, { error: "A participant cannot assign a new expense to someone who has departed." });
      }
      if (actor && event?.type === "COMMITMENT_RECORDED" && (event.allocations ?? []).some((row) => before.members.find((member) => member.id === row.memberId)?.status !== "active")) return send(res, 403, { error: "A participant cannot create a new commitment for someone who has departed." });
      if (actor && event?.type === "MEMBER_CONFIRMED_EXPENSE" && event.memberId !== actor) return send(res, 403, { error: "A participant can only confirm their own expense allocation." });
      if (actor && event?.type === "EXPENSE_DISCREPANCY_RECORDED" && event.raisedByMemberId !== actor) return send(res, 403, { error: "A participant can only raise a discrepancy under their own name." });
      if (actor && event?.type === "EXPENSE_DISCREPANCY_RECORDED") {
        const expense = before.expenses.find((item) => item.id === event.expenseId);
        if (!expense || expense.status === "unassigned" || (expense.payerId !== actor && !expense.allocations.some((row) => row.memberId === actor))) return send(res, 403, { error: "A participant can only dispute an expense they paid for or were assigned." });
      }
      if (actor && event?.type === "SETTLEMENT_ASSERTED" && event.fromMemberId !== actor) return send(res, 403, { error: "A participant can only claim a payment they made." });
      if (actor && event?.type === "OBLIGATION_FORGIVEN" && event.creditorId !== actor) return send(res, 403, { error: "Only the creditor can forgive this obligation." });
      if (event?.type === "OBLIGATION_FORGIVEN" && access.role === "witness") return send(res, 403, { error: "Read-only witnesses cannot change financial obligations." });
      if (actor && event?.type === "RESPONSIBILITY_ASSUMED" && event.toMemberId !== actor) return send(res, 403, { error: "The participant assuming responsibility must submit the event." });
      if (actor && event?.type === "COMMITMENT_RECORDED" && event.payerMemberId !== actor) return send(res, 403, { error: "A participant can only create their own commitment." });
      if (actor && ["COMMITMENT_UPDATED", "COMMITMENT_REFUND_RECORDED"].includes(event?.type) && before.commitments.find((item) => item.commitmentId === event.commitmentId)?.payerMemberId !== actor) return send(res, 403, { error: "Only the commitment payer can update or refund it." });
      if (event?.type === "SETTLEMENT_CONFIRMED" && event.confirmationSource === "recipient_confirmation" && (access.role !== "member" || access.member_id !== event.confirmedByMemberId)) return send(res, 403, { error: "Only the recipient's own participant token can confirm this payment." });
      if (event?.type === "SETTLEMENT_CONFIRMED" && event.confirmationSource === "organizer_record" && access.role !== "organizer") return send(res, 403, { error: "Only the organizer can record this confirmation." });
      if (event?.type === "EVIDENCE_ATTACHED") {
        const file = db.prepare("SELECT sha256, media_type, byte_length FROM evidence WHERE id = ? AND session_id = ?").get(event.evidenceId, sessionId);
        if (!file || file.sha256 !== event.contentHash || file.media_type !== event.mediaType || file.byte_length !== event.byteLength) return send(res, 422, { error: "Evidence event must match an uploaded file in this session." });
      }
      const result = append(sessionId, event, requestId);
      if (["EXPENSE_RECORDED", "EXPENSE_UNASSIGNED"].includes(event.type)) {
        const current = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
        result.possibleDuplicates = findPossibleDuplicates(before.expenses, current.expenses.find((expense) => expense.sourceEventId === event.id) ?? event);
      }
      // Project cached write responses as well as new ones for the caller.
      // Idempotency snapshots are stored without a caller-specific view.
      const state = { ...result.state, expenses: result.state.expenses.map((expense) => {
        const gift = before.gifts.find((item) => item.giftId === expense.giftId);
        return gift && access.member_id === gift.recipientMemberId ? { ...expense, description: "Confidential surprise gift" } : expense;
      }) };
      return send(res, 201, { ...result, state });
    }
    if (req.method === "POST" && resource === "simulate") {
      const body = await readJson(req, 1_000_000);
      const events = getEvents(sessionId).events;
      const result = simulateLedger(events, body.proposedEvents, { baseCurrency: session.base_currency });
      return send(res, 200, { ...result, persisted: false });
    }
    if (req.method === "POST" && resource === "payments") {
      const body = await readJson(req, 16_000);
      const requestId = req.headers["idempotency-key"];
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)) return send(res, 400, { error: "A valid Idempotency-Key header is required." });
      if (access.role === "member" && access.member_id !== body.fromMemberId) return send(res, 403, { error: "A participant can only create a PayPal order for their own obligation." });
      const fingerprint = sha(canonicalStringify(body));
      const previous = db.prepare("SELECT * FROM paypal_order_requests WHERE session_id = ? AND request_id = ?").get(sessionId, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return send(res, 409, { error: "This idempotency key was already used for a different PayPal order." });
        if (previous.status === "created" && Date.now() - Date.parse(previous.created_at) < PAYPAL_APPROVAL_TTL_MS) return send(res, 200, { orderId: previous.order_id, status: "CREATED", approvalUrl: previous.approval_url, fromMemberId: previous.from_member_id, toMemberId: previous.to_member_id, amountMinor: previous.amount_minor, currency: "USD", replayed: true });
        if (previous.status === "created") {
          const orderRecord = db.prepare("SELECT status FROM paypal_orders WHERE order_id = ? AND session_id = ?").get(previous.order_id, sessionId);
          const expiredAt = new Date(Date.parse(previous.created_at) + PAYPAL_APPROVAL_TTL_MS).toISOString();
          if (orderRecord?.status === "created") {
            const expired = { id: `paypal_${previous.order_id}_expired`, at: expiredAt, type: "SETTLEMENT_STATUS_RECORDED", settlementId: `paypal_${previous.order_id}`, status: "denied", reason: "PayPal approval window expired without capture." };
            append(sessionId, expired, `paypal-expire-${previous.order_id}`);
            db.prepare("UPDATE paypal_orders SET status = 'expired' WHERE order_id = ? AND session_id = ?").run(previous.order_id, sessionId);
          }
          db.prepare("UPDATE paypal_order_requests SET status = 'expired' WHERE session_id = ? AND request_id = ?").run(sessionId, requestId);
          return send(res, 409, { error: "This approval window expired. Start a new checkout with a new idempotency key." });
        }
        if (previous.status === "cancelled" || previous.status === "expired") return send(res, 409, { error: "This PayPal attempt is terminal. Start a new checkout with a new idempotency key." });
        if (previous.status === "creating" && Date.now() - Date.parse(previous.created_at) < 60_000) return send(res, 409, { error: "This PayPal order is still being created. Retry with the same idempotency key shortly." });
        if (previous.status === "completed") return send(res, 409, { error: "This PayPal order was already captured." });
        if (["failed", "creating"].includes(previous.status) && previous.order_id) {
          const priorOrder = db.prepare("SELECT * FROM paypal_orders WHERE order_id = ? AND session_id = ?").get(previous.order_id, sessionId);
          if (priorOrder?.status === "created") {
            const priorEvents = getEvents(sessionId).events;
            if (!priorEvents.some((event) => event.id === `paypal_${priorOrder.order_id}_assert`)) {
              const event = { id: `paypal_${priorOrder.order_id}_assert`, at: priorOrder.created_at, type: "SETTLEMENT_ASSERTED", settlementId: `paypal_${priorOrder.order_id}`, fromMemberId: priorOrder.from_member_id, toMemberId: priorOrder.to_member_id, amountMinor: priorOrder.amount_minor, rail: "paypal" };
              append(sessionId, event, `paypal-order-${priorOrder.order_id}-assert`);
            }
            db.prepare("UPDATE paypal_order_requests SET status = 'created' WHERE session_id = ? AND request_id = ?").run(sessionId, requestId);
            return send(res, 200, { orderId: priorOrder.order_id, status: "CREATED", approvalUrl: previous.approval_url, fromMemberId: priorOrder.from_member_id, toMemberId: priorOrder.to_member_id, amountMinor: priorOrder.amount_minor, currency: "USD", replayed: true });
          }
          if (priorOrder) return send(res, 409, { error: "This PayPal order is terminal. Start a new checkout with a new idempotency key." });
        }
      }
      const ledger = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
      const due = ledger.outstanding.find((item) => item.debtorId === body.fromMemberId && item.creditorId === body.toMemberId)?.amountMinor ?? 0;
      const claimed = ledger.pendingClaims.find((item) => item.fromMemberId === body.fromMemberId && item.toMemberId === body.toMemberId)?.amountMinor ?? 0;
      const available = due - claimed;
      const amount = previous ? previous.amount_minor : body.amountMinor ?? available;
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > available) return send(res, 409, { error: "Checkout amount must fit within the unclaimed outstanding obligation.", availableMinor: available });
      if (session.base_currency !== "USD") return send(res, 422, { error: "PayPal Checkout currently requires a USD ledger session." });
      const config = paypalConfig();
      if (body.toMemberId !== config.payeeMemberId) return send(res, 422, { error: "PayPal Checkout can currently settle only obligations owed to the configured merchant participant." });
      const providerRequestId = previous?.provider_request_id ?? (previous ? `bl_${sha(requestId).slice(0, 32)}` : `bl_${sha(canonicalStringify([sessionId, requestId])).slice(0, 32)}`);
      const sessionSnapshot = db.prepare("SELECT event_count, head_hash FROM sessions WHERE id = ?").get(sessionId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const latestSession = db.prepare("SELECT event_count, head_hash FROM sessions WHERE id = ?").get(sessionId);
        if (latestSession.event_count !== sessionSnapshot.event_count || latestSession.head_hash !== sessionSnapshot.head_hash) throw Object.assign(new Error("The ledger changed while preparing checkout; reload and retry."), { status: 409 });
        const reservations = db.prepare("SELECT request_id, amount_minor, created_at, status, order_id FROM paypal_order_requests WHERE session_id = ? AND from_member_id = ? AND to_member_id = ? AND status IN ('creating', 'created')").all(sessionId, body.fromMemberId, body.toMemberId);
        const reserved = reservations.filter((row) => row.request_id !== requestId && Date.now() - Date.parse(row.created_at) < PAYPAL_APPROVAL_TTL_MS && (row.status === "creating" || !ledger.settlements.some((payment) => payment.settlementId === `paypal_${row.order_id}`))).reduce((total, row) => total + row.amount_minor, 0);
        const available = due - claimed - reserved;
        if (amount > available) throw Object.assign(new Error("Another checkout already reserves part of this obligation."), { status: 409 });
        if (previous) db.prepare("UPDATE paypal_order_requests SET amount_minor = ?, status = 'creating', created_at = ?, provider_request_id = ? WHERE session_id = ? AND request_id = ?").run(amount, new Date().toISOString(), providerRequestId, sessionId, requestId);
        else db.prepare("INSERT INTO paypal_order_requests(session_id, request_id, fingerprint, from_member_id, to_member_id, amount_minor, status, created_at, provider_request_id) VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?)").run(sessionId, requestId, fingerprint, body.fromMemberId, body.toMemberId, amount, new Date().toISOString(), providerRequestId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const appBase = (process.env.APP_BASE_URL ?? "http://127.0.0.1:4173").replace(/\/$/, "");
      try {
        const order = await paypalRequest("/v2/checkout/orders", { method: "POST", headers: { "PayPal-Request-Id": providerRequestId }, body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: `${sessionId}:${body.fromMemberId}:${body.toMemberId}`, description: "Shared expense settlement", amount: { currency_code: "USD", value: `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}` }, ...(config.payee ? { payee: { merchant_id: config.payee } } : {}) }], payment_source: { paypal: { experience_context: { return_url: `${appBase}/?payment=return`, cancel_url: `${appBase}/?payment=cancel`, shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } } }) });
        if (!order.id) throw Object.assign(new Error("PayPal did not return an order ID."), { status: 502 });
        const approvalUrl = order.links?.find((link) => link.rel === "approve" || link.rel === "payer-action")?.href;
        if (!approvalUrl) throw Object.assign(new Error("PayPal returned no buyer approval link."), { status: 502 });
        const orderCreatedAt = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT INTO paypal_orders(order_id, session_id, from_member_id, to_member_id, amount_minor, status, created_at) VALUES (?, ?, ?, ?, ?, 'created', ?)").run(order.id, sessionId, body.fromMemberId, body.toMemberId, amount, orderCreatedAt);
          db.prepare("UPDATE paypal_order_requests SET status = 'creating', order_id = ?, approval_url = ?, created_at = ? WHERE session_id = ? AND request_id = ?").run(order.id, approvalUrl, orderCreatedAt, sessionId, requestId);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        const pendingEvent = { id: `paypal_${order.id}_assert`, at: orderCreatedAt, type: "SETTLEMENT_ASSERTED", settlementId: `paypal_${order.id}`, fromMemberId: body.fromMemberId, toMemberId: body.toMemberId, amountMinor: amount, rail: "paypal" };
        append(sessionId, pendingEvent, `paypal-order-${order.id}-assert`);
        db.prepare("UPDATE paypal_order_requests SET status = 'created' WHERE session_id = ? AND request_id = ?").run(sessionId, requestId);
        return send(res, 201, { orderId: order.id, status: order.status, approvalUrl, fromMemberId: body.fromMemberId, toMemberId: body.toMemberId, amountMinor: amount, currency: "USD" });
      } catch (error) {
        db.prepare("UPDATE paypal_order_requests SET status = 'failed' WHERE session_id = ? AND request_id = ? AND status = 'creating'").run(sessionId, requestId);
        throw error;
      }
    }
    if (req.method === "POST" && /^payments\/[^/]+\/cancel$/.test(resource ?? "")) {
      const orderId = resource.split("/")[1];
      const order = db.prepare("SELECT * FROM paypal_orders WHERE order_id = ? AND session_id = ?").get(orderId, sessionId);
      if (!order) return send(res, 404, { error: "PayPal order was not created for this ledger session." });
      if (access.role === "member" && access.member_id !== order.from_member_id) return send(res, 403, { error: "A participant can only cancel their own PayPal order." });
      if (order.status !== "created") return send(res, 200, { status: order.status, orderId });
      // Keep the event payload stable if the client retries after an append succeeded
      // but before the order rows were updated.
      const at = order.created_at;
      const cancelled = { id: `paypal_${orderId}_cancelled`, at, type: "SETTLEMENT_STATUS_RECORDED", settlementId: `paypal_${orderId}`, status: "cancelled", reason: "Buyer cancelled PayPal approval." };
      append(sessionId, cancelled, `paypal-order-${orderId}-cancelled`);
      db.prepare("UPDATE paypal_orders SET status = 'cancelled' WHERE order_id = ? AND session_id = ?").run(orderId, sessionId);
      db.prepare("UPDATE paypal_order_requests SET status = 'cancelled' WHERE order_id = ? AND session_id = ?").run(orderId, sessionId);
      return send(res, 200, { status: "CANCELLED", orderId });
    }
    if (req.method === "POST" && /^payments\/[^/]+\/capture$/.test(resource ?? "")) {
      const orderId = resource.split("/")[1];
      if (!/^[A-Z0-9-]{5,80}$/i.test(orderId)) return send(res, 400, { error: "Invalid PayPal order ID." });
      const storedOrder = db.prepare("SELECT * FROM paypal_orders WHERE order_id = ? AND session_id = ?").get(orderId, sessionId);
      if (!storedOrder) return send(res, 404, { error: "PayPal order was not created for this ledger session." });
      if (access.role === "member" && access.member_id !== storedOrder.from_member_id) return send(res, 403, { error: "A participant can only capture their own PayPal order." });
      if (storedOrder.status === "completed" && storedOrder.capture_id) return send(res, 200, { status: "COMPLETED", orderId, captureId: storedOrder.capture_id, alreadyRecorded: true });
      if (storedOrder.status !== "created") return send(res, 409, { error: `This PayPal order is ${storedOrder.status} and cannot be captured.` });
      const recorded = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency }).settlements.find((item) => item.settlementId === `paypal_${orderId}`);
      if (recorded?.confirmation?.confirmationSource === "provider_capture" && recorded.confirmation.provider === "paypal" && recorded.confirmation.providerCaptureId) {
        const captureId = recorded.confirmation.providerCaptureId;
        completeOrderRows(sessionId, orderId, captureId);
        return send(res, 200, { status: "COMPLETED", orderId, captureId, alreadyRecorded: true });
      }
      const capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { "PayPal-Request-Id": `ledger-capture-${orderId}` }, body: "{}" });
      const unit = capture.purchase_units?.[0]; const payment = unit?.payments?.captures?.[0];
      if (capture.status !== "COMPLETED" || payment?.status !== "COMPLETED") {
        const providerStatus = payment?.status ?? capture.status;
        if (["DENIED", "VOIDED"].includes(providerStatus)) {
          const statusEvent = { id: `paypal_${orderId}_denied`, at: capture.update_time ?? storedOrder.created_at, type: "SETTLEMENT_STATUS_RECORDED", settlementId: `paypal_${orderId}`, status: "denied", reason: `PayPal reported ${providerStatus}.` };
          append(sessionId, statusEvent, `paypal-order-${orderId}-denied`);
          db.prepare("UPDATE paypal_orders SET status = ? WHERE order_id = ? AND session_id = ?").run(providerStatus.toLowerCase(), orderId, sessionId);
          db.prepare("UPDATE paypal_order_requests SET status = 'failed' WHERE order_id = ? AND session_id = ?").run(orderId, sessionId);
        }
        return send(res, 202, { status: providerStatus, orderId, message: "Payment remains unconfirmed in the ledger." });
      }
      const reference = String(unit.reference_id ?? "").split(":");
      if (reference.length !== 3 || reference[0] !== sessionId || reference[1] !== storedOrder.from_member_id || reference[2] !== storedOrder.to_member_id) return send(res, 409, { error: "PayPal order does not match its stored ledger obligation." });
      const [, fromMemberId, toMemberId] = reference;
      const occurredAt = payment.create_time ?? capture.update_time ?? new Date().toISOString();
      // Interpret the amount only after the claim is persisted. parseAmountToMinor
      // rejects currencies outside the supported table and excess precision, and a
      // throw here would otherwise discard the only record that money moved.
      let capturedMinor = null; let captureParseError = null;
      try { capturedMinor = parseAmountToMinor(payment.amount?.value, payment.amount?.currency_code); }
      catch (error) { captureParseError = error.message; }
      preserveCapturedPayment(sessionId, storedOrder, payment, capturedMinor, payment.amount?.currency_code, occurredAt, captureParseError);
      if (captureParseError) {
        const reason = `Provider capture amount could not be interpreted: ${captureParseError}`;
        console.warn(`[ledger] ${reason} order=${orderId} capture=${payment.id} value=${JSON.stringify(payment.amount?.value ?? null)} currency=${JSON.stringify(payment.amount?.currency_code ?? null)}`);
        markReconciliationRequired(sessionId, orderId, payment.id, reason);
        return send(res, 202, { status: "RECONCILIATION_REQUIRED", orderId, captureId: payment.id, providerAmount: payment.amount ?? null, parseError: captureParseError, message: "PayPal reports a completed capture whose amount this ledger cannot interpret. The financial event was not posted and requires organizer review." });
      }
      const latest = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
      const recordedDuringCapture = latest.settlements.find((item) => item.settlementId === `paypal_${orderId}`);
      if (recordedDuringCapture?.confirmation?.confirmationSource === "provider_capture" && recordedDuringCapture.confirmation.providerCaptureId === payment.id) {
        completeOrderRows(sessionId, orderId, payment.id);
        return send(res, 200, { status: "COMPLETED", orderId, captureId: payment.id, alreadyRecorded: true });
      }
      const due = latest.outstanding.find((item) => item.debtorId === fromMemberId && item.creditorId === toMemberId)?.amountMinor ?? 0;
      const orderSettlementId = `paypal_${orderId}`;
      const orderClaim = latest.settlements.find((item) => item.settlementId === orderSettlementId && item.status === "pending");
      const claimed = latest.pendingClaims.find((item) => item.fromMemberId === fromMemberId && item.toMemberId === toMemberId)?.amountMinor ?? 0;
      const otherClaims = claimed - (orderClaim?.amountMinor ?? 0);
      if (!orderClaim || capturedMinor !== storedOrder.amount_minor || capturedMinor !== orderClaim.amountMinor || capturedMinor > due - otherClaims || payment.amount?.currency_code !== session.base_currency) {
        const reason = "Captured amount or currency does not match the current outstanding ledger obligation.";
        markReconciliationRequired(sessionId, orderId, payment.id, reason);
        return send(res, 202, { status: "RECONCILIATION_REQUIRED", orderId, captureId: payment.id, capturedMinor, currency: payment.amount?.currency_code, availableMinor: due - otherClaims, message: "PayPal reports a completed capture. The financial event was not posted and requires organizer review." });
      }
      const confirmation = { id: `paypal_${payment.id}_confirmed`, at: occurredAt, type: "SETTLEMENT_CONFIRMED", settlementId: orderSettlementId, confirmedByMemberId: toMemberId, confirmationSource: "provider_capture", provider: "paypal", providerCaptureId: payment.id, providerStatus: "COMPLETED" };
      const confirmed = append(sessionId, confirmation, `paypal-capture-${payment.id}-confirmed`, { trustedProvider: true });
      completeOrderRows(sessionId, orderId, payment.id);
      return send(res, 200, { status: "COMPLETED", orderId, captureId: payment.id, event: confirmed.event, headHash: confirmed.headHash });
    }
    if (req.method === "POST" && /^payments\/[^/]+\/reconcile$/.test(resource ?? "")) {
      if (access.role !== "organizer") return send(res, 403, { error: "Only the organizer can reconcile a captured payment." });
      const orderId = resource.split("/")[1];
      const record = db.prepare("SELECT * FROM paypal_reconciliations WHERE order_id = ? AND session_id = ? AND status = 'pending'").get(orderId, sessionId);
      if (!record) return send(res, 404, { error: "No pending reconciliation exists for this order." });
      const order = db.prepare("SELECT * FROM paypal_orders WHERE order_id = ? AND session_id = ?").get(orderId, sessionId);
      if (!order) return send(res, 404, { error: "The payment order no longer exists." });
      if (record.parse_error) return send(res, 409, { error: "This capture's amount cannot be interpreted by the ledger, so it cannot be posted automatically. Settle it with the provider.", parseError: record.parse_error, providerAmount: { value: record.provider_amount_value, currency: record.provider_currency } });
      const latest = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
      const settlementId = `paypal_${orderId}`;
      const alreadyPosted = latest.settlements.find((item) => item.settlementId === settlementId && item.confirmation?.confirmationSource === "provider_capture" && item.confirmation.providerCaptureId === record.capture_id);
      if (alreadyPosted) {
        completeOrderRows(sessionId, orderId, record.capture_id);
        return send(res, 200, { status: "COMPLETED", orderId, captureId: record.capture_id, alreadyRecorded: true, reconciled: true });
      }
      const claim = latest.settlements.find((item) => item.settlementId === settlementId && item.status === "pending");
      const due = latest.outstanding.find((item) => item.debtorId === record.from_member_id && item.creditorId === record.to_member_id)?.amountMinor ?? 0;
      const claimed = latest.pendingClaims.find((item) => item.fromMemberId === record.from_member_id && item.toMemberId === record.to_member_id)?.amountMinor ?? 0;
      const otherClaims = claimed - (claim?.amountMinor ?? 0);
      if (!claim || record.amount_minor !== order.amount_minor || record.amount_minor !== claim.amountMinor || record.amount_minor > due - otherClaims || record.currency !== session.base_currency) {
        const reason = "Captured amount or currency still does not match the current outstanding ledger obligation.";
        db.prepare("UPDATE paypal_reconciliations SET reason = ? WHERE capture_id = ?").run(reason, record.capture_id);
        return send(res, 409, { error: reason, capturedMinor: record.amount_minor, currency: record.currency, availableMinor: due - otherClaims });
      }
      const confirmation = { id: `paypal_${record.capture_id}_confirmed`, at: record.occurred_at, type: "SETTLEMENT_CONFIRMED", settlementId, confirmedByMemberId: record.to_member_id, confirmationSource: "provider_capture", provider: "paypal", providerCaptureId: record.capture_id, providerStatus: "COMPLETED" };
      const confirmed = append(sessionId, confirmation, `paypal-capture-${record.capture_id}-confirmed`, { trustedProvider: true });
      completeOrderRows(sessionId, orderId, record.capture_id);
      return send(res, 200, { status: "COMPLETED", orderId, captureId: record.capture_id, event: confirmed.event, headHash: confirmed.headHash, reconciled: true });
    }
    if (req.method === "POST" && resource === "evidence") {
      if (access.role === "member") {
        const ledger = deriveLedger(getEvents(sessionId).events, { baseCurrency: session.base_currency });
        if (ledger.members.find((member) => member.id === access.member_id)?.status !== "active") return send(res, 403, { error: "Departed or removed participants cannot attach evidence." });
      }
      const body = await readJson(req, 11_000_000);
      if (typeof body.dataBase64 !== "string" || body.dataBase64.length > 10_700_000) return send(res, 413, { error: "Evidence exceeds the 8 MB limit." });
      const content = Buffer.from(body.dataBase64, "base64");
      if (!content.length || content.length > 8_000_000 || content.toString("base64").replace(/=+$/, "") !== body.dataBase64.replace(/=+$/, "")) return send(res, 400, { error: "Evidence encoding is invalid or exceeds the 8 MB limit." });
      const digest = sha(content); const mediaType = String(body.mediaType ?? "application/octet-stream").slice(0, 80);
      const duplicate = db.prepare("SELECT id, media_type, byte_length FROM evidence WHERE session_id = ? AND sha256 = ?").get(sessionId, digest);
      if (duplicate) {
        if (duplicate.media_type !== mediaType) return send(res, 409, { error: "Identical evidence bytes were already attached under a different media type." });
        const existingEvent = getEvents(sessionId).events.find((event) => event.type === "EVIDENCE_ATTACHED" && event.evidenceId === duplicate.id);
        if (existingEvent) return send(res, 200, { id: duplicate.id, sha256: digest, mediaType, byteLength: duplicate.byte_length, event: existingEvent, duplicate: true });
        const event = { id: randomUUID().replaceAll("-", ""), at: new Date().toISOString(), type: "EVIDENCE_ATTACHED", evidenceId: duplicate.id, contentHash: digest, mediaType, byteLength: duplicate.byte_length };
        const attached = append(sessionId, event, `evidence-${duplicate.id}`);
        return send(res, 201, { id: duplicate.id, sha256: digest, mediaType, byteLength: duplicate.byte_length, event: attached.event, headHash: attached.headHash });
      }
      const currentEvidenceBytes = db.prepare("SELECT COALESCE(SUM(byte_length), 0) AS total FROM evidence WHERE session_id = ?").get(sessionId).total;
      if (currentEvidenceBytes + content.length > 50_000_000) return send(res, 413, { error: "A ledger can store up to 50 MB of evidence." });
      const id = randomUUID().replaceAll("-", "");
      db.prepare("INSERT INTO evidence(id, session_id, sha256, media_type, byte_length, content) VALUES (?, ?, ?, ?, ?, ?)").run(id, sessionId, digest, mediaType, content.length, content);
      try {
        const event = { id: randomUUID().replaceAll("-", ""), at: new Date().toISOString(), type: "EVIDENCE_ATTACHED", evidenceId: id, contentHash: digest, mediaType, byteLength: content.length };
        const attached = append(sessionId, event, `evidence-${id}`);
        return send(res, 201, { id, sha256: digest, mediaType, byteLength: content.length, event: attached.event, headHash: attached.headHash });
      } catch (error) {
        db.prepare("DELETE FROM evidence WHERE id = ? AND session_id = ?").run(id, sessionId);
        throw error;
      }
    }
  }
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return send(res, 404, { error: "Route not found." });
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const publicFiles = new Set(["index.html", "styles.css", "src/app.js", "src/store.js", "src/domain.js", "src/domain/canonical.js", "src/domain/events.js", "src/domain/money.js", "src/domain/narrative.js"]);
  if (!publicFiles.has(requested) && !/^assets\/[a-zA-Z0-9_-]+\.(png|svg)$/.test(requested)) return send(res, 404, { error: "Not found." });
  const file = resolve(root, requested);
  if (!file.startsWith(`${root}${sep}`) || !existsSync(file) || !statSync(file).isFile() || realpathSync(file) !== file) return send(res, 404, { error: "Not found." });
  res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
  createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error.status ?? 400;
    if (status >= 500) console.error("Request failed:", error.message);
    send(res, status, { error: status >= 500 ? "Internal server error." : error.message });
  });
});
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => console.log(`The Black Ledger listening on http://${host}:${port}`));
