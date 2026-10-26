import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { MEDIA_TYPE, sha256, validateArchive } from "../src/archive.js";
import { FIXTURE_ROOT, CONTRACT_ROOT } from "../src/paths.js";

interface FixtureRecord {
  file: string;
  description: string;
  mediaType: string;
  sha256: string;
  size: number;
  expected: "valid" | "invalid";
  expectedCode: string | null;
  objectKey: string;
  entryCount: number;
  entries?: Array<{ path: string; kind: string; sizeBytes: number }>;
}

const corpusManifest = JSON.parse(
  readFileSync(path.join(FIXTURE_ROOT, "manifest.json"), "utf8"),
) as {
  corpus: FixtureRecord[];
};

test("the archive manifest schema accepts only the exact v1 object", () => {
  const schema = JSON.parse(
    readFileSync(
      path.join(CONTRACT_ROOT, "v1", "manifest.schema.json"),
      "utf8",
    ),
  ) as object;
  const validate = new Ajv2020({ strict: true }).compile(schema);

  assert.equal(validate({ version: 1 }), true);
  assert.equal(validate({ version: 2 }), false);
  assert.equal(validate({ version: 1, extra: true }), false);
  assert.equal(validate({}), false);
});

test("the fixture manifest covers every committed archive exactly once", () => {
  const archiveFiles = readdirSync(FIXTURE_ROOT)
    .filter((file) => file.endsWith(".tar.zst"))
    .sort();
  const declaredFiles = corpusManifest.corpus.map(({ file }) => file).sort();

  assert.deepEqual(declaredFiles, archiveFiles);
  assert.equal(new Set(declaredFiles).size, declaredFiles.length);
});

for (const fixture of corpusManifest.corpus) {
  test(`${fixture.file} matches its bytes and expected validation result`, () => {
    const archive = readFileSync(path.join(FIXTURE_ROOT, fixture.file));
    const digest = sha256(archive);
    const result = validateArchive(archive);

    assert.equal(fixture.mediaType, MEDIA_TYPE);
    assert.ok(fixture.description.length > 0);
    assert.ok(fixture.entryCount > 0);
    if (fixture.entries !== undefined)
      assert.equal(fixture.entries.length, fixture.entryCount);
    assert.equal(fixture.size, archive.length);
    assert.equal(fixture.sha256, digest);
    assert.equal(
      fixture.objectKey,
      `memory/trees/${digest}/memory-tree.v1.tar.zst`,
    );
    assert.equal(result.valid, fixture.expected === "valid");
    assert.equal(result.code, fixture.expectedCode);
  });
}
