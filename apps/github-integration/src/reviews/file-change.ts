import { asList, isRecord, nonEmptyText } from './view-utils.js'
import type { FileChange } from '../execution/integration-contract-types-generated.js'

type UpsertFileChange = Extract<FileChange, { status: 'upsert' }>

export type { FileChange }
export type TextEncoding = UpsertFileChange['content_encoding']
export type FileMode = NonNullable<UpsertFileChange['mode']>

export function fileChangePaths(file_changes: unknown): string[] {
  const paths = asList(file_changes)
    .map((item) => (isRecord(item) ? nonEmptyText(item.path) : ''))
    .filter((item) => item.length > 0)

  return [...new Set(paths)]
}
