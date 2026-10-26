import path from "node:path";

export const CONTRACT_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const FIXTURE_ROOT = path.join(CONTRACT_ROOT, "v1", "corpus");
export const GENERATED_MANIFEST = path.join(
  CONTRACT_ROOT,
  "tools",
  "generated-artifacts.json",
);
