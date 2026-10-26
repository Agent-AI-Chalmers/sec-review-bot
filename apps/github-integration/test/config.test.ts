import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const READ_PORT_SCRIPT =
  "import('./src/config.ts').then(({ port }) => console.log(`CONFIG_PORT:${typeof port}:${port}`))"
const READ_ADDRESSING_STYLE_SCRIPT =
  "import('./src/config.ts').then(({ artifact_s3_addressing_style }) => console.log(`ADDRESSING_STYLE:${artifact_s3_addressing_style}`))"

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

function readConfiguredAddressingStyle(value?: string) {
  const env = { ...process.env }
  if (value === undefined) delete env.SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE
  else env.SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE = value

  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', READ_ADDRESSING_STYLE_SCRIPT],
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

test('S3 addressing style defaults to auto', () => {
  const result = readConfiguredAddressingStyle()

  assert.strictEqual(result.status, 0, result.stderr)
  assert.match(result.stdout, /ADDRESSING_STYLE:auto/)
})

test('S3 addressing style accepts path and virtual', async (t) => {
  for (const value of ['path', 'virtual']) {
    await t.test(value, () => {
      const result = readConfiguredAddressingStyle(value)

      assert.strictEqual(result.status, 0, result.stderr)
      assert.match(result.stdout, new RegExp(`ADDRESSING_STYLE:${value}`))
    })
  }
})

test('S3 addressing style rejects unknown values', () => {
  const result = readConfiguredAddressingStyle('hostname')

  assert.notStrictEqual(result.status, 0)
  assert.match(
    `${result.stdout}${result.stderr}`,
    /SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE must/
  )
})
