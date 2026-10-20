// Bounds how often a diagnostic log line can be emitted from an internet-facing path.
//
// Some diagnostics are triggered by arbitrary comment text - an unrecognised `@mention` is the
// motivating case. Logging each one would let anyone with comment access inflate the log stream:
// unbounded growth, noise that hides real events, and cost in whatever collects the logs. The
// diagnostic is still worth keeping, so it is throttled rather than dropped entirely.
//
// The throttle is intentionally in-memory and process-local. It exists to blunt noise, not to
// enforce a security boundary, so it does not need shared state: each instance independently
// caps what it writes. A restart forgetting the window is acceptable for a log hint.

/** A keyed "at most once per window, at most N distinct keys" throttle.
 *
 * Two independent limits are needed:
 *  - `minIntervalMs` stops a single repository (or other key) from logging on every event.
 *  - `maxKeys`/`maxEntries` stops an attacker cycling through many keys to defeat the interval,
 *    which a per-key check alone would allow (each new key looks like a first sighting).
 *
 * The map is bounded: once `maxKeys` distinct keys are remembered, new keys are refused, so the
 * structure cannot grow without limit from attacker-chosen input. */
export function createLogThrottle({
  minIntervalMs,
  maxKeys,
  now = () => Date.now()
}: {
  minIntervalMs: number
  maxKeys: number
  now?: () => number
}): (key: string) => boolean {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0)
    throw new Error('minIntervalMs must be a non-negative finite number.')
  if (!Number.isInteger(maxKeys) || maxKeys < 1)
    throw new Error('maxKeys must be a positive integer.')

  const lastSeen = new Map<string, number>()
  return (key: string): boolean => {
    const current = now()
    const previous = lastSeen.get(key)
    if (previous !== undefined) {
      // An unexpired sighting suppresses the log. A rolling wall clock that moved backwards
      // (`current < previous`) must not open the gate, so only a full interval past suppresses.
      if (current - previous < minIntervalMs) return false
      lastSeen.set(key, current)
      return true
    }
    if (lastSeen.size >= maxKeys) {
      // Bounded refusal: an attacker cannot grow the table by inventing new keys.
      return false
    }
    lastSeen.set(key, current)
    return true
  }
}
