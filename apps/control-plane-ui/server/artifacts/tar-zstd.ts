import { zstdDecompressSync } from 'node:zlib'

const BLOCK_SIZE = 512
const MAX_PAX_HEADER_BYTES = 1024 * 1024
const rejectedExtensionTypes = new Set(['g', 'L', 'K', 'S'])
const utf8 = new TextDecoder('utf-8', { fatal: true })

export interface TarEnvelopeEntry {
  path: string
  typeFlag: string
  size: number
}

function field(block: Buffer, offset: number, length: number): Buffer {
  const value = block.subarray(offset, offset + length)
  const end = value.indexOf(0)
  return end < 0 ? value : value.subarray(0, end)
}

function octal(block: Buffer, offset: number, length: number): number {
  const value = field(block, offset, length).toString('ascii').trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid_tar_zstd_envelope')
  return Number.parseInt(value, 8)
}

function headerPath(block: Buffer): string {
  const name = utf8.decode(field(block, 0, 100))
  const prefix = utf8.decode(field(block, 345, 155))
  return prefix ? `${prefix}/${name}` : name
}

function parsePaxPath(body: Buffer): string {
  let position = 0
  let path: string | undefined
  while (position < body.length) {
    const space = body.indexOf(0x20, position)
    if (space < 0) throw new Error('invalid_tar_zstd_envelope')
    const lengthText = body.subarray(position, space).toString('ascii')
    if (!/^\d+$/.test(lengthText)) throw new Error('invalid_tar_zstd_envelope')
    const length = Number.parseInt(lengthText, 10)
    const end = position + length
    if (
      length <= space - position + 2 ||
      end > body.length ||
      body[end - 1] !== 0x0a
    )
      throw new Error('invalid_tar_zstd_envelope')
    const record = body.subarray(space + 1, end - 1)
    const equals = record.indexOf(0x3d)
    if (
      equals < 0 ||
      record.subarray(0, equals).toString('ascii') !== 'path' ||
      path !== undefined
    )
      throw new Error('invalid_tar_zstd_envelope')
    path = utf8.decode(record.subarray(equals + 1))
    position = end
  }
  if (path === undefined) throw new Error('invalid_tar_zstd_envelope')
  return path
}

export function validateRestrictedPaxTar(tarBytes: Buffer): TarEnvelopeEntry[] {
  const entries: TarEnvelopeEntry[] = []
  let pendingPath: string | undefined
  let offset = 0
  let terminated = false
  while (offset + BLOCK_SIZE <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + BLOCK_SIZE)
    offset += BLOCK_SIZE
    if (header.every((byte) => byte === 0)) {
      if (
        offset + BLOCK_SIZE > tarBytes.length ||
        !tarBytes
          .subarray(offset, offset + BLOCK_SIZE)
          .every((byte) => byte === 0)
      )
        throw new Error('invalid_tar_zstd_envelope')
      offset += BLOCK_SIZE
      terminated = true
      break
    }
    if (field(header, 257, 6).toString('ascii') !== 'ustar')
      throw new Error('invalid_tar_zstd_envelope')
    const expectedChecksum = octal(header, 148, 8)
    const checksumHeader = Buffer.from(header)
    checksumHeader.fill(0x20, 148, 156)
    if (
      checksumHeader.reduce((sum, byte) => sum + byte, 0) !== expectedChecksum
    )
      throw new Error('invalid_tar_zstd_envelope')
    const size = octal(header, 124, 12)
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (offset + paddedSize > tarBytes.length)
      throw new Error('invalid_tar_zstd_envelope')
    const body = tarBytes.subarray(offset, offset + size)
    offset += paddedSize
    const typeFlag = field(header, 156, 1).toString('ascii') || '0'
    if (rejectedExtensionTypes.has(typeFlag))
      throw new Error('invalid_tar_zstd_envelope')
    if (typeFlag === 'x') {
      if (pendingPath !== undefined)
        throw new Error('invalid_tar_zstd_envelope')
      if (size > MAX_PAX_HEADER_BYTES)
        throw new Error('invalid_tar_zstd_envelope')
      pendingPath = parsePaxPath(body)
      continue
    }
    entries.push({ path: pendingPath ?? headerPath(header), typeFlag, size })
    pendingPath = undefined
  }
  if (
    pendingPath !== undefined ||
    !terminated ||
    tarBytes.subarray(offset).some((byte) => byte !== 0)
  )
    throw new Error('invalid_tar_zstd_envelope')
  return entries
}

export function decompressRestrictedPaxArchive(
  bytes: Buffer,
  maxOutputLength: number
): Buffer {
  const tarBytes = zstdDecompressSync(bytes, { maxOutputLength })
  validateRestrictedPaxTar(tarBytes)
  return tarBytes
}
