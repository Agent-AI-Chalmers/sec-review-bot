import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import generatedArtifacts from "../generated-artifacts.json" with { type: "json" };
import { generateCorpus } from "./generate.js";
import { CONTRACT_ROOT } from "./paths.js";

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "memory-tree-artifact-"));
try {
  generateCorpus(temporaryRoot);
  for (const artifact of generatedArtifacts.artifacts) {
    const committed = path.resolve(CONTRACT_ROOT, "tools", artifact);
    const generated = path.join(temporaryRoot, path.basename(artifact));
    if (!readFileSync(committed).equals(readFileSync(generated))) {
      throw new Error(`generated artifact is stale: ${artifact}`);
    }
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
