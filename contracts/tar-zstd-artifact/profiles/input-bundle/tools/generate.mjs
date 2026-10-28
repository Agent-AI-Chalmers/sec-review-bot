import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

const profileRoot = path.resolve(import.meta.dirname, "..");
const corpusRoot = path.join(profileRoot, "v1", "corpus");

function writeOctal(header, offset, length, value) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function rawEntry({
  name,
  type = "0",
  body = Buffer.alloc(0),
  mode = type === "5" ? 0o755 : 0o644,
  mtime = 0,
}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === "0" ? body.length : 0);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const content = type === "0" ? body : Buffer.alloc(0);
  return Buffer.concat([
    header,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
  ]);
}

function json(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

const manifest = (incremental = false) => ({
  api_version: "v1",
  workspace: { snapshot: "workspace.snapshot.tar" },
  history: { path: "history" },
  ...(incremental
    ? { incremental_window: { path: "incremental-window" } }
    : {}),
});

const minimal = () => [
  { name: "manifest.json", body: json(manifest()) },
  { name: "history/", type: "5" },
  { name: "history/review.json", body: json({ kind: "review" }) },
  { name: "workspace.snapshot.tar", body: Buffer.alloc(1024) },
];

function archive(entries) {
  return zstdCompressSync(
    Buffer.concat([...entries.map(rawEntry), Buffer.alloc(1024)]),
  );
}

const definitions = [
  {
    file: "valid-minimal.tar.zst",
    expected: "valid",
    bytes: archive(minimal()),
  },
  {
    file: "valid-incremental.tar.zst",
    expected: "valid",
    bytes: archive([
      { name: "manifest.json", body: json(manifest(true)) },
      { name: "history/", type: "5" },
      { name: "history/review.json", body: json({ kind: "review" }) },
      { name: "incremental-window/", type: "5" },
      {
        name: "incremental-window/changed-files.json",
        body: json({ files: [] }),
      },
      {
        name: "incremental-window/incremental.patch",
        body: Buffer.from(""),
      },
      { name: "workspace.snapshot.tar", body: Buffer.alloc(1024) },
    ]),
  },
  {
    file: "invalid-order.tar.zst",
    expected: "invalid",
    bytes: archive([
      { name: "manifest.json", body: json(manifest()) },
      { name: "workspace.snapshot.tar", body: Buffer.alloc(1024) },
      { name: "history/", type: "5" },
    ]),
  },
  {
    file: "invalid-missing-history.tar.zst",
    expected: "invalid",
    bytes: archive(
      minimal().filter((entry) => !entry.name.startsWith("history/")),
    ),
  },
  {
    file: "invalid-unexpected-path.tar.zst",
    expected: "invalid",
    bytes: archive([
      ...minimal().slice(0, -1),
      { name: "private.json", body: json({ secret: true }) },
      minimal().at(-1),
    ]),
  },
  {
    file: "invalid-symlink.tar.zst",
    expected: "invalid",
    bytes: archive([
      ...minimal().slice(0, -1),
      { name: "history/link", type: "2" },
      minimal().at(-1),
    ]),
  },
];

const manifestValue = {
  corpus: definitions.map(({ file, expected, bytes }) => ({
    file,
    expected,
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
