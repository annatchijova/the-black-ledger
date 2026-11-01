import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// A short code is dictated and typed by hand, so it has to survive the way
// people actually write it down, be spendable exactly once, and be useless to
// anyone guessing.
test("a join code is forgiving to type, single use, and cheap to refuse", async (t) => {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-join-code-"));
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dir },
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

  const session = await (await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Join codes", baseCurrency: "USD" }) })).json();
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
  const invite = async (role, name) => {
    const response = await fetch(`${origin}/api/sessions/${session.sessionId}/invitations`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ role, name }) });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return JSON.parse(text);
  };
  const join = (code) => fetch(`${origin}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });

  const sol = await invite("member", "Sol");
  assert.match(sol.joinCode, /^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/, `unexpected code shape: ${sol.joinCode}`);
  assert.ok(!/[ILOU]/.test(sol.joinCode), "the alphabet must exclude the characters people confuse");

  // The code is stored hashed, so it cannot be read back out of the database.
  const database = new DatabaseSync(path.join(dir, "ledger.sqlite"));
  const stored = database.prepare("SELECT code_hash, member_id AS memberId, role FROM invite_codes").all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].memberId, sol.memberId);
  assert.ok(!stored.some((row) => row.code_hash.includes(sol.joinCode.replace("-", ""))), "the code must not be recoverable from storage");
  assert.equal(stored[0].code_hash, createHash("sha256").update(sol.joinCode.replace("-", "")).digest("hex"));

  // Typed as people type: lower case, no dash, spaced, and with the confusable
  // letters standing in for digits.
  const asTyped = sol.joinCode.toLowerCase().replace("-", " ").replace(/0/g, "o").replace(/1/g, "l");
  const redeemed = await join(asTyped);
  assert.equal(redeemed.status, 200, `${asTyped} should resolve to ${sol.joinCode}: ${await redeemed.clone().text()}`);
  const claim = await redeemed.json();
  assert.equal(claim.sessionId, session.sessionId);
  assert.equal(claim.memberId, sol.memberId, "the code must mint a credential for its own invitation");
  assert.equal(claim.role, "member");
  assert.notEqual(claim.accessToken, sol.accessToken, "redeeming mints a new credential rather than handing over a stored one");

  // The minted credential really works, with the role it was issued for.
  const asSol = await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: { authorization: `Bearer ${claim.accessToken}` } });
  assert.equal(asSol.status, 200);
  assert.equal((await asSol.json()).access.role, "member");

  // Spent once.
  const second = await join(sol.joinCode);
  assert.equal(second.status, 404, "a spent code must not work twice");

  // A witness code mints a witness, not a member.
  const auditor = await invite("witness", "Auditor");
  const asAuditor = await (await join(auditor.joinCode)).json();
  const witnessWrite = await fetch(`${origin}/api/sessions/${session.sessionId}/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${asAuditor.accessToken}`, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ event: { id: randomUUID(), at: new Date().toISOString(), type: "MEMBER_ADDED", memberId: "x", name: "x" } }) });
  assert.equal(witnessWrite.status, 403, "a witness code must not mint write access");

  // An expired code is refused, and says exactly what an unknown code says, so
  // probing cannot tell a real code from a wrong one.
  const nico = await invite("member", "Nico");
  database.prepare("UPDATE invite_codes SET expires_at = ? WHERE member_id = ?").run(new Date(Date.now() - 1000).toISOString(), nico.memberId);
  const expired = await join(nico.joinCode);
  const unknown = await join("ZZZZ-ZZZZ");
  assert.equal(expired.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await expired.json(), await unknown.json(), "expired and unknown must be indistinguishable");
  database.close();

  // The attempt ceiling applies before a code is examined, so guessing costs the
  // same whether or not the guess was close. Checked last: it exhausts the hour.
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const response = await join(`ZZZZ-ZZZ${i % 10}`);
    if (response.status === 429) { refused = i; break; }
  }
  assert.ok(refused > 0 && refused < 40, `the ceiling must engage, stopped at ${refused}`);
  const valid = await invite("member", "Blocked");
  assert.equal((await join(valid.joinCode)).status, 429, "once the ceiling is reached even a valid code is refused");
});
