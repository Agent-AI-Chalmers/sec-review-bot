import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

test('test runner isolates inherited Git settings while preserving repository attributes', async () => {
  // Run the real bootstrap in a miniature suite so pollution exists before startup.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-isolation-test-'))
  try {
    await fs.mkdir(path.join(root, 'test'))
    await fs.mkdir(path.join(root, 'xdg', 'git'), { recursive: true })
    await fs.symlink(
      path.join(packageRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      'junction'
    )
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await fs.writeFile(
      path.join(root, 'xdg', 'git', 'attributes'),
      '* text eol=crlf\n'
    )
    const config = path.join(root, 'user.gitconfig')
    await fs.writeFile(
      config,
      '[core]\n\tautocrlf = true\n[commit]\n\tgpgsign = true\n'
    )
    await fs.copyFile(
      path.join(packageRoot, 'test', 'fixtures', 'git-environment-probe.ts'),
      path.join(root, 'test', 'probe.test.ts')
    )
    await execFileAsync(
      process.execPath,
      [path.join(packageRoot, 'scripts', 'test-runner.mjs'), 'unit'],
      {
        cwd: root,
        timeout: 60_000,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(root, 'xdg'),
          GIT_CONFIG_GLOBAL: config,
          GIT_DIR: path.join(root, 'nonexistent.git'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.autocrlf',
          GIT_CONFIG_VALUE_0: 'true'
        }
      }
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
