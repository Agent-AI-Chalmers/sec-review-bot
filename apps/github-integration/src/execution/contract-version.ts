/**
 * Single source of truth for the integration contract version.
 *
 * `CONTRACT_VERSION` is the version this code produces and expects. It is
 * deliberately defined once and imported everywhere: the value is a contract
 * identity, not something each call site should restate.
 *
 * `CONTRACT_VERSION_DIR` is the on-disk directory name that holds the schemas.
 * It currently equals the version string, but it is a separate concept: the
 * location of the contract files and the identity of the contract version are
 * different concerns, so callers should reference this name rather than
 * hard-coding a version in a path.
 */
export const CONTRACT_VERSION = 'v6' as const

export type ContractVersion = typeof CONTRACT_VERSION

export const CONTRACT_VERSION_DIR = CONTRACT_VERSION
