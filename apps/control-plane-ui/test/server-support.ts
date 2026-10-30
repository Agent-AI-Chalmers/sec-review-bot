import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'

import tar from 'tar-stream'

export async function diagnosticBundle(runId: string): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collecting = (async (): Promise<void> => {
    for await (const chunk of pack as unknown as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk))
  })()
  const entries = [
    [
      'manifest.json',
      JSON.stringify({
        version: 1,
        run_id: runId,
        result: 'result.json',
        review_units: [
          {
            id: 'unit-1',
            trajectories: ['artifact-tree/unit-1/review.jsonl']
          }
        ]
      })
    ],
    ['result.json', '{"status":"completed"}'],
    ['artifact-tree/unit-1/review.jsonl', '{"event":"message"}\n']
  ] as const
  for (const [name, value] of entries) {
    const body = Buffer.from(value)
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        { name, type: 'file', size: body.length, mtime: new Date(0) },
        body,
        (error) => (error ? reject(error) : resolve())
      )
    })
  }
  pack.finalize()
  await collecting
  return zstdCompressSync(Buffer.concat(chunks))
}

export async function loginCookie(base: string): Promise<string> {
  const login = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"token":"login-secret"}'
  })
  const cookie = login.headers.get('set-cookie')
  assert(cookie !== null)
  return cookie
}
