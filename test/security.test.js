import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("a participant cannot reactivate a departed participant with MEMBER_JOINED", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "black-ledger-red-team-"));
  const port = await availablePort();
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, `isolated server did not become ready: ${logs}`);

  const createResponse = await fetch(`${origin}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Security reproduction", baseCurrency: "USD" })
  });
  assert.equal(createResponse.status, 201);
  const session = await createResponse.json();
  const organizerHeaders = { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" };
  const addInvitation = async (name) => {
    const response = await fetch(`${origin}/api/sessions/${session.sessionId}/invitations`, { method: "POST", headers: organizerHeaders, body: JSON.stringify({ name, role: "member" }) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const departed = await addInvitation("Departed");
  const attacker = await addInvitation("Active participant");
  const recipient = await addInvitation("Gift recipient");
  const witnessResponse = await fetch(`${origin}/api/sessions/${session.sessionId}/invitations`, { method: "POST", headers: organizerHeaders, body: JSON.stringify({ name: "Witness", role: "witness" }) });
  assert.equal(witnessResponse.status, 201);
  const witness = await witnessResponse.json();
  const addEvent = (token, event) => fetch(`${origin}/api/sessions/${session.sessionId}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ event })
  });
  const timestamp = () => new Date().toISOString();

  const departure = await addEvent(session.accessToken, { id: randomUUID(), at: timestamp(), type: "MEMBER_STATUS_CHANGED", memberId: departed.memberId, status: "departed" });
  assert.equal(departure.status, 201);

  const reactivation = await addEvent(attacker.accessToken, { id: randomUUID(), at: timestamp(), type: "MEMBER_JOINED", memberId: departed.memberId });
  assert.equal(reactivation.status, 403, "only the organizer should change a departed participant back to active");
  const stateResponse = await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: { authorization: `Bearer ${attacker.accessToken}` } });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.state.members.find((member) => member.id === departed.memberId).status, "departed", "rejected events must leave participant state unchanged");

  const archiveAttempt = await addEvent(attacker.accessToken, { id: randomUUID(), at: timestamp(), type: "SESSION_ARCHIVED", provisional: false });
  assert.equal(archiveAttempt.status, 403, "a participant must not be able to archive the whole ledger");

  const witnessWrite = await addEvent(witness.accessToken, { id: randomUUID(), at: timestamp(), type: "SESSION_REOPENED" });
  assert.equal(witnessWrite.status, 403, "a read-only witness must not write events");

  const forgedPayer = await addEvent(attacker.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_RECORDED", description: "Forged payer",
    payerId: departed.memberId, amountMinor: 500, currency: "USD", baseAmountMinor: 500,
    allocations: [{ memberId: departed.memberId, cents: 500 }]
  });
  assert.equal(forgedPayer.status, 403, "a participant must not record a charge as paid by someone else");

  const forgedExpense = await addEvent(departed.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_RECORDED", description: "Unauthorized after departure",
    payerId: departed.memberId, amountMinor: 500, currency: "USD", baseAmountMinor: 500,
    allocations: [{ memberId: departed.memberId, cents: 500 }]
  });
  assert.equal(forgedExpense.status, 403, "the departed token must remain unable to write after the attempted reactivation");

  const organizerReactivation = await addEvent(session.accessToken, { id: randomUUID(), at: timestamp(), type: "MEMBER_STATUS_CHANGED", memberId: departed.memberId, status: "active" });
  assert.equal(organizerReactivation.status, 201, "the organizer retains the intended reactivation path");

  const secret = "The secret museum ticket";
  const gift = await addEvent(session.accessToken, {
    id: randomUUID(), at: timestamp(), type: "SURPRISE_GIFT_RECORDED", giftId: randomUUID(),
    recipientMemberId: recipient.memberId, payerMemberId: attacker.memberId,
    privateDescription: secret, amountMinor: 300,
    contributions: [{ memberId: attacker.memberId, cents: 300 }]
  });
  assert.equal(gift.status, 201);
  const recipientView = await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: { authorization: `Bearer ${recipient.accessToken}` } });
  assert.equal(recipientView.status, 200);
  assert.equal(JSON.stringify(await recipientView.json()).includes(secret), false, "the gift recipient must not receive the private description through either events or derived state");
});
