export const CANONICALIZATION_VERSION = 1;

function canonicalNode(value) {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical financial records may contain only safe integer numbers.");
    return ["integer", value];
  }
  if (Array.isArray(value)) return ["array", value.map(canonicalNode)];
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return ["object", Object.keys(value).sort().map((key) => [key, canonicalNode(value[key])])];
  }
  throw new Error("Value cannot be represented in the versioned canonical format.");
}

export function canonicalStringify(value) {
  return JSON.stringify({ version: CANONICALIZATION_VERSION, value: canonicalNode(value) });
}
