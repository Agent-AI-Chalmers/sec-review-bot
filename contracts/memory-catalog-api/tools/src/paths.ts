import path from 'node:path'

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..')
export const CONTRACT_ROOT = path.join(REPOSITORY_ROOT, 'contracts/memory-catalog-api')
export const SPEC_PATH = path.join(CONTRACT_ROOT, 'v1/openapi.yaml')
