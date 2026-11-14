import path from 'node:path'

// Deployment supplies this root; the fallback supports source-checkout development.
export function contractsRoot(): string {
  const configured = process.env.SEC_REVIEW_CONTRACTS_ROOT?.trim()
  return configured
    ? path.resolve(configured)
    : path.resolve(import.meta.dirname, '../../../contracts')
}
