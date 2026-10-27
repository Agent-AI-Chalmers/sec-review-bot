import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

const profileRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const corpusRoot = path.join(profileRoot, "v1", "corpus");

function writeOctal(header, offset, length, value) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function rawEntry(name, type, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

function paxRecord(value) {
  const payload = `path=${value}\n`;
  let length = Buffer.byteLength(payload) + 3;
  for (;;) {
    const record = Buffer.from(`${length} ${payload}`);
    if (record.length === length) return record;
    length = record.length;
  }
}

function entry(name, type, body = Buffer.alloc(0)) {
  if (Buffer.byteLength(name) <= 100) return [rawEntry(name, type, body)];
  const marker = crypto
    .createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, 24);
  return [
    rawEntry(`PaxHeaders/${marker}`, "x", paxRecord(name)),
    rawEntry(`PaxPath/${marker}`, type, body),
  ];
}

function json(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function manifest(transcripts, overrides = {}) {
  return {
    version: 1,
    run_id: "run-1",
    result: "result.json",
    review_units: [{ id: "unit-1", transcripts }],
    ...overrides,
  };
}

function archive(entries) {
  return zstdCompressSync(
    Buffer.concat([
      ...entries.flatMap((item) => entry(...item)),
      Buffer.alloc(1024),
    ]),
  );
}

const transcript = "artifact-tree/unit-1/review.jsonl";
const longTranscript = `artifact-tree/unit-1/${"a".repeat(110)}.jsonl`;
const nonCanonicalTranscript = "artifact-tree/unit-1/./review.jsonl";
const wrongExtensionTranscript = "artifact-tree/unit-1/review.txt";
const definitions = [
  {
    file: "valid-minimal.tar.zst",
    expected: "valid",
    unitId: "unit-1",
    bytes: archive([
      ["manifest.json", "0", json(manifest([transcript]))],
      ["result.json", "0", json({ status: "completed" })],
      ["artifact-tree/", "5"],
      ["artifact-tree/unit-1/", "5"],
      [transcript, "0", Buffer.from('{"event":"message"}\n')],
    ]),
  },
  {
    file: "valid-pax-path.tar.zst",
    expected: "valid",
    unitId: "unit-1",
    bytes: archive([
      ["manifest.json", "0", json(manifest([longTranscript]))],
      ["result.json", "0", json({ status: "completed" })],
      ["artifact-tree/", "5"],
      ["artifact-tree/unit-1/", "5"],
      [longTranscript, "0", Buffer.from('{"event":"message"}\n')],
    ]),
  },
  {
    file: "invalid-result-reference.tar.zst",
    expected: "invalid",
    unitId: "unit-1",
    bytes: archive([
      [
        "manifest.json",
        "0",
        json(manifest([transcript], { result: "other.json" })),
      ],
      ["result.json", "0", json({})],
      ["artifact-tree/", "5"],
      [transcript, "0", Buffer.from("{}\n")],
    ]),
  },
  {
    file: "invalid-missing-transcript.tar.zst",
    expected: "invalid",
    unitId: "unit-1",
    bytes: archive([
      ["manifest.json", "0", json(manifest([transcript]))],
      ["result.json", "0", json({})],
      ["artifact-tree/", "5"],
    ]),
  },
  {
    file: "invalid-noncanonical-transcript-path.tar.zst",
    expected: "invalid",
    unitId: "unit-1",
    bytes: archive([
      ["manifest.json", "0", json(manifest([nonCanonicalTranscript]))],
      ["result.json", "0", json({})],
      ["artifact-tree/", "5"],
      [transcript, "0", Buffer.from("{}\n")],
    ]),
  },
  {
    file: "invalid-transcript-extension.tar.zst",
    expected: "invalid",
    unitId: "unit-1",
    bytes: archive([
      ["manifest.json", "0", json(manifest([wrongExtensionTranscript]))],
      ["result.json", "0", json({})],
      ["artifact-tree/", "5"],
      [wrongExtensionTranscript, "0", Buffer.from("{}\n")],
    ]),
  },
  {
    file: "invalid-duplicate-unit.tar.zst",
    expected: "invalid",
    unitId: "unit-1",
    bytes: archive([
      [
        "manifest.json",
        "0",
        json(
          manifest([transcript], {
            review_units: [
              { id: "unit-1", transcripts: [transcript] },
              { id: "unit-1", transcripts: [transcript] },
            ],
          }),
        ),
      ],
      ["result.json", "0", json({})],
      ["artifact-tree/", "5"],
      [transcript, "0", Buffer.from("{}\n")],
    ]),
  },
  {
    file: "invalid-symlink.tar.zst",
    expected: "invalid",
    unitId: "unit-1",
    bytes: archive([
      ["manifest.json", "0", json(manifest([transcript]))],
      ["result.json", "0", json({})],
      ["artifact-tree/", "5"],
      [transcript, "2"],
    ]),
  },
];

const manifestValue = {
  corpus: definitions.map(({ file, expected, unitId, bytes }) => ({
    file,
    expected,
    runId: "run-1",
    unitId,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  })),
};
const outputs = new Map(
  definitions.map(({ file, bytes }) => [path.join(corpusRoot, file), bytes]),
);
outputs.set(
  path.join(corpusRoot, "manifest.json"),
  Buffer.from(`${JSON.stringify(manifestValue, null, 2)}\n`),
);

fs.mkdirSync(corpusRoot, { recursive: true });
for (const [target, bytes] of outputs) {
  if (process.argv.includes("--check")) {
    assert.deepEqual(
      fs.readFileSync(target),
      bytes,
      `${path.relative(profileRoot, target)} is stale`,
    );
  } else {
    fs.writeFileSync(target, bytes);
  }
}
