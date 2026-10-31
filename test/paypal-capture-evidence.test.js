import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// A completed provider capture is evidence that money moved. The ledger must
// persist that claim before interpreting it, so an amount or currency it cannot
// parse still reaches the organizer instead of being discarded. The loopback
// provider double returns a COMPLETED capture with an amount of our choosing.
test("an uninterpretable provider capture is preserved as organizer evidence, not discarded", async (t) => {
  const seen = new Map(); const orderUnits = new Map(); const captureRequests = []; const captureAmounts = new Map();
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
    if (!seen.has(key)) seen.set(key, { id: `ORDER${seen.size + 10000}`, status: "CREATED", links: [{ rel: "approve", href: "https://example.invalid/approval" }] });
    orderUnits.set(seen.get(key).id, body.purchase_units[0]);
    res.end(JSON.stringify(seen.get(key)));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-capture-evidence-"));
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dir,
      PAYPAL_BASE_URL: providerOrigin, PAYPAL_CLIENT_ID: "local-id", PAYPAL_CLIENT_SECRET: "local-secret",
      PAYPAL_MERCHANT_ID: "merchant-account", PAYPAL_PAYEE_MEMBER_ID: "merchant" },
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
    const response = await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Capture evidence", baseCurrency: "USD" }) });
    assert.equal(response.status, 201); const session = await response.json();
    const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
    const append = async (fields) => {
      const result = await fetch(`${origin}/api/sessions/${session.sessionId}/events`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ event: { id: randomUUID(), at: new Date().toISOString(), ...fields } }) });
      assert.equal(result.status, 201, await result.text());
    };
    for (const memberId of ["merchant", "buyer"]) await append({ type: "MEMBER_ADDED", memberId, name: memberId });
    await append({ type: "EXPENSE_RECORDED", description: "Shared booking", payerId: "merchant", currency: "USD", amountMinor: 500, baseAmountMinor: 500, allocations: [{ memberId: "buyer", cents: 500 }] });
    return { ...session, headers };
  };

  const database = new DatabaseSync(path.join(dir, "ledger.sqlite"));
  const captureWith = async (amount) => {
    const session = await makeSession();
    const created = await fetch(`${origin}/api/sessions/${session.sessionId}/payments`, { method: "POST", headers: { ...session.headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ fromMemberId: "buyer", toMemberId: "merchant", amountMinor: 500 }) });
    assert.equal(created.status, 201, await created.clone().text());
    const order = await created.json();
    captureAmounts.set(order.orderId, amount);
    const callsBefore = captureRequests.length;
    const capture = await fetch(`${origin}/api/sessions/${session.sessionId}/payments/${order.orderId}/capture`, { method: "POST", headers: session.headers });
    return { session, order, capture, body: await capture.json(), callsBefore };
  };

  for (const amount of [{ currency_code: "XYZ", value: "5.00" }, { currency_code: "USD", value: "5.001" }]) {
    const { session, order, capture, body, callsBefore } = await captureWith(amount);
    const label = JSON.stringify(amount);
    assert.equal(captureRequests.length, callsBefore + 1, `${label}: the provider must have been called`);
    assert.equal(capture.status, 202, `${label}: ${JSON.stringify(body)}`);
    assert.equal(body.status, "RECONCILIATION_REQUIRED", label);
    assert.ok(body.parseError, `${label}: the response must name why the amount was not interpreted`);

    const row = database.prepare("SELECT status, parse_error AS parseError, provider_amount_value AS value, provider_currency AS currency FROM paypal_reconciliations WHERE order_id = ?").get(order.orderId);
    assert.ok(row, `${label}: a completed capture must leave reconciliation evidence`);
    assert.equal(row.status, "pending", label);
    assert.ok(row.parseError, label);
    assert.equal(row.value, amount.value, `${label}: the provider's own amount must be preserved verbatim`);
    assert.equal(row.currency, amount.currency_code, label);
    assert.equal(database.prepare("SELECT status FROM paypal_orders WHERE order_id = ?").get(order.orderId).status, "reconciliation_required", label);

    const state = await (await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: session.headers })).json();
    const tray = state.state.paymentReconciliations;
    assert.equal(tray.length, 1, `${label}: the organizer must see the capture`);
    assert.equal(tray[0].providerAmountValue, amount.value, label);
    assert.ok(tray[0].parseError, label);

    const retry = await fetch(`${origin}/api/sessions/${session.sessionId}/payments/${order.orderId}/capture`, { method: "POST", headers: session.headers });
    assert.equal(retry.status, 409, `${label}: a preserved capture must not be recapturable`);
    assert.equal(captureRequests.length, callsBefore + 1, `${label}: the retry must not call the provider again`);

    const reconcile = await fetch(`${origin}/api/sessions/${session.sessionId}/payments/${order.orderId}/reconcile`, { method: "POST", headers: session.headers });
    assert.equal(reconcile.status, 409, `${label}: an uninterpretable capture must not be postable`);
    assert.match((await reconcile.json()).parseError, /currency|decimal/i, label);

    const after = await (await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: session.headers })).json();
    assert.equal(after.events.filter((item) => item.type === "SETTLEMENT_CONFIRMED").length, 0, `${label}: no settlement may be posted`);
    assert.equal(after.state.balances.buyer, -500, `${label}: balances must be unchanged`);
    assert.match(logs, /could not be interpreted/, `${label}: the operator must be warned at the boundary`);
  }
  database.close();
});
