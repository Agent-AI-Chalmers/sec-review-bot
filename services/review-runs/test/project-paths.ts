import path from 'node:path'

// Only this test module owns the package's position in the repository.
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')
export const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '../..')
export const CONTRACTS_ROOT = path.join(REPOSITORY_ROOT, 'contracts')
