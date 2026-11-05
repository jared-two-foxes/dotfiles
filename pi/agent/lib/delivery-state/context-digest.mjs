import { createHash } from "node:crypto";
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
