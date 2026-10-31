import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalStringify } from "../src/domain/canonical.js";

// A local provider double deliberately replays an order on a repeated provider
// request ID. No network request leaves the loopback interface.
test("PayPal creation keys are isolated between sessions and retry locally once", async (t) => {
  const seen = new Map(); const requests = []; const orderUnits = new Map(); const captureRequests = []; const captureAmounts = new Map();
  const provider = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/oauth2/token") { res.end(JSON.stringify({ access_token: "local-test-token" })); return; }
    const captureMatch = /^\/v2\/checkout\/orders\/(ORDER[0-9]+)\/capture$/.exec(req.url);
    if (captureMatch) {
      const id = captureMatch[1]; captureRequests.push(id);
      const unit = orderUnits.get(id);
      if (!unit) { res.writeHead(404).end("{}"); return; }
      res.end(JSON.stringify({ status: "COMPLETED", purchase_units: [{ reference_id: unit.reference_id, payments: { captures: [{ id: `CAPTURE${id}`, status: "COMPLETED", amount: captureAmounts.get(id) ?? unit.amount, create_time: "2026-10-30T12:00:00.000Z" }] } }] })); return;
    }
    if (req.url !== "/v2/checkout/orders") { res.writeHead(404).end("{}"); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const key = req.headers["paypal-request-id"];
    requests.push({ key, body });
    if (!seen.has(key)) seen.set(key, { id: `ORDER${seen.size + 10000}`, status: "CREATED", links: [{ rel: "approve", href: "https://example.invalid/approval" }] });
    orderUnits.set(seen.get(key).id, body.purchase_units[0]);
    res.end(JSON.stringify(seen.get(key)));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-paypal-test-"));
  const legacyDb = new DatabaseSync(path.join(dir, "ledger.sqlite"));
  legacyDb.exec("CREATE TABLE paypal_order_requests (session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, from_member_id TEXT NOT NULL, to_member_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, status TEXT NOT NULL, order_id TEXT, approval_url TEXT, created_at TEXT NOT NULL, PRIMARY KEY(session_id, request_id))");
  legacyDb.close();
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dir,
      PAYPAL_BASE_URL: providerOrigin, PAYPAL_CLIENT_ID: "local-id", PAYPAL_CLIENT_SECRET: "local-secret", PAYPAL_MERCHANT_ID: "merchant-account", PAYPAL_PAYEE_MEMBER_ID: "merchant" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = ""; child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);
  const makeSession = async () => {
    const response = await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Checkout isolation", baseCurrency: "USD" }) });
    assert.equal(response.status, 201); const session = await response.json();
    const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
    const append = async (fields) => {
      const response = await fetch(`${origin}/api/sessions/${session.sessionId}/events`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ event: { id: randomUUID(), at: new Date().toISOString(), ...fields } }) });
      assert.equal(response.status, 201, await response.text());
    };
    for (const memberId of ["merchant", "buyer"]) await append({ type: "MEMBER_ADDED", memberId, name: memberId });
    await append({ type: "EXPENSE_RECORDED", description: "Shared booking", payerId: "merchant", currency: "USD", amountMinor: 500, baseAmountMinor: 500, allocations: [{ memberId: "buyer", cents: 500 }] });
    return { ...session, headers };
  };
  const first = await makeSession(); const second = await makeSession();
  const key = randomUUID();
  const checkout = (session) => fetch(`${origin}/api/sessions/${session.sessionId}/payments`, { method: "POST", headers: { ...session.headers, "Idempotency-Key": key }, body: JSON.stringify({ fromMemberId: "buyer", toMemberId: "merchant", amountMinor: 500 }) });
  const a = await checkout(first); assert.equal(a.status, 201, await a.clone().text()); const orderA = await a.json();
  const replay = await checkout(first); assert.equal(replay.status, 200); assert.equal((await replay.json()).orderId, orderA.orderId);
  assert.equal(requests.length, 1, "same-session replay must not call provider again");
  const b = await checkout(second); assert.equal(b.status, 201, await b.clone().text()); const orderB = await b.json();
  assert.notEqual(orderA.orderId, orderB.orderId, "different sessions must create distinct orders even when client keys match");
  assert.equal(requests.length, 2); assert.notEqual(requests[0].key, requests[1].key);
  const database = new DatabaseSync(path.join(dir, "ledger.sqlite"));
  try {
    const saved = database.prepare("SELECT provider_request_id FROM paypal_order_requests WHERE session_id = ? AND request_id = ?").get(first.sessionId, key);
    assert.equal(saved.provider_request_id, requests[0].key, "new provider key must be persisted");
    const capture = () => fetch(`${origin}/api/sessions/${first.sessionId}/payments/${orderA.orderId}/capture`, { method: "POST", headers: first.headers });
    const concurrentCaptures = await Promise.all([capture(), capture()]);
    for (const response of concurrentCaptures) assert.equal(response.status, 200, await response.clone().text());
    const settled = await (await fetch(`${origin}/api/sessions/${first.sessionId}`, { headers: first.headers })).json();
    assert.equal(settled.events.filter((item) => item.type === "SETTLEMENT_CONFIRMED").length, 1, "concurrent captures must post one confirmation");
    assert.equal(settled.state.balances.buyer, 0);
    // Simulate a process exit after financial append but before order-row updates.
    database.prepare("UPDATE paypal_orders SET status = 'created', capture_id = NULL WHERE order_id = ?").run(orderA.orderId);
    database.prepare("UPDATE paypal_order_requests SET status = 'created' WHERE order_id = ?").run(orderA.orderId);
    const callsBeforeRecovery = captureRequests.length;
    const recovered = await capture(); assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json()).alreadyRecorded, true);
    assert.equal(captureRequests.length, callsBeforeRecovery, "recovery of a recorded capture must not call provider again");
    assert.equal(database.prepare("SELECT status FROM paypal_orders WHERE order_id = ?").get(orderA.orderId).status, "completed");
    captureAmounts.set(orderB.orderId, { currency_code: "USD", value: "6.00" });
    const mismatchCalls = captureRequests.length;
    const mismatch = await fetch(`${origin}/api/sessions/${second.sessionId}/payments/${orderB.orderId}/capture`, { method: "POST", headers: second.headers });
    assert.equal(mismatch.status, 202, await mismatch.clone().text());
    assert.equal((await mismatch.json()).status, "RECONCILIATION_REQUIRED");
    const inbox = await (await fetch(`${origin}/api/sessions/${second.sessionId}`, { headers: second.headers })).json();
    assert.equal(inbox.state.paymentReconciliations.length, 1);
    assert.equal(inbox.state.paymentReconciliations[0].amountMinor, 600);
    assert.equal(inbox.state.balances.buyer, -500, "captured mismatch must not silently alter balances");
    const retryMismatch = await fetch(`${origin}/api/sessions/${second.sessionId}/payments/${orderB.orderId}/reconcile`, { method: "POST", headers: second.headers });
    assert.equal(retryMismatch.status, 409);
    assert.equal(captureRequests.length, mismatchCalls + 1, "reconciliation must not call the provider again");
    assert.equal(database.prepare("SELECT status FROM paypal_reconciliations WHERE order_id = ?").get(orderB.orderId).status, "pending");
    const third = await makeSession();
    const legacyKey = randomUUID();
    const body = { fromMemberId: "buyer", toMemberId: "merchant", amountMinor: 500 };
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    database.prepare("INSERT INTO paypal_order_requests(session_id, request_id, fingerprint, from_member_id, to_member_id, amount_minor, status, created_at) VALUES (?, ?, ?, 'buyer', 'merchant', 500, 'failed', ?)").run(third.sessionId, legacyKey, sha(canonicalStringify(body)), new Date().toISOString());
    const legacyRetry = await fetch(`${origin}/api/sessions/${third.sessionId}/payments`, { method: "POST", headers: { ...third.headers, "Idempotency-Key": legacyKey }, body: JSON.stringify(body) });
    assert.equal(legacyRetry.status, 201, await legacyRetry.clone().text());
    const legacyOrder = await legacyRetry.json();
    assert.equal(requests.at(-1).key, `bl_${sha(legacyKey).slice(0, 32)}`, "pre-upgrade retries must keep their original provider key");
    const persistedCaptureId = `CAPTURE${legacyOrder.orderId}`;
    database.prepare("INSERT INTO paypal_reconciliations(capture_id, order_id, session_id, from_member_id, to_member_id, amount_minor, currency, occurred_at, status, reason, created_at) VALUES (?, ?, ?, 'buyer', 'merchant', 500, 'USD', ?, 'pending', 'Interrupted after provider capture.', ?)").run(persistedCaptureId, legacyOrder.orderId, third.sessionId, "2026-10-30T12:00:00.000Z", new Date().toISOString());
    database.prepare("UPDATE paypal_orders SET status = 'reconciliation_required', capture_id = ? WHERE order_id = ?").run(persistedCaptureId, legacyOrder.orderId);
    database.prepare("UPDATE paypal_order_requests SET status = 'reconciliation_required' WHERE order_id = ?").run(legacyOrder.orderId);
    const providerCallsBeforeReconcile = captureRequests.length;
    const reconcile = await fetch(`${origin}/api/sessions/${third.sessionId}/payments/${legacyOrder.orderId}/reconcile`, { method: "POST", headers: third.headers });
    assert.equal(reconcile.status, 200, await reconcile.clone().text());
    assert.equal((await reconcile.json()).reconciled, true);
    assert.equal(captureRequests.length, providerCallsBeforeReconcile, "persisted capture recovery must not contact provider");
    const afterReconcile = await (await fetch(`${origin}/api/sessions/${third.sessionId}`, { headers: third.headers })).json();
    assert.equal(afterReconcile.state.balances.buyer, 0);
    assert.equal(afterReconcile.state.paymentReconciliations.length, 0);
    assert.equal(database.prepare("SELECT status FROM paypal_reconciliations WHERE capture_id = ?").get(persistedCaptureId).status, "resolved");
    database.prepare("UPDATE paypal_reconciliations SET status = 'pending', resolved_at = NULL WHERE capture_id = ?").run(persistedCaptureId);
    database.prepare("UPDATE paypal_orders SET status = 'reconciliation_required', capture_id = ? WHERE order_id = ?").run(persistedCaptureId, legacyOrder.orderId);
    database.prepare("UPDATE paypal_order_requests SET status = 'reconciliation_required' WHERE order_id = ?").run(legacyOrder.orderId);
    const interruptedRetry = await fetch(`${origin}/api/sessions/${third.sessionId}/payments/${legacyOrder.orderId}/reconcile`, { method: "POST", headers: third.headers });
    assert.equal(interruptedRetry.status, 200, await interruptedRetry.clone().text());
    assert.equal((await interruptedRetry.json()).alreadyRecorded, true, "retry after event append must finish rows without another event");
    const finalState = await (await fetch(`${origin}/api/sessions/${third.sessionId}`, { headers: third.headers })).json();
    assert.equal(finalState.events.filter((item) => item.type === "SETTLEMENT_CONFIRMED").length, 1);
  } finally { database.close(); }

});
