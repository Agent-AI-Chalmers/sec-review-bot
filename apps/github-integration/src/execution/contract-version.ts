/**
 * Single source of truth for the integration contract version.
 *
 * `CONTRACT_VERSION` is the version this code produces and expects. It is
 * deliberately defined once and imported everywhere: the value is a contract
 * identity, not something each call site should restate.
 */
export const CONTRACT_VERSION = 'v6' as const

export type ContractVersion = typeof CONTRACT_VERSION
