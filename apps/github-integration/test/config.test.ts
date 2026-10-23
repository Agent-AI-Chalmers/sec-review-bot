import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const READ_PORT_SCRIPT =
  "import('./src/config.ts').then(({ port }) => console.log(`CONFIG_PORT:${typeof port}:${port}`))"

function readConfiguredPort(value?: string) {
  const env = { ...process.env }
  if (value === undefined) delete env.PORT
  else env.PORT = value

  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', READ_PORT_SCRIPT],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    }
  )
}

test('PORT defaults only when it is unset and exports a number', () => {
  const result = readConfiguredPort()

  assert.strictEqual(result.status, 0, result.stderr)
  assert.match(result.stdout, /CONFIG_PORT:number:30000/)
})

test('PORT accepts a decimal TCP port and exports a number', () => {
  const result = readConfiguredPort('31000')

  assert.strictEqual(result.status, 0, result.stderr)
  assert.match(result.stdout, /CONFIG_PORT:number:31000/)
})

test('PORT rejects explicit values that are not TCP ports', async (t) => {
  for (const value of ['', 'abc', '30000ms', '0', '65536']) {
    await t.test(JSON.stringify(value), () => {
      const result = readConfiguredPort(value)

      assert.notStrictEqual(result.status, 0)
      assert.match(`${result.stdout}${result.stderr}`, /PORT must/)
    })
  }
})
