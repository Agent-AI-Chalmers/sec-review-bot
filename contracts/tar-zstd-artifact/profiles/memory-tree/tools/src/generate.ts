import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { buildArchive, MEDIA_TYPE, sha256 } from './archive.js'
import { corpusCaseDefinitions } from './corpus.js'
import { FIXTURE_ROOT } from './paths.js'

export interface CorpusManifestEntry {
  file: string
  description: string
  mediaType: typeof MEDIA_TYPE
  sha256: string
  size: number
  expected: 'valid' | 'invalid'
  expectedCode: string | null
  objectKey: string
  entryCount: number
  entries?: Array<{
    path: string
    kind: string
    sizeBytes: number
    linkPath?: string
  }>
}

function effectiveEntries(
  entries: ReturnType<typeof corpusCaseDefinitions>[number]['entries']
) {
  let pendingPath: string | undefined
  const projected: Array<{
    path: string
    kind: string
    sizeBytes: number
    linkPath?: string
  }> = []
  for (const entry of entries) {
    if (entry.kind === 'pax-header') {
      const record = entry.body?.toString('utf8') ?? ''
      const match = /^\d+ path=(.*)\n$/.exec(record)
      pendingPath = match?.[1]
      continue
    }
    projected.push({
      path: pendingPath ?? entry.path,
      kind: entry.kind,
      sizeBytes: entry.kind === 'file' ? (entry.body?.length ?? 0) : 0,
      ...(entry.linkPath === undefined ? {} : { linkPath: entry.linkPath })
    })
    pendingPath = undefined
  }
  return projected
}

export function generateCorpus(
  outputRoot = FIXTURE_ROOT
): CorpusManifestEntry[] {
  mkdirSync(outputRoot, { recursive: true })
  const records = corpusCaseDefinitions().map((fixture) => {
    const archive = buildArchive(fixture.entries)
    const entries = effectiveEntries(fixture.entries)
    writeFileSync(path.join(outputRoot, fixture.file), archive)
    const digest = sha256(archive)
    return {
      file: fixture.file,
      description: fixture.description,
      mediaType: MEDIA_TYPE,
      sha256: digest,
      size: archive.length,
      expected: fixture.expected,
      expectedCode: fixture.expectedCode,
      objectKey: `memory/trees/${digest}/memory-tree.v1.tar.zst`,
      entryCount: entries.length,
      ...(fixture.includeEntryDetails === false
        ? {}
        : {
            entries
          })
    }
  })
  writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify({ corpus: records }, null, 2)}\n`
  )
  return records
}

if (
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1])
) {
  generateCorpus()
}
