import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveLedger, SUPPORTED_CURRENCIES } from "./domain.js";
import { canonicalStringify } from "./domain/canonical.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// A package is untrusted input. Invalid structure is a verification failure, not
// an exception callers must catch. Hashes establish consistency, not authorship.
export function verifyEvidencePackage(bundle) {
  const problems = [];
  const result = () => ({ valid: problems.length === 0, problems,
    sessionId: typeof bundle?.sessionId === "string" ? bundle.sessionId : null,
    eventCount: Array.isArray(bundle?.events) ? bundle.events.length : 0,
    evidenceCount: Array.isArray(bundle?.evidence) ? bundle.evidence.length : 0 });
  try {
    if (!record(bundle) || bundle.format !== "the-black-ledger-evidence-package" || bundle.version !== 1) {
      problems.push("Unsupported evidence package format."); return result();
    }
    const { packageHash, verification, ...manifest } = bundle;
    if (!digest(packageHash) || sha(canonicalStringify(manifest)) !== packageHash) problems.push("Package content hash does not match.");
    if (typeof bundle.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(bundle.sessionId)) problems.push("Invalid session ID.");
    if (!SUPPORTED_CURRENCIES.includes(bundle.baseCurrency)) problems.push("Invalid base currency.");
    if (![bundle.events, bundle.eventProofs, bundle.evidence, bundle.evidenceData].every(Array.isArray)) {
      problems.push("Events, proofs, evidence metadata and evidence data must be arrays."); return result();
    }
    if (bundle.events.length !== bundle.eventProofs.length) problems.push("Event list and proof list lengths do not match.");
    let previousHash = "";
    for (let i = 0; i < bundle.events.length; i++) {
      const proof = bundle.eventProofs[i];
      const expectedHash = sha(`${previousHash}\n${canonicalStringify(bundle.events[i])}`);
      if (!record(proof) || proof.sequence !== i + 1 || proof.previousHash !== previousHash || proof.contentHash !== expectedHash) problems.push(`Event proof failed at sequence ${i + 1}.`);
      previousHash = expectedHash;
    }
    if (previousHash !== bundle.eventHeadHash) problems.push("Event chain head does not match the manifest.");
    const creation = bundle.events[0];
    if (creation?.type !== "SESSION_CREATED" || creation.sessionId !== bundle.sessionId || creation.baseCurrency !== bundle.baseCurrency) problems.push("Session creation does not match the manifest.");
    try { deriveLedger(bundle.events, { baseCurrency: bundle.baseCurrency }); }
    catch (error) { problems.push(`Ledger history is invalid: ${error.message}`); }

    const metadata = new Map();
    for (const item of bundle.evidence) {
      if (!record(item) || typeof item.id !== "string" || !item.id || !digest(item.sha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 8_000_000 || typeof item.mediaType !== "string" || !item.mediaType) {
        problems.push("Invalid evidence metadata."); continue;
      }
      if (metadata.has(item.id)) problems.push(`Evidence metadata ID is duplicated: ${item.id}.`);
      metadata.set(item.id, item);
    }
    const dataIds = new Set();
    for (const data of bundle.evidenceData) {
      if (!record(data) || typeof data.id !== "string" || typeof data.dataBase64 !== "string") {
        problems.push("Invalid evidence data."); continue;
      }
      if (dataIds.has(data.id)) problems.push(`Evidence data ID is duplicated: ${data.id}.`);
      dataIds.add(data.id);
      const item = metadata.get(data.id);
      if (!item) { problems.push(`Unexpected evidence data: ${data.id}.`); continue; }
      const content = Buffer.from(data.dataBase64, "base64");
      if (content.toString("base64") !== data.dataBase64) problems.push(`Evidence encoding is not canonical base64: ${data.id}.`);
      if (content.length !== item.byteLength || sha(content) !== item.sha256 || data.sha256 !== item.sha256 || data.byteLength !== item.byteLength || data.mediaType !== item.mediaType) problems.push(`Evidence digest or metadata failed for ${data.id}.`);
    }
    for (const id of metadata.keys()) if (!dataIds.has(id)) problems.push(`Evidence data is missing for ${id}.`);
    const attached = new Set();
    for (const event of bundle.events) {
      if (event?.type !== "EVIDENCE_ATTACHED") continue;
      attached.add(event.evidenceId);
      const item = metadata.get(event.evidenceId);
      if (!item || event.contentHash !== item.sha256 || event.byteLength !== item.byteLength || event.mediaType !== item.mediaType) problems.push(`Evidence attachment does not match history: ${event.evidenceId}.`);
    }
    for (const id of metadata.keys()) if (!attached.has(id)) problems.push(`Evidence has no attachment event: ${id}.`);
  } catch (error) { problems.push(`Malformed evidence package: ${error.message}`); }
  return result();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error("Usage: node src/verify-package.js <evidence-package.json>"); process.exitCode = 2; }
  else {
    try {
      const result = verifyEvidencePackage(JSON.parse(await readFile(file, "utf8")));
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = 1;
    } catch (error) { console.error(`Could not verify package: ${error.message}`); process.exitCode = 2; }
  }
}
