import assert from 'node:assert/strict'

export type RequestOptions = {
  base: string
  method: 'GET' | 'POST'
  path: string
  expectedStatus: number
  token?: string
  headers?: Record<string, string>
  json?: unknown
}

export async function request({
  base,
  method,
  path,
  expectedStatus,
  token,
  headers,
  json
}: RequestOptions): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    signal: AbortSignal.timeout(10000)
  })
  assert.equal(
    response.status,
    expectedStatus,
    `${base}${path}: ${await response.clone().text()}`
  )
  console.error(`ok: ${expectedStatus} ${base}${path}`)
  return response
}

export const gateway = 'http://execution-gateway:8000'
export const runs = 'http://review-runs:8090'
export const catalog = 'http://memory-catalog-server:8092'
