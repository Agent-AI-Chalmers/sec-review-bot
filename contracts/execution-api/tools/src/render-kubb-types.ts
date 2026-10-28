import { memoryStorage } from '@kubb/core'
import { pluginTs } from '@kubb/plugin-ts'
import { createKubb } from 'kubb'

export async function renderKubbTypes(specPath: string): Promise<string> {
  const storage = memoryStorage()
  const kubb = createKubb({
    input: specPath,
    output: { path: 'generated' },
    storage,
    plugins: [
      pluginTs({
        output: { path: 'types.ts', mode: 'file' },
        // Shared enum objects can widen oneOf branches and break discriminated unions.
        enum: { type: 'inlineLiteral' }
      })
    ]
  })

  try {
    const result = await kubb.safeBuild()
    const errors = result.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error'
    )
    if (errors.length > 0) {
      throw new Error(`Kubb generation failed: ${JSON.stringify(errors)}`)
    }
    const outputPath = result.files[0]?.path
    if (outputPath === undefined || result.files.length !== 1) {
      throw new Error(
        `Kubb generated ${result.files.length} files; expected one`
      )
    }
    const rendered = await result.storage.readItem(outputPath)
    if (rendered === null) {
      throw new Error(`Kubb did not generate ${outputPath}`)
    }
    if (typeof rendered !== 'string') {
      throw new Error(`Kubb generated a non-text value at ${outputPath}`)
    }
    return rendered
  } finally {
    kubb.dispose()
  }
}
