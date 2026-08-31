const SENSITIVE_EXACT_PATHS = new Set([
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS'
])

function isSensitivePath (path: string): boolean {
  if (SENSITIVE_EXACT_PATHS.has(path)) {
    return true
  }
  return path === '.github/workflows' || path.startsWith('.github/workflows/')
}

export function validateRepoRelativePathShape (value: string): string {
  // Structural contract check only; publishing policy such as sensitive paths is enforced by publishing validators.
  const normalized = value
  const parts = normalized.split('/')

  if (
    !normalized ||
    normalized.trim() === '' ||
    normalized !== normalized.trim() ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe repository file path: ${value}`)
  }

  if (parts[0] === '.git' || parts.includes('.git')) {
    throw new Error(`Unsafe repository file path targets .git: ${normalized}`)
  }

  return normalized
}

export function validateRepoRelativePath (value: string): string {
  const normalized = validateRepoRelativePathShape(value.trim().replace(/\\/g, '/'))

  // Model-authored PRs must not silently change repository security controls.
  if (isSensitivePath(normalized)) {
    throw new Error(`Sensitive repository file path requires explicit policy: ${normalized}`)
  }

  return normalized
}

export function validateContractPublishableRepoRelativePath (value: string): string {
  const normalized = validateRepoRelativePathShape(value)

  if (isSensitivePath(normalized)) {
    throw new Error(`Sensitive repository file path requires explicit policy: ${normalized}`)
  }

  return normalized
}
