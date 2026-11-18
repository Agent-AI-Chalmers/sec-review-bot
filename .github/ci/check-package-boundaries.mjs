import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { parseSync, Visitor } from 'oxc-parser'
import { ResolverFactory } from 'oxc-resolver'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const resolver = new ResolverFactory({
  tsconfig: 'auto',
  extensions: ['.ts', '.tsx', '.js', '.mjs', '.cts', '.mts'],
  extensionAlias: { '.js': ['.ts', '.tsx', '.js'] }
})
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
  const owner = (file) => packages.find(({ directory }) => file.startsWith(`${directory}/`))
  const errors = []
  const allowed = (from, to) =>
    from === to || (from.startsWith('contracts/') && from.endsWith('/tools') && to === codegen)
  for (const { directory, manifest } of packages) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        const target = packages.find(({ manifest: candidate }) => candidate.name === name)
        if (target && !allowed(directory, target.directory)) {
          errors.push(`${directory}/package.json: forbidden ${field} dependency on ${name}`)
        }
        if (/^(file:|link:)/.test(version)) {
          errors.push(
            `${directory}/package.json: local dependency ${name} must not bypass package boundaries`
          )
        }
      }
    }
  }
  for (const file of files.filter((file) => /\.[cm]?[jt]sx?$/.test(file))) {
    const from = owner(file)
    if (!from) {
      continue
    }
    const absoluteFile = path.join(root, file)
    const text = read(file)
    const { program, errors: parseErrors } = parseSync(file, text)
    if (parseErrors.length) {
      errors.push(`${file}: invalid source: ${JSON.stringify(parseErrors)}`)
      continue
    }
    const checkReference = (value, start) => {
      let targetFile
      if (value.startsWith('.')) {
        targetFile = path.posix.normalize(path.posix.join(path.posix.dirname(file), value))
      } else {
        const target = packages.find(
          ({ manifest }) => value === manifest.name || value.startsWith(`${manifest.name}/`)
        )
        if (target) {
          targetFile = `${target.directory}/${value.slice(target.manifest.name.length)}`
        }
      }
      // Resolve tsconfig aliases as well as package names and relative paths.
      if (!targetFile) {
        const resolved = resolver.resolveFileSync(absoluteFile, value)
        if (resolved.path) {
          targetFile = path.relative(root, resolved.path).split(path.sep).join('/')
        }
      }
      const to = targetFile && owner(targetFile)
      if (to && !allowed(from.directory, to.directory)) {
        const line = text.slice(0, start).split('\n').length - 1
        errors.push(`${file}:${line + 1}: forbidden reference to ${value} (${to.directory})`)
      }
    }
    new Visitor({
      Literal(node) {
        if (typeof node.value === 'string') {
          checkReference(node.value, node.start)
        }
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) {
          checkReference(node.quasis[0].value.cooked ?? node.quasis[0].value.raw, node.start)
        }
      }
    }).visit(program)
  }
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => file && existsSync(path.join(root, file)))
  const errors = checkBoundaries([...new Set(files)])
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Node.js package boundaries ok')
  }
}
