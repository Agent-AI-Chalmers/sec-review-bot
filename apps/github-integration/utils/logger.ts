const EVENT_WIDTH = 30
const LEVEL_WIDTH = 9

const ANSI_RESET = '\x1b[0m'
const ANSI_LEVEL_COLORS = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m'
} as const

type LogLevel = keyof typeof ANSI_LEVEL_COLORS

type LogFields = Record<string, unknown>

function timestamp (): string {
  const iso = new Date().toISOString()
  // Match Python-like readability with 6-digit fractional seconds.
  // JavaScript Date only provides milliseconds, so we pad to microsecond style.
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z')
}

function formatScalar (value: unknown): string {
  if (value == null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  const text = String(value)
  return /\s/.test(text) ? JSON.stringify(text) : text
}

function formatValue (value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatScalar(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value)
  }

  return formatScalar(value)
}

function formatFields (fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ')
}

function shouldColorize (level: LogLevel): boolean {
  const noColor = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== ''
  if (noColor) {
    return false
  }

  const configured = String(process.env.LOG_COLOR ?? '').trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(configured)) {
    return false
  }
  if (['1', 'true', 'on', 'yes'].includes(configured)) {
    return true
  }

  if (level === 'error') {
    return Boolean(process.stderr.isTTY)
  }

  return Boolean(process.stdout.isTTY)
}

function formatLevelLabel (level: LogLevel): string {
  const padded = level.padEnd(LEVEL_WIDTH)

  if (!shouldColorize(level)) {
    return `[${padded}]`
  }

  const color = ANSI_LEVEL_COLORS[level] ?? ''
  return `[${color}${padded}${ANSI_RESET}]`
}

export function logEvent (level: LogLevel, event: string, fields: LogFields = {}): void {
  const levelLabel = formatLevelLabel(level)
  const eventLabel = event.length >= EVENT_WIDTH
    ? `${event} `
    : `${event.padEnd(EVENT_WIDTH)} `
  const renderedFields = formatFields(fields)
  const line = `${timestamp()} ${levelLabel} ${eventLabel}${renderedFields}`.trimEnd()

  if (level === 'error') {
    console.error(line)
    return
  }

  console.log(line)
}

export function logInfo (event: string, fields: LogFields = {}): void {
  logEvent('info', event, fields)
}

export function logWarn (event: string, fields: LogFields = {}): void {
  logEvent('warn', event, fields)
}

export function logError (event: string, fields: LogFields = {}): void {
  logEvent('error', event, fields)
}
