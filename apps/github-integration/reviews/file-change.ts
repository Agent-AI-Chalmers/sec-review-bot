import { asList, isRecord, nonEmptyText } from './view-utils.js'

export type TextEncoding = 'utf-8' | 'base64'
export type FileMode = '100644' | '100755'

export type FileChange =
  | {
      path: string
      status: 'deleted'
    }
  | {
      path: string
      status: 'upsert'
      content_encoding: TextEncoding
      content: string
      mode?: FileMode
    }

export function fileChangePaths (file_changes: unknown): string[] {
  const paths = asList(file_changes)
    .map((item) => isRecord(item) ? nonEmptyText(item.path) : '')
    .filter((item) => item.length > 0)

  return [...new Set(paths)]
}
