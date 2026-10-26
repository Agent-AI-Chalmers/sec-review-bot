import type { FileChange } from '../execution/execution-api-types-generated.js'

type UpsertFileChange = Extract<FileChange, { status: 'upsert' }>

export type { FileChange }
export type TextEncoding = UpsertFileChange['content_encoding']
export type FileMode = NonNullable<UpsertFileChange['mode']>

export function fileChangePaths(file_changes: unknown): string[] {
  const paths = (Array.isArray(file_changes) ? file_changes : [])
    .map((item) =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? String((item as Record<string, unknown>).path ?? '').trim()
        : ''
    )
    .filter((item) => item.length > 0)

  return [...new Set(paths)]
}
