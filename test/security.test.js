import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { verifyEvidencePackage } from "../src/verify-package.js";

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("API enforces participant authorization and confidential gift visibility", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "black-ledger-red-team-"));
  const port = await availablePort();
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dataDir, OPENAI_API_KEY: "" },
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

  const commitmentId = randomUUID();
  const precommitted = await addEvent(session.accessToken, {
    id: randomUUID(), at: timestamp(), type: "COMMITMENT_RECORDED", commitmentId,
    description: "Non-refundable ticket booked before departure", amountMinor: 1000,
    payerMemberId: departed.memberId, allocations: [{ memberId: departed.memberId, cents: 1000 }],
    refundability: "nonrefundable"
  });
  assert.equal(precommitted.status, 201);

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
  const witnessAnalysis = await fetch(`${origin}/api/sessions/${session.sessionId}/analysis/scenario`, {
    method: "POST", headers: { authorization: `Bearer ${witness.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Simulate a harmless hypothetical" })
  });
  assert.equal(witnessAnalysis.status, 403, "a read-only witness must not invoke paid analysis endpoints");
  const witnessReceipt = await fetch(`${origin}/api/sessions/${session.sessionId}/analysis/receipt`, {
    method: "POST", headers: { authorization: `Bearer ${witness.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ mediaType: "image/png", dataBase64: "AA==" })
  });
  assert.equal(witnessReceipt.status, 403, "a read-only witness must not invoke receipt analysis either");
  const departedAnalysis = await fetch(`${origin}/api/sessions/${session.sessionId}/analysis/scenario`, {
    method: "POST", headers: { authorization: `Bearer ${departed.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Simulate a harmless hypothetical" })
  });
  assert.equal(departedAnalysis.status, 403, "a departed participant must not invoke paid analysis endpoints");
  const activeAnalysis = await fetch(`${origin}/api/sessions/${session.sessionId}/analysis/scenario`, {
    method: "POST", headers: { authorization: `Bearer ${attacker.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Simulate a harmless hypothetical" })
  });
  assert.equal(activeAnalysis.status, 503, "an active participant remains eligible; this isolated server has no provider key");

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

  const newDebtForDeparted = await addEvent(attacker.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_RECORDED", description: "New cost after departure",
    payerId: attacker.memberId, amountMinor: 500, currency: "USD", baseAmountMinor: 500,
    allocations: [{ memberId: attacker.memberId, cents: 250 }, { memberId: departed.memberId, cents: 250 }]
  });
  assert.equal(newDebtForDeparted.status, 403, "an active participant must not create a new obligation for someone who departed earlier");
  const newCommitmentForDeparted = await addEvent(attacker.accessToken, {
    id: randomUUID(), at: timestamp(), type: "COMMITMENT_RECORDED", commitmentId: randomUUID(),
    description: "New reservation after departure", amountMinor: 500, payerMemberId: attacker.memberId,
    allocations: [{ memberId: attacker.memberId, cents: 250 }, { memberId: departed.memberId, cents: 250 }],
    refundability: "refundable"
  });
  assert.equal(newCommitmentForDeparted.status, 403, "a participant must not create a new commitment for someone who departed earlier");

  const priorCommitmentCost = await addEvent(session.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_RECORDED", description: "The booked ticket was used",
    payerId: departed.memberId, amountMinor: 1000, currency: "USD", baseAmountMinor: 1000,
    allocations: [{ memberId: departed.memberId, cents: 1000 }], commitmentId
  });
  assert.equal(priorCommitmentCost.status, 201, "a pre-departure commitment can still be settled after departure");
  const commitmentResolved = await addEvent(session.accessToken, { id: randomUUID(), at: timestamp(), type: "COMMITMENT_UPDATED", commitmentId, status: "consumed", reason: "Booked ticket cost was recorded" });
  assert.equal(commitmentResolved.status, 201);

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

  const expenseId = randomUUID();
  const expense = await addEvent(session.accessToken, {
    id: expenseId, expenseId, at: timestamp(), type: "EXPENSE_RECORDED", description: "A charge assigned to one person",
    payerId: attacker.memberId, amountMinor: 500, currency: "USD", baseAmountMinor: 500,
    allocations: [{ memberId: attacker.memberId, cents: 500 }]
  });
  assert.equal(expense.status, 201);
  const assignedDispute = await addEvent(attacker.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_DISCREPANCY_RECORDED",
    expenseId, discrepancyId: randomUUID(), raisedByMemberId: attacker.memberId,
    claim: "The amount needs review"
  });
  assert.equal(assignedDispute.status, 201, "a participant assigned to the expense retains the discrepancy path");
  const unrelatedDispute = await addEvent(recipient.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_DISCREPANCY_RECORDED",
    expenseId, discrepancyId: randomUUID(), raisedByMemberId: recipient.memberId,
    claim: "I was not part of this expense"
  });
  assert.equal(unrelatedDispute.status, 403, "a participant not assigned to an expense must not be able to dispute it");
  const sourceExposure = await fetch(`${origin}/src/server.js`);
  assert.equal(sourceExposure.status, 404, "server implementation must not be served as a public asset");
  for (const resource of ["/.env.example", "/package.json", "/src/verify-package.js", "/src", "/data/ledger.sqlite", "/data/ledger.sqlite-wal"]) {
    assert.equal((await fetch(`${origin}${resource}`)).status, 404, `${resource} must not be public`);
  }
  for (const resource of ["/", "/styles.css", "/src/app.js", "/src/domain.js", "/src/store.js", "/src/domain/events.js", "/src/domain/money.js", "/src/domain/canonical.js", "/src/domain/narrative.js"]) {
    assert.equal((await fetch(`${origin}${resource}`)).status, 200, `${resource} must remain available`);
  }

  const recipientExpense = { id: randomUUID(), at: timestamp(), type: "EXPENSE_RECORDED", description: "Recipient's own purchase", payerId: recipient.memberId,
    amountMinor: 100, baseAmountMinor: 100, currency: "USD", allocations: [{ memberId: recipient.memberId, cents: 100 }] };
  const privacyKey = randomUUID();
  const privateWrite = () => fetch(`${origin}/api/sessions/${session.sessionId}/events`, {
    method: "POST", headers: { authorization: `Bearer ${recipient.accessToken}`, "content-type": "application/json", "Idempotency-Key": privacyKey }, body: JSON.stringify({ event: recipientExpense })
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await privateWrite(); assert.equal(response.status, 201);
    assert.equal(JSON.stringify(await response.json()).includes(secret), false, "write and idempotent replay responses must hide the recipient's gift description");
  }
  const beforeForgery = await (await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: organizerHeaders })).json();
  const forgedUnassigned = await addEvent(attacker.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_UNASSIGNED", description: "Falsely attributed purchase", payerId: recipient.memberId,
    amountMinor: 100, baseAmountMinor: 100, currency: "USD", allocations: []
  });
  assert.equal(forgedUnassigned.status, 403, "unassigned expenses must enforce payer ownership too");
  const afterForgery = await (await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers: organizerHeaders })).json();
  assert.equal(afterForgery.headHash, beforeForgery.headHash, "rejected forgery must not append an event");
  assert.equal(afterForgery.events.filter((event) => event.id === recipientExpense.id).length, 1, "idempotent retries append exactly once");
  assert.equal(JSON.stringify(afterForgery).includes(secret), true, "organizer retains the complete gift description");
  const ownUnassigned = await addEvent(attacker.accessToken, {
    id: randomUUID(), at: timestamp(), type: "EXPENSE_UNASSIGNED", description: "Own purchase pending allocation", payerId: attacker.memberId,
    amountMinor: 100, baseAmountMinor: 100, currency: "USD", allocations: []
  });
  assert.equal(ownUnassigned.status, 201, "participants can still record their own unassigned expenses");

  const secondDeparture = await addEvent(session.accessToken, { id: randomUUID(), at: timestamp(), type: "MEMBER_STATUS_CHANGED", memberId: departed.memberId, status: "departed" });
  assert.equal(secondDeparture.status, 201);
  const departedUpload = await fetch(`${origin}/api/sessions/${session.sessionId}/evidence`, {
    method: "POST", headers: { authorization: `Bearer ${departed.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ mediaType: "image/png", dataBase64: Buffer.from("unauthorized upload after departure").toString("base64") })
  });
  assert.equal(departedUpload.status, 403, "departed participants must not append attachment events");

  const upload = await fetch(`${origin}/api/sessions/${session.sessionId}/evidence`, {
    method: "POST", headers: organizerHeaders,
    body: JSON.stringify({ mediaType: "image/png", dataBase64: Buffer.from("export round-trip evidence").toString("base64") })
  });
  assert.equal(upload.status, 201);
  const exported = await fetch(`${origin}/api/sessions/${session.sessionId}/export`, { headers: organizerHeaders });
  assert.equal(exported.status, 200);
  const bundle = await exported.json();
  assert.equal(bundle.evidence.length, 1);
  assert.deepEqual(verifyEvidencePackage(bundle), { valid: true, problems: [], sessionId: session.sessionId, eventCount: bundle.events.length, evidenceCount: 1 });

  // Two independent clients: the browser store must include an intervening
  // committed event instead of reconstructing state from its stale snapshot.
  const nativeFetch = globalThis.fetch;
  const globals = { localStorage: globalThis.localStorage, location: globalThis.location, history: globalThis.history, BroadcastChannel: globalThis.BroadcastChannel };
  const stored = new Map([["the-black-ledger.session.v1", session.sessionId], ["the-black-ledger.access.v1", session.accessToken]]);
  globalThis.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  globalThis.location = { hash: "", pathname: "/", search: "" };
  globalThis.history = { replaceState() {} };
  globalThis.BroadcastChannel = class { postMessage() {} };
  globalThis.fetch = (url, options) => nativeFetch(new URL(url, origin), options);
  try {
    const store = await import("../src/store.js");
    const stale = await store.loadLedger();
    const concurrentId = randomUUID();
    const concurrent = await addEvent(session.accessToken, { id: concurrentId, at: timestamp(), type: "EXPENSE_RECORDED", description: "Other client's purchase", payerId: attacker.memberId, currency: "USD", amountMinor: 100, allocations: [{ memberId: attacker.memberId, cents: 100 }] });
    assert.equal(concurrent.status, 201);
    const refreshed = await store.appendEvent(stale, "EXPENSE_RECORDED", { description: "This client's purchase", payerId: attacker.memberId, currency: "USD", amountMinor: 100, allocations: [{ memberId: attacker.memberId, cents: 100 }] });
    assert.equal(refreshed.some((item) => item.id === concurrentId), true, "a successful append must refresh intervening events from shared storage");
    globalThis.fetch = (url, options) => options?.method === "POST" ? nativeFetch(new URL(url, origin), options) : Promise.reject(new Error("Temporary connection loss"));
    await assert.rejects(store.appendEvent(refreshed, "EXPENSE_RECORDED", { description: "Saved despite refresh failure", payerId: attacker.memberId, currency: "USD", amountMinor: 100, allocations: [{ memberId: attacker.memberId, cents: 100 }] }), (error) => error.recorded === true && error.message.includes("entry was saved"));
    const recovered = await (await nativeFetch(`${origin}/api/sessions/${session.sessionId}`, { headers: organizerHeaders })).json();
    assert.equal(recovered.events.filter((item) => item.description === "Saved despite refresh failure").length, 1);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(globals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }

});
