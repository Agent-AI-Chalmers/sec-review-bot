import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import generatedArtifacts from "../generated-artifacts.json" with { type: "json" };
import { corpusCaseDefinitions } from "../src/corpus.js";

test("the generated artifact manifest exactly covers fixture outputs", () => {
  const expected = [
    "../v1/corpus/manifest.json",
    ...corpusCaseDefinitions().map(({ file }) => `../v1/corpus/${file}`),
  ];
  assert.deepEqual(generatedArtifacts.artifacts, expected);
});

test("every generated artifact identifies an existing committed file", () => {
  for (const artifact of generatedArtifacts.artifacts) {
    assert.doesNotThrow(() =>
      readFileSync(path.resolve(import.meta.dirname, "..", artifact)),
    );
  }
});
