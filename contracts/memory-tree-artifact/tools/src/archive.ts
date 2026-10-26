import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const MEDIA_TYPE = "application/tar+zstd" as const;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

const BLOCK_SIZE = 512;
const CANONICAL_MANIFEST = Buffer.from('{"version":1}\n');
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type EntryKind =
  "file" | "directory" | "symlink" | "character-device" | "pax-header";

export interface ArchiveEntry {
  path: string;
  kind: EntryKind;
  body?: Buffer;
  linkPath?: string;
  mode?: number;
}

export interface ValidationResult {
  valid: boolean;
  code: string | null;
  entryCount: number;
  extractedBytes: number;
}

interface ParsedEntry {
  path: string;
  typeFlag: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  uname: string;
  gname: string;
  body: Buffer;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  writeString(target, offset, length, encoded);
}

function splitUstarPath(entryPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(entryPath) <= 100)
    return { name: entryPath, prefix: "" };
  for (
    let index = entryPath.lastIndexOf("/");
    index > 0;
    index = entryPath.lastIndexOf("/", index - 1)
  ) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path does not fit ustar fields: ${entryPath}`);
}

function tarHeader(entry: ArchiveEntry): Buffer {
  const body = entry.body ?? Buffer.alloc(0);
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitUstarPath(entry.path);
  const isDirectory = entry.kind === "directory";
  const typeFlag =
    entry.kind === "file"
      ? "0"
      : entry.kind === "directory"
        ? "5"
        : entry.kind === "symlink"
          ? "2"
          : entry.kind === "character-device"
            ? "3"
            : "x";

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode ?? (isDirectory ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(
    header,
    124,
    12,
    entry.kind === "file" || entry.kind === "pax-header" ? body.length : 0,
  );
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, typeFlag);
  if (entry.linkPath !== undefined)
    writeString(header, 157, 100, entry.linkPath);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

export function buildArchive(entries: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body =
      entry.kind === "file" || entry.kind === "pax-header"
        ? (entry.body ?? Buffer.alloc(0))
        : Buffer.alloc(0);
    blocks.push(tarHeader(entry), body);
    const padding = (BLOCK_SIZE - (body.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return zstdCompressSync(Buffer.concat(blocks));
}

function readString(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  const boundedEnd =
    end === -1 || end > offset + length ? offset + length : end;
  return block.subarray(offset, boundedEnd).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const value = readString(block, offset, length).trim();
  if (!/^[0-7]+$/.test(value))
    throw new ArchiveError("INVALID_TAR", "invalid octal field");
  return Number.parseInt(value, 8);
}

function parsePaxPath(body: Buffer): string {
  let position = 0;
  let path: string | undefined;
  while (position < body.length) {
    const space = body.indexOf(0x20, position);
    if (space < 0)
      throw new ArchiveError("INVALID_PAX", "missing record length");
    const lengthText = body.subarray(position, space).toString("ascii");
    if (!/^\d+$/.test(lengthText))
      throw new ArchiveError("INVALID_PAX", "invalid record length");
    const end = position + Number.parseInt(lengthText, 10);
    if (end > body.length || body[end - 1] !== 0x0a)
      throw new ArchiveError("INVALID_PAX", "invalid record boundary");
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (
      equals < 0 ||
      record.subarray(0, equals).toString("ascii") !== "path" ||
      path !== undefined
    )
      throw new ArchiveError("UNSUPPORTED_PAX", "unsupported PAX metadata");
    path = UTF8_DECODER.decode(record.subarray(equals + 1));
    position = end;
  }
  if (path === undefined)
    throw new ArchiveError("INVALID_PAX", "PAX header has no path");
  return path;
}

class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseTar(tar: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let pendingPath: string | undefined;
  let offset = 0;
  let foundTerminator = false;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      if (
        offset + BLOCK_SIZE > tar.length ||
        !tar.subarray(offset, offset + BLOCK_SIZE).every((byte) => byte === 0)
      ) {
        throw new ArchiveError(
          "INVALID_TAR",
          "tar requires two zero terminator blocks",
        );
      }
      offset += BLOCK_SIZE;
      foundTerminator = true;
      break;
    }
    if (readString(header, 257, 6) !== "ustar")
      throw new ArchiveError("INVALID_TAR", "entry is not ustar");
    const storedChecksum = readOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    if (
      checksumHeader.reduce((total, byte) => total + byte, 0) !== storedChecksum
    ) {
      throw new ArchiveError("INVALID_TAR", "header checksum mismatch");
    }
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (offset + paddedSize > tar.length)
      throw new ArchiveError("INVALID_TAR", "truncated entry body");
    const typeFlag = readString(header, 156, 1) || "0";
    const body = tar.subarray(offset, offset + size);
    offset += paddedSize;
    if (["g", "L", "K", "S"].includes(typeFlag))
      throw new ArchiveError("UNSUPPORTED_PAX", "unsupported tar extension");
    if (typeFlag === "x") {
      if (pendingPath !== undefined)
        throw new ArchiveError("INVALID_PAX", "consecutive PAX headers");
      pendingPath = parsePaxPath(body);
      continue;
    }
    entries.push({
      path: pendingPath ?? entryPath,
      typeFlag,
      mode: readOctal(header, 100, 8),
      uid: readOctal(header, 108, 8),
      gid: readOctal(header, 116, 8),
      size,
      mtime: readOctal(header, 136, 12),
      uname: readString(header, 265, 32),
      gname: readString(header, 297, 32),
      body,
    });
    pendingPath = undefined;
  }
  if (pendingPath !== undefined)
    throw new ArchiveError("INVALID_PAX", "orphan PAX header");
  if (!foundTerminator || tar.subarray(offset).some((byte) => byte !== 0)) {
    throw new ArchiveError(
      "INVALID_TAR",
      "missing terminator or non-zero trailing bytes",
    );
  }
  return entries;
}

function canonicalPath(entry: ParsedEntry): boolean {
  const isDirectory = entry.typeFlag === "5";
  if (
    entry.path.includes("\\") ||
    entry.path.includes("\0") ||
    entry.path.startsWith("/")
  )
    return false;
  if (isDirectory ? !entry.path.endsWith("/") : entry.path.endsWith("/"))
    return false;
  const withoutTrailingSlash = isDirectory
    ? entry.path.slice(0, -1)
    : entry.path;
  const segments = withoutTrailingSlash.split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
}

function allowedPath(entry: ParsedEntry): boolean {
  if (entry.path === "manifest.json") return entry.typeFlag === "0";
  if (entry.path === "memory/" || entry.path === "memory/topics/")
    return entry.typeFlag === "5";
  if (entry.path === "memory/MEMORY.md") return entry.typeFlag === "0";
  if (!entry.path.startsWith("memory/topics/")) return false;
  if (entry.typeFlag === "5") return true;
  return entry.typeFlag === "0" && entry.path.endsWith(".md");
}

function validateEntries(entries: ParsedEntry[]): ValidationResult {
  if (entries.length > MAX_ENTRIES)
    throw new ArchiveError("TOO_MANY_ENTRIES", "entry count exceeds limit");
  if (entries.length === 0 || entries[0]?.path !== "manifest.json") {
    throw new ArchiveError("MANIFEST_NOT_FIRST", "manifest.json must be first");
  }
  const paths = new Set<string>();
  let extractedBytes = 0;
  for (const entry of entries) {
    if (paths.has(entry.path))
      throw new ArchiveError("DUPLICATE_PATH", `duplicate path ${entry.path}`);
    paths.add(entry.path);
    if (!canonicalPath(entry))
      throw new ArchiveError(
        "INVALID_PATH",
        `non-canonical path ${entry.path}`,
      );
    if (entry.typeFlag !== "0" && entry.typeFlag !== "5") {
      throw new ArchiveError(
        "UNSUPPORTED_TYPE",
        `unsupported type for ${entry.path}`,
      );
    }
    if (!allowedPath(entry))
      throw new ArchiveError(
        "UNEXPECTED_PATH",
        `unexpected path ${entry.path}`,
      );
    const directory = entry.typeFlag === "5";
    if (
      entry.uid !== 0 ||
      entry.gid !== 0 ||
      entry.mtime !== 0 ||
      entry.uname !== "" ||
      entry.gname !== ""
    ) {
      throw new ArchiveError(
        "NON_CANONICAL_METADATA",
        `non-canonical owner or time for ${entry.path}`,
      );
    }
    if (
      entry.mode !== (directory ? 0o755 : 0o644) ||
      (directory && entry.size !== 0)
    ) {
      throw new ArchiveError(
        "NON_CANONICAL_METADATA",
        `non-canonical mode or size for ${entry.path}`,
      );
    }
    if (!directory) {
      if (entry.size > MAX_FILE_BYTES)
        throw new ArchiveError("FILE_TOO_LARGE", `${entry.path} exceeds limit`);
      extractedBytes += entry.size;
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new ArchiveError(
          "EXTRACTED_TOO_LARGE",
          "extracted bytes exceed limit",
        );
      }
      try {
        UTF8_DECODER.decode(entry.body);
      } catch {
        throw new ArchiveError("INVALID_UTF8", `${entry.path} is not UTF-8`);
      }
    }
  }
  for (const required of [
    "manifest.json",
    "memory/",
    "memory/MEMORY.md",
    "memory/topics/",
  ]) {
    if (!paths.has(required))
      throw new ArchiveError("MISSING_REQUIRED_PATH", `missing ${required}`);
  }
  if (!entries[0]?.body.equals(CANONICAL_MANIFEST)) {
    throw new ArchiveError(
      "INVALID_MANIFEST",
      "manifest bytes are not canonical v1 JSON",
    );
  }
  const remainingPaths = entries.slice(1).map((entry) => entry.path);
  const sortedPaths = [...remainingPaths].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    remainingPaths.some((entryPath, index) => entryPath !== sortedPaths[index])
  ) {
    throw new ArchiveError("INVALID_ORDER", "entries are not in lexical order");
  }
  return {
    valid: true,
    code: null,
    entryCount: entries.length,
    extractedBytes,
  };
}

export function validateArchive(archive: Buffer): ValidationResult {
  try {
    if (archive.length > MAX_ARCHIVE_BYTES)
      throw new ArchiveError("ARCHIVE_TOO_LARGE", "archive exceeds limit");
    return validateEntries(parseTar(zstdDecompressSync(archive)));
  } catch (error) {
    if (error instanceof ArchiveError)
      return {
        valid: false,
        code: error.code,
        entryCount: 0,
        extractedBytes: 0,
      };
    return {
      valid: false,
      code: "INVALID_ZSTD",
      entryCount: 0,
      extractedBytes: 0,
    };
  }
}

export const canonicalManifest = CANONICAL_MANIFEST;
