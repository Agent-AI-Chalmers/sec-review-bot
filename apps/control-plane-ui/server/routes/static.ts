import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export interface StaticRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Serve the built browser assets and the SPA fallback. */
export function createStaticRoutes({
  assets
}: {
  assets: string
}): StaticRoutes {
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    const requested =
      request.url === '/'
        ? 'index.html'
        : (request.url?.slice(1) ?? 'index.html')
    let file = path.resolve(assets, requested)
    if (!file.startsWith(`${assets}${path.sep}`)) {
      response.writeHead(404)
      response.end()
      return true
    }
    try {
      if (!(await stat(file)).isFile()) file = path.join(assets, 'index.html')
    } catch {
      file = path.join(assets, 'index.html')
    }
    response.writeHead(200, {
      'content-type': file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/javascript'
    })
    createReadStream(file).pipe(response)
    return true
  }

  return { handle }
}
