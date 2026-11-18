import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { format, type FormatConfig } from 'oxfmt'

/** Format a projection using its destination's nearest repository formatter config. */
export async function formatGenerated(file: string, source: string): Promise<string> {
  const output = path.resolve(file)
  let directory = path.dirname(output)
  while (true) {
    const configPath = path.join(directory, '.oxfmtrc.json')
    let text: string
    try {
      text = await readFile(configPath, 'utf8')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
      const parent = path.dirname(directory)
      if (parent === directory) {
        throw new Error(`No formatter config for generated output ${output}`, { cause: error })
      }
      directory = parent
      continue
    }
    const options = JSON.parse(text) as FormatConfig & {
      ignorePatterns?: string[]
      overrides?: unknown[]
    }
    const overrides = options.overrides
    delete options.ignorePatterns
    delete options.overrides
    // Generated Markdown keeps embedded examples and semantic paragraphs intact.
    // Root's existing Markdown override expresses the same policy; other overrides
    // must not be silently ignored if configuration evolves.
    if (
      overrides !== undefined &&
      JSON.stringify(overrides) !==
        JSON.stringify([{ files: ['*.md'], options: { embeddedLanguageFormatting: 'off' } }])
    ) {
      throw new Error(`Unsupported formatter overrides for generated output: ${configPath}`)
    }
    const result = await format(output, source, {
      ...options,
      embeddedLanguageFormatting: 'off',
      proseWrap: 'preserve'
    })
    if (result.errors.length > 0) {
      throw new Error(`Failed to format ${output}: ${JSON.stringify(result.errors)}`)
    }
    return result.code
  }
}
