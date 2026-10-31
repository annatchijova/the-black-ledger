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

// Exercises the paid-analysis branch against a loopback double. No request
// leaves the loopback interface and no real provider is contacted.
test("analysis spend is charged only when the provider actually answered", async (t) => {
  let nextStatus = 200; let nextBody = {};
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    calls.push(req.url);
    for await (const chunk of req) void chunk;
    res.writeHead(nextStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(nextBody));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  t.after(() => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }));

  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-analysis-provider-"));
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dir,
      OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: providerOrigin },
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

  const session = await (await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Analysis spend", baseCurrency: "USD" }) })).json();
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
  const append = async (fields) => {
    const result = await fetch(`${origin}/api/sessions/${session.sessionId}/events`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ event: { id: randomUUID(), at: new Date().toISOString(), ...fields } }) });
    assert.equal(result.status, 201, await result.text());
  };
  for (const memberId of ["merchant", "buyer"]) await append({ type: "MEMBER_ADDED", memberId, name: memberId });
  await append({ type: "EXPENSE_RECORDED", description: "Shared booking", payerId: "merchant", currency: "USD", amountMinor: 500, baseAmountMinor: 500, allocations: [{ memberId: "buyer", cents: 500 }] });

  const database = new DatabaseSync(path.join(dir, "ledger.sqlite"));
  const count = (scope) => database.prepare("SELECT request_count FROM analysis_usage WHERE scope_id = ?").get(scope)?.request_count ?? 0;
  const scenario = () => fetch(`${origin}/api/sessions/${session.sessionId}/analysis/scenario`, { method: "POST", headers, body: JSON.stringify({ prompt: "Simulate a harmless hypothetical" }) });
  const sourceScope = database.prepare("SELECT scope_id FROM analysis_usage WHERE scope_id LIKE 'analysis:source:%'").get()?.scope_id;

  // A provider error must not consume the shared spend ceiling.
  nextStatus = 500; nextBody = { error: "provider down" };
  const failed = await scenario();
  assert.equal(failed.status, 502, await failed.clone().text());
  assert.equal(calls.length, 1, "the provider must have been called");
  assert.equal(count("analysis:global"), 0, "a provider error must not consume spend");
  const source = sourceScope ?? database.prepare("SELECT scope_id FROM analysis_usage WHERE scope_id LIKE 'analysis:source:%'").get().scope_id;
  assert.equal(count(source), 1, "the attempt must still be counted");

  // A provider answer is billable and must be charged.
  nextStatus = 200;
  nextBody = { output: [{ content: [{ type: "output_text", text: JSON.stringify({ expenses: [], uncertainties: [] }) }] }] };
  const answered = await scenario();
  assert.equal(answered.status, 200, await answered.clone().text());
  assert.equal(count("analysis:global"), 1, "an answered request must consume spend");
  assert.equal(count(source), 2);
  database.close();
});
