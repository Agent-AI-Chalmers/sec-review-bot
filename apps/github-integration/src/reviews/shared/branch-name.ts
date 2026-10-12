// Sanitizes a git branch-name segment so the assembled `refs/heads/...` is
// accepted by `git check-ref-format`. The issue and repository draft-PR builders
// share this so a ref-safety fix cannot drift between the two copies again.
export function sanitizeBranchSegment(value: unknown): string {
  // `.` is deliberately excluded from the allowed set: git forbids a ref component
  // that contains `..`, starts with `.`, or ends with `.`/`.lock`. A contract-valid
  // `delivery_id` such as `a..b`, `..`, or `.lock` used to survive this sanitizer
  // and produce a branch name `git check-ref-format` rejects (createRef -> 422 ->
  // no draft PR). Replacing dots with `-` makes every dot form ref-safe.
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}
