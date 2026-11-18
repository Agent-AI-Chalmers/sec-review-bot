import type { FileChange } from '../execution/execution-api-types-generated.js'

type UpsertFileChange = Extract<FileChange, { status: 'upsert' }>

export type { FileChange }

export type FileMode = NonNullable<UpsertFileChange['mode']>

export function fileChangePaths(file_changes: unknown): string[] {
  const paths = (Array.isArray(file_changes) ? file_changes : [])
    .map((item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      'path' in item &&
      typeof item.path === 'string'
        ? item.path.trim()
        : ''
    )
    .filter((item) => item.length > 0)

  return [...new Set(paths)]
}
