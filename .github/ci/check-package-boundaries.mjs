import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(
  new URL('../../contracts/codegen/package.json', import.meta.url)
)
const ts = require('typescript')
const codegen = 'contracts/codegen'

export function checkBoundaries(
  files,
  read = (file) => readFileSync(path.join(root, file), 'utf8')
) {
  const manifests = files.filter((file) =>
    /^(apps|services|contracts)\/.+\/package\.json$/.test(file)
  )
  const packages = manifests
    .map((file) => ({
      directory: path.posix.dirname(file),
      manifest: JSON.parse(read(file))
    }))
    .sort((a, b) => b.directory.length - a.directory.length)
  const owner = (file) =>
    packages.find(({ directory }) => file.startsWith(`${directory}/`))
  const errors = []
  const allowed = (from, to) =>
    from === to ||
    (from.startsWith('contracts/') && from.endsWith('/tools') && to === codegen)
  for (const { directory, manifest } of packages) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        const target = packages.find(
          ({ manifest: candidate }) => candidate.name === name
        )
        if (target && !allowed(directory, target.directory)) {
          errors.push(
            `${directory}/package.json: forbidden ${field} dependency on ${name}`
          )
        }
        if (/^(file:|link:)/.test(version)) {
          errors.push(
            `${directory}/package.json: local dependency ${name} must not bypass package boundaries`
          )
        }
      }
    }
  }
  const configs = new Map()
  for (const file of files.filter((file) => /\.[cm]?[jt]sx?$/.test(file))) {
    const from = owner(file)
    if (!from) continue
    const absoluteFile = path.join(root, file)
    const configFile = ts.findConfigFile(
      path.dirname(absoluteFile),
      ts.sys.fileExists
    )
    if (configFile && !configs.has(configFile)) {
      const config = ts.readConfigFile(configFile, ts.sys.readFile)
      const parsed = ts.parseJsonConfigFileContent(
        config.config ?? {},
        ts.sys,
        path.dirname(configFile)
      )
      configs.set(configFile, parsed.options)
    }
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true
    )
    const visit = (node) => {
      // Inspect literal module/file references through the AST, including require(),
      // import types, re-exports, dynamic imports, and new URL(..., import.meta.url).
      if (ts.isStringLiteralLike(node)) {
        const value = node.text
        let targetFile
        if (value.startsWith('.')) {
          targetFile = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), value)
          )
        } else {
          const target = packages.find(
            ({ manifest }) =>
              value === manifest.name || value.startsWith(`${manifest.name}/`)
          )
          if (target)
            targetFile = `${target.directory}/${value.slice(target.manifest.name.length)}`
        }
        // Resolve tsconfig aliases as well as package names and relative paths.
        if (!targetFile && configFile) {
          const resolved = ts.resolveModuleName(
            value,
            absoluteFile,
            configs.get(configFile),
            ts.sys
          ).resolvedModule
          if (resolved)
            targetFile = path
              .relative(root, resolved.resolvedFileName)
              .split(path.sep)
              .join('/')
        }
        const to = targetFile && owner(targetFile)
        if (to && !allowed(from.directory, to.directory)) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source)
          )
          errors.push(
            `${file}:${line + 1}: forbidden reference to ${value} (${to.directory})`
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return errors
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => file && ts.sys.fileExists(path.join(root, file)))
  const errors = checkBoundaries([...new Set(files)])
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Node.js package boundaries ok')
  }
}
