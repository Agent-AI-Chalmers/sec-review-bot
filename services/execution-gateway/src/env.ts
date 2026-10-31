export function integerEnv(
  name: string,
  defaultValue: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue

  const value = raw.trim()
  if (!/^[+-]?\d+$/.test(value))
    throw new Error(`${name} must be a decimal integer.`)

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${name} must be a safe integer.`)
  if (parsed < minimum) throw new Error(`${name} must be at least ${minimum}.`)
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}.`)
  return parsed
}
