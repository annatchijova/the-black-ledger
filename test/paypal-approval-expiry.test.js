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

// A claim is a ledger event and events do not expire, so an abandoned approval
// kept reserving the obligation. Only a retry with the very same idempotency key
// used to clear it, which nobody has a reason to send.
test("an abandoned approval stops blocking the rail, and a live one still holds it", async (t) => {
  const seen = new Map(); const orderUnits = new Map();
  const provider = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/oauth2/token") { res.end(JSON.stringify({ access_token: "local-test-token" })); return; }
    if (req.url !== "/v2/checkout/orders") { res.writeHead(404).end("{}"); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const key = req.headers["paypal-request-id"];
    if (!seen.has(key)) seen.set(key, { id: `ORDER${seen.size + 10000}`, status: "CREATED", links: [{ rel: "approve", href: "https://example.invalid/approve" }] });
    orderUnits.set(seen.get(key).id, body.purchase_units[0]);
    res.end(JSON.stringify(seen.get(key)));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-approval-expiry-"));
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dir,
      PAYPAL_BASE_URL: `http://127.0.0.1:${provider.address().port}`, PAYPAL_CLIENT_ID: "local-id",
      PAYPAL_CLIENT_SECRET: "local-secret", PAYPAL_MERCHANT_ID: "merchant-account", PAYPAL_PAYEE_MEMBER_ID: "merchant" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = ""; child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);

  const session = await (await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Approval expiry", baseCurrency: "USD" }) })).json();
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
  const append = async (fields) => {
    const result = await fetch(`${origin}/api/sessions/${session.sessionId}/events`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ event: { id: randomUUID(), at: new Date().toISOString(), ...fields } }) });
    assert.equal(result.status, 201, await result.text());
  };
  for (const memberId of ["merchant", "buyer"]) await append({ type: "MEMBER_ADDED", memberId, name: memberId });
  await append({ type: "EXPENSE_RECORDED", description: "Booking", payerId: "merchant", currency: "USD", amountMinor: 500, baseAmountMinor: 500, allocations: [{ memberId: "buyer", cents: 500 }] });

  const checkout = () => fetch(`${origin}/api/sessions/${session.sessionId}/payments`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ fromMemberId: "buyer", toMemberId: "merchant", amountMinor: 500 }) });
  const state = async () => (await (await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers })).json());

  const first = await checkout();
  assert.equal(first.status, 201, await first.clone().text());
  const abandoned = (await first.json()).orderId;

  // Negative control: while the window is live the obligation stays reserved.
  const tooSoon = await checkout();
  assert.equal(tooSoon.status, 409, "a live approval must keep holding the obligation");
  assert.equal((await tooSoon.json()).availableMinor, 0);

  // Push the window past its TTL without touching the ledger events.
  const database = new DatabaseSync(path.join(dir, "ledger.sqlite"));
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  database.prepare("UPDATE paypal_order_requests SET created_at = ? WHERE order_id = ?").run(longAgo, abandoned);
  database.prepare("UPDATE paypal_orders SET created_at = ? WHERE order_id = ?").run(longAgo, abandoned);

  const afterExpiry = await checkout();
  assert.equal(afterExpiry.status, 201, `a dead approval must not block a new checkout: ${await afterExpiry.clone().text()}`);
  const replacement = (await afterExpiry.json()).orderId;
  assert.notEqual(replacement, abandoned);

  const settled = await state();
  const expiryEvents = settled.events.filter((item) => item.type === "SETTLEMENT_STATUS_RECORDED" && item.settlementId === `paypal_${abandoned}`);
  assert.equal(expiryEvents.length, 1, "the expiry must be recorded exactly once");
  assert.equal(expiryEvents[0].status, "denied");
  assert.match(expiryEvents[0].reason, /approval window expired/i);
  assert.equal(database.prepare("SELECT status FROM paypal_orders WHERE order_id = ?").get(abandoned).status, "expired");

  // Exactly one claim may reserve the obligation, and expiring never moves money.
  const pending = settled.state.settlements.filter((item) => item.status === "pending");
  assert.equal(pending.length, 1, "the abandoned claim must no longer reserve the obligation");
  assert.equal(settled.state.balances.buyer, -500, "expiring an approval must not change balances");

  // Sweeping again must not append a second expiry for the same order.
  const third = await checkout();
  assert.equal(third.status, 409, "the replacement approval now holds the obligation");
  const again = await state();
  assert.equal(again.events.filter((item) => item.type === "SETTLEMENT_STATUS_RECORDED" && item.settlementId === `paypal_${abandoned}`).length, 1, "the sweep must be idempotent");
  database.close();
});
