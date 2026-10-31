import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";

// A photo is evidence of something that happened; reading it is a convenience.
// It has to survive an unavailable reader, carry a note of its own, and be
// viewable by the participants without the token ever entering a URL.
test("a photo is kept and viewable whether or not it can be read", async (t) => {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-photo-"));
  // No OPENAI_API_KEY, so the reader is unavailable: the case that used to
  // discard the photo entirely.
  const child = spawn(process.execPath, ["--experimental-sqlite", "src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LEDGER_DATA_DIR: dir, OPENAI_API_KEY: "" },
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

  const session = await (await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Photo notes", baseCurrency: "ARS" }) })).json();
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };

  // A 1x1 PNG stands in for a photo of a sign.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const attach = (body) => fetch(`${origin}/api/sessions/${session.sessionId}/evidence`, { method: "POST", headers, body: JSON.stringify(body) });

  const attached = await attach({ mediaType: "image/png", dataBase64: png.toString("base64"), note: "nueces, quiero comprar, referencia" });
  assert.equal(attached.status, 201, await attached.clone().text());
  const evidence = await attached.json();
  assert.equal(evidence.event.type, "EVIDENCE_ATTACHED");
  assert.equal(evidence.event.note, "nueces, quiero comprar, referencia", "the note must travel with the event");
  assert.equal(evidence.sha256, createHash("sha256").update(png).digest("hex"));

  // The note is a plain photo record: it must not have moved any money.
  const state = await (await fetch(`${origin}/api/sessions/${session.sessionId}`, { headers })).json();
  assert.equal(state.events.filter((item) => item.type === "EVIDENCE_ATTACHED").length, 1);
  assert.deepEqual(state.state.expenses, [], "a photo with a note is not an expense");
  assert.equal(state.state.totalExpensesMinor, 0);

  // The same bytes attached again are deduplicated onto the existing record
  // rather than stored twice.
  const again = await attach({ mediaType: "image/png", dataBase64: png.toString("base64"), note: "a different note" });
  assert.equal(again.status, 200, await again.clone().text());
  const repeat = await again.json();
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.id, evidence.id, "identical bytes must reuse the stored photo");

  // It can be fetched back, by a participant and by a read-only witness.
  const invite = async (role) => (await (await fetch(`${origin}/api/sessions/${session.sessionId}/invitations`, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ role, name: role }) })).json());
  const member = await invite("member"); const witness = await invite("witness");
  for (const [label, token] of [["organizer", session.accessToken], ["member", member.accessToken], ["witness", witness.accessToken]]) {
    const view = await fetch(`${origin}/api/sessions/${session.sessionId}/evidence/${evidence.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(view.status, 200, `${label} must be able to see the photo`);
    assert.equal(view.headers.get("content-type"), "image/png", label);
    assert.equal(view.headers.get("x-content-type-options"), "nosniff", label);
    assert.match(view.headers.get("content-security-policy") ?? "", /default-src 'none'/, label);
    assert.equal(Buffer.from(await view.arrayBuffer()).equals(png), true, `${label} must get the original bytes`);
  }

  // Without a token, and from another session, it stays closed.
  assert.equal((await fetch(`${origin}/api/sessions/${session.sessionId}/evidence/${evidence.id}`)).status, 401);
  const other = await (await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Other", baseCurrency: "ARS" }) })).json();
  assert.equal((await fetch(`${origin}/api/sessions/${other.sessionId}/evidence/${evidence.id}`, { headers: { authorization: `Bearer ${other.accessToken}` } })).status, 404, "evidence must not cross sessions");

  // Only real image types may be stored, because they are served from this origin.
  for (const mediaType of ["text/html", "image/svg+xml", "application/javascript", ""]) {
    const rejected = await attach({ mediaType, dataBase64: Buffer.from("<script>alert(1)</script>").toString("base64") });
    assert.equal(rejected.status, 415, `${mediaType || "(empty)"} must be refused`);
  }

  // A note longer than the domain allows is bounded at the boundary, so the
  // event that reaches the hash chain is always one the validator accepts.
  const distinct = Buffer.concat([png, Buffer.from("\n")]);
  const longNote = await attach({ mediaType: "image/png", dataBase64: distinct.toString("base64"), note: "x".repeat(600) });
  assert.equal(longNote.status, 201, await longNote.clone().text());
  assert.equal((await longNote.json()).event.note.length, 240, "the note must be bounded, not rejected or overlong");
});
