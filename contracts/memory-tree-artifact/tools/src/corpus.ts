import { canonicalManifest, type ArchiveEntry } from "./archive.js";

export interface CorpusCaseDefinition {
  file: string;
  description: string;
  expected: "valid" | "invalid";
  expectedCode: string | null;
  entries: ArchiveEntry[];
  includeEntryDetails?: boolean;
}

const file = (path: string, body: string | Buffer): ArchiveEntry => ({
  path,
  kind: "file",
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
});
const directory = (path: string): ArchiveEntry => ({ path, kind: "directory" });

function paxRecord(key: string, value: string): Buffer {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 3;
  for (;;) {
    const record = `${length} ${payload}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record);
    length = actual;
  }
}

const minimal = (): ArchiveEntry[] => [
  file("manifest.json", canonicalManifest),
  directory("memory/"),
  file("memory/MEMORY.md", "# Memory\n"),
  directory("memory/topics/"),
];

const fixture = (
  fileName: string,
  description: string,
  expected: "valid" | "invalid",
  expectedCode: string | null,
  entries: ArchiveEntry[],
  includeEntryDetails = true,
): CorpusCaseDefinition => ({
  file: fileName,
  description,
  expected,
  expectedCode,
  entries,
  includeEntryDetails,
});

export function corpusCaseDefinitions(): CorpusCaseDefinition[] {
  return [
    fixture(
      "valid-minimal.tar.zst",
      "The smallest valid memory tree.",
      "valid",
      null,
      minimal(),
    ),
    fixture(
      "valid-topics.tar.zst",
      "A valid memory tree with nested and top-level topic files.",
      "valid",
      null,
      [
        ...minimal(),
        directory("memory/topics/security/"),
        file(
          "memory/topics/security/authentication.md",
          "# Authentication\n\nUse explicit trust boundaries.\n",
        ),
        file("memory/topics/testing.md", "# Testing\n"),
      ],
    ),
    fixture(
      "valid-byte-order.tar.zst",
      "Valid UTF-8 bytewise ordering across uppercase, lowercase, and non-ASCII paths.",
      "valid",
      null,
      [
        ...minimal(),
        file("memory/topics/Z.md", "# Uppercase\n"),
        file("memory/topics/a.md", "# Lowercase\n"),
        file("memory/topics/z.md", "# ASCII boundary\n"),
        file("memory/topics/\u00e9.md", "# Non-ASCII\n"),
      ],
    ),
    fixture(
      "invalid-byte-order.tar.zst",
      "Locale-style lowercase-before-uppercase ordering violates UTF-8 bytewise order.",
      "invalid",
      "INVALID_ORDER",
      [
        ...minimal(),
        file("memory/topics/a.md", "# Lowercase\n"),
        file("memory/topics/Z.md", "# Uppercase\n"),
      ],
    ),
    fixture(
      "invalid-missing-index.tar.zst",
      "The required memory/MEMORY.md file is absent.",
      "invalid",
      "MISSING_REQUIRED_PATH",
      minimal().filter((entry) => entry.path !== "memory/MEMORY.md"),
    ),
    fixture(
      "invalid-bad-manifest.tar.zst",
      "The manifest declares an unsupported contract version.",
      "invalid",
      "INVALID_MANIFEST",
      [file("manifest.json", '{"version":2}\n'), ...minimal().slice(1)],
    ),
    fixture(
      "invalid-traversal.tar.zst",
      "A topic path contains a parent-directory traversal segment.",
      "invalid",
      "INVALID_PATH",
      [...minimal(), file("memory/topics/../escape.md", "# Escape\n")],
    ),
    fixture(
      "invalid-symlink.tar.zst",
      "The archive contains a symbolic link.",
      "invalid",
      "UNSUPPORTED_TYPE",
      [
        ...minimal(),
        {
          path: "memory/topics/link.md",
          kind: "symlink",
          linkPath: "../../outside",
        },
      ],
    ),
    fixture(
      "invalid-unexpected-path.tar.zst",
      "A non-Markdown file appears directly below memory/.",
      "invalid",
      "UNEXPECTED_PATH",
      [...minimal(), file("memory/private.txt", "not markdown\n")],
    ),
    fixture(
      "invalid-unexpected-type.tar.zst",
      "The archive contains a character-device entry.",
      "invalid",
      "UNSUPPORTED_TYPE",
      [
        ...minimal(),
        { path: "memory/topics/device.md", kind: "character-device" },
      ],
    ),
    fixture(
      "valid-pax-path.tar.zst",
      "A local PAX path header carries a topic path that does not fit POSIX ustar fields.",
      "valid",
      null,
      [
        ...minimal(),
        {
          path: "PaxHeaders/topic.md",
          kind: "pax-header",
          body: paxRecord("path", `memory/topics/${"a".repeat(101)}.md`),
        },
        file("memory/topics/topic.md", "# Topic\n"),
      ],
    ),
    fixture(
      "invalid-pax-key.tar.zst",
      "A local PAX header uses an unsupported metadata key.",
      "invalid",
      "UNSUPPORTED_PAX",
      [
        ...minimal(),
        {
          path: "PaxHeaders/topic.md",
          kind: "pax-header",
          body: paxRecord("mtime", "1"),
        },
        file("memory/topics/topic.md", "# Topic\n"),
      ],
    ),
    fixture(
      "invalid-too-many-entries.tar.zst",
      "The archive exceeds the 10,000-entry limit using otherwise valid topic directories.",
      "invalid",
      "TOO_MANY_ENTRIES",
      [
        ...minimal(),
        ...Array.from({ length: 9_997 }, (_, index) =>
          directory(
            `memory/topics/group-${index.toString().padStart(4, "0")}/`,
          ),
        ),
      ],
      false,
    ),
  ];
}
