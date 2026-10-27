import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(toolRoot, "..", "v1", "corpus");

test("input-bundle corpus manifest covers every archive", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpusRoot, "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.corpus.map((item) => item.file).sort(),
    fs
      .readdirSync(corpusRoot)
      .filter((name) => name.endsWith(".tar.zst"))
      .sort(),
  );
});

test("generated artifact manifest covers the input-bundle corpus", () => {
  const generated = JSON.parse(
    fs.readFileSync(path.join(toolRoot, "generated-artifacts.json"), "utf8"),
  );
  assert.equal(generated.family, "tar-zstd-artifact/profiles/input-bundle");
  const expected = fs
    .readdirSync(corpusRoot)
    .map(
      (name) =>
        `contracts/tar-zstd-artifact/profiles/input-bundle/v1/corpus/${name}`,
    )
    .sort();
  assert.deepEqual(generated.generators[0].outputs.toSorted(), expected);
});
