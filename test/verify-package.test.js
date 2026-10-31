import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalStringify } from "../src/domain/canonical.js";
import { verifyEvidencePackage } from "../src/verify-package.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function seal(bundle) {
  let previousHash = "";
  bundle.eventProofs = bundle.events.map((event, i) => {
    const contentHash = hash(`${previousHash}\n${canonicalStringify(event)}`);
    const proof = { sequence: i + 1, previousHash, contentHash };
    previousHash = contentHash; return proof;
  });
  bundle.eventHeadHash = previousHash;
  const { packageHash, verification, ...manifest } = bundle;
  bundle.packageHash = hash(canonicalStringify(manifest)); return bundle;
}
function fixture() {
  const bytes = Buffer.from("receipt bytes");
  const item = { id: "receipt1", sha256: hash(bytes), mediaType: "image/png", byteLength: bytes.length };
  return seal({ format: "the-black-ledger-evidence-package", version: 1, sessionId: "session1", baseCurrency: "USD",
    events: [
      { id: "created", at: "2026-10-30T00:00:00.000Z", type: "SESSION_CREATED", sessionId: "session1", name: "Trip", baseCurrency: "USD" },
      { id: "attached", at: "2026-10-30T00:00:01.000Z", type: "EVIDENCE_ATTACHED", evidenceId: item.id, contentHash: item.sha256, mediaType: item.mediaType, byteLength: item.byteLength }
    ], evidence: [item], evidenceData: [{ ...item, dataBase64: bytes.toString("base64") }] });
}

test("verifies complete and attachment-free exports without mutating input", () => {
  const bundle = fixture(); const before = structuredClone(bundle);
  assert.equal(verifyEvidencePackage(bundle).valid, true);
  assert.deepEqual(bundle, before);
  bundle.events.pop(); bundle.evidence = []; bundle.evidenceData = [];
  assert.equal(verifyEvidencePackage(seal(bundle)).valid, true);
});

test("malformed JSON values return a failure without throwing", () => {
  for (const value of [null, [], 1, "bad", {}, ...["events", "eventProofs", "evidence", "evidenceData"].flatMap((field) => [null, {}, "bad"].map((value) => ({ ...fixture(), [field]: value })))]) {
    assert.equal(verifyEvidencePackage(value).valid, false);
  }
  for (const field of ["eventProofs", "evidence", "evidenceData"]) {
    const bundle = fixture(); bundle[field][0] = null;
    assert.equal(verifyEvidencePackage(bundle).valid, false);
  }
});

const mutations = {
  "event bytes changed": (b) => { b.events[0].name = "Forged"; },
  "proof removed": (b) => { b.eventProofs.pop(); },
  "proof predecessor changed": (b) => { b.eventProofs[1].previousHash = "a".repeat(64); },
  "head changed": (b) => { b.eventHeadHash = "b".repeat(64); },
  "session identity changed and rehashed": (b) => { b.sessionId = "other"; seal(b); },
  "currency changed and rehashed": (b) => { b.baseCurrency = "EUR"; seal(b); },
  "empty history rehashed": (b) => { b.events = []; seal(b); },
  "invalid domain history rehashed": (b) => { b.events.push({ id: "joined", at: "2026-10-30T00:00:02.000Z", type: "MEMBER_STATUS_CHANGED", memberId: "missing", status: "departed" }); seal(b); },
  "metadata duplicated and rehashed": (b) => { b.evidence.push(b.evidence[0]); seal(b); },
  "data duplicated and rehashed": (b) => { b.evidenceData.push(b.evidenceData[0]); seal(b); },
  "attachment removed and rehashed": (b) => { b.events.pop(); seal(b); },
  "evidence removed and rehashed": (b) => { b.evidence = []; b.evidenceData = []; seal(b); },
  "data removed and rehashed": (b) => { b.evidenceData = []; seal(b); },
  "bytes changed and rehashed": (b) => { b.evidenceData[0].dataBase64 = Buffer.from("different").toString("base64"); seal(b); },
  "permissive base64 and rehashed": (b) => { b.evidenceData[0].dataBase64 += "!!"; seal(b); },
  "data metadata changed and rehashed": (b) => { b.evidenceData[0].mediaType = "image/jpeg"; seal(b); },
  "history digest changed and rehashed": (b) => { b.events[1].contentHash = "c".repeat(64); seal(b); }
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const bundle = fixture(); mutate(bundle);
  assert.equal(verifyEvidencePackage(bundle).valid, false);
});

test("CLI distinguishes valid, invalid and unreadable packages", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-verifier-"));
  try {
    const file = join(dir, "bundle.json");
    writeFileSync(file, JSON.stringify(fixture()));
    const run = (...args) => spawnSync(process.execPath, ["src/verify-package.js", ...args], { encoding: "utf8" });
    assert.equal(run(file).status, 0);
    writeFileSync(file, JSON.stringify({ ...fixture(), evidence: null }));
    const invalid = run(file);
    assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).valid, false);
    writeFileSync(file, "{"); assert.equal(run(file).status, 2);
    assert.equal(run().status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
