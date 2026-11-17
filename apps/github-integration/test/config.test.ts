import { spawnSync } from 'node:child_process'
import { expect, describe, test } from 'vitest'

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

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/CONFIG_PORT:number:30000/)
})

test('PORT accepts a decimal TCP port and exports a number', () => {
  const result = readConfiguredPort('31000')

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/CONFIG_PORT:number:31000/)
})

describe('PORT rejects explicit values that are not TCP ports', () => {
  test.each(['', 'abc', '30000ms', '0', '65536'])('%j', (value) => {
    const result = readConfiguredPort(value)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/PORT must/)
  })
})

test('S3 addressing style defaults to auto', () => {
  const result = readConfiguredAddressingStyle()

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/ADDRESSING_STYLE:auto/)
})

describe('S3 addressing style accepts path and virtual', () => {
  test.each(['path', 'virtual'])('%s', (value) => {
    const result = readConfiguredAddressingStyle(value)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(new RegExp(`ADDRESSING_STYLE:${value}`))
  })
})

test('S3 addressing style rejects unknown values', () => {
  const result = readConfiguredAddressingStyle('hostname')

  expect(result.status).not.toBe(0)
  expect(`${result.stdout}${result.stderr}`).toMatch(
    /SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE must/
  )
})
