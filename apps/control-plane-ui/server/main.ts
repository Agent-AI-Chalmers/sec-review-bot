import { createControlPlaneUiBffServer } from './create-bff.js'
import { artifactStoreFromEnvironment } from './artifacts/store.js'

/** Read process configuration, construct the BFF, and bind its listener. */
export function main(): void {
  const reviewRunsToken = process.env.REVIEW_RUNS_READ_TOKEN
  const accessToken = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
  const secureCookiesValue =
    process.env.CONTROL_PLANE_UI_SECURE_COOKIES?.trim() || 'false'
  if (!['true', 'false'].includes(secureCookiesValue))
    throw new Error('CONTROL_PLANE_UI_SECURE_COOKIES must be true or false.')
  if (!reviewRunsToken) throw new Error('REVIEW_RUNS_READ_TOKEN is required.')
  if (!accessToken)
    throw new Error('CONTROL_PLANE_UI_ACCESS_TOKEN is required.')
  createControlPlaneUiBffServer({
    reviewRunsUrl: process.env.REVIEW_RUNS_URL ?? 'http://127.0.0.1:8090',
    reviewRunsToken,
    accessToken,
    secureCookies: secureCookiesValue === 'true',
    memoryCatalogUrl: process.env.MEMORY_CATALOG_URL,
    memoryCatalogOperatorToken: process.env.MEMORY_CATALOG_OPERATOR_TOKEN,
    artifactStore: artifactStoreFromEnvironment()
  }).listen(
    Number.parseInt(process.env.CONTROL_PLANE_UI_PORT ?? '8091', 10),
    process.env.CONTROL_PLANE_UI_HOST?.trim() || '127.0.0.1'
  )
}

if (import.meta.main) main()
