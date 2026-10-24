import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "./domain/canonical.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

export function verifyEvidencePackage(bundle) {
  const problems = [];
  if (!bundle || bundle.format !== "the-black-ledger-evidence-package" || bundle.version !== 1) return { valid: false, problems: ["Unsupported evidence package format."] };
  const { packageHash, verification, ...manifest } = bundle;
  if (sha(canonicalStringify(manifest)) !== packageHash) problems.push("Package content hash does not match.");
  if (!Array.isArray(bundle.events) || !Array.isArray(bundle.eventProofs) || bundle.events.length !== bundle.eventProofs.length) problems.push("Event list and proof list lengths do not match.");
  else {
    let previousHash = "";
    for (let i = 0; i < bundle.events.length; i++) {
      const proof = bundle.eventProofs[i];
      const expectedHash = sha(`${previousHash}\n${canonicalStringify(bundle.events[i])}`);
      if (proof.sequence !== i + 1 || proof.previousHash !== previousHash || proof.contentHash !== expectedHash) problems.push(`Event proof failed at sequence ${i + 1}.`);
      previousHash = proof.contentHash;
    }
    if (previousHash !== bundle.eventHeadHash) problems.push("Event chain head does not match the manifest.");
  }
  const dataById = new Map((bundle.evidenceData ?? []).map((item) => [item.id, item]));
  if (dataById.size !== (bundle.evidenceData ?? []).length) problems.push("Evidence IDs are duplicated.");
  for (const evidence of bundle.evidence ?? []) {
    const data = dataById.get(evidence.id);
    if (!data) { problems.push(`Evidence data is missing for ${evidence.id}.`); continue; }
    const content = Buffer.from(data.dataBase64, "base64");
    if (content.length !== evidence.byteLength || sha(content) !== evidence.sha256 || data.sha256 !== evidence.sha256) problems.push(`Evidence digest failed for ${evidence.id}.`);
  }
  if ((bundle.evidenceData ?? []).length !== (bundle.evidence ?? []).length) problems.push("Evidence data and metadata counts do not match.");
  return { valid: problems.length === 0, problems, sessionId: bundle.sessionId, eventCount: bundle.events?.length ?? 0, evidenceCount: bundle.evidence?.length ?? 0 };
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
