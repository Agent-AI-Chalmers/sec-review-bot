import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("shared corpus manifest covers every encoded archive", () => {
  const corpus = path.resolve(import.meta.dirname, "../v1/corpus");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpus, "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.corpus.map((item) => item.file).sort(),
    fs
      .readdirSync(corpus)
      .filter((name) => name.endsWith(".tar.zst"))
      .sort(),
  );
});

test("generated artifact manifest covers the envelope corpus", () => {
  const toolRoot = import.meta.dirname;
  const generated = JSON.parse(
    fs.readFileSync(path.join(toolRoot, "generated-artifacts.json"), "utf8"),
  );
  assert.equal(generated.family, "tar-zstd-artifact/envelope");
  const corpus = path.resolve(toolRoot, "../v1/corpus");
  const expected = fs
    .readdirSync(corpus)
    .map((name) => `contracts/tar-zstd-artifact/envelope/v1/corpus/${name}`)
    .sort();
  assert.deepEqual(generated.generators[0].outputs.toSorted(), expected);
});
