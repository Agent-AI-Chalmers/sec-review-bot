#!/usr/bin/env node
import type {
  RunnerRunDiagnosticRecord,
  RunnerRunDiagnosticsOptions,
  RunnerRunStatus
} from '../infrastructure/runner/run-store.js'

interface DiagnosticsOptions {
  active_only: boolean
  failed_only: boolean
  help: boolean
  json: boolean
  limit: number
  status: RunnerRunStatus | null
}

const DEFAULT_LIMIT = 25
const RUN_STATUSES: RunnerRunStatus[] = [
  'queued',
  'running',
  'publishing',
  'published',
  'failed',
  'publish_failed'
]

function parsePositiveIntegerOption (name: string, value: string | undefined): number {
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${name} requires a positive integer value.`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${name} requires a positive integer value.`)
  }
  return parsed
}

export function parseDiagnosticsArgs (args: string[]): DiagnosticsOptions {
  let active_only = false
  let failed_only = false
  let help = false
  let json = false
  let limit = DEFAULT_LIMIT
  let status: RunnerRunStatus | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--active-only') {
      active_only = true
      continue
    }
    if (arg === '--failed-only') {
      failed_only = true
      continue
    }
    if (arg === '--limit') {
      limit = parsePositiveIntegerOption('--limit', args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--limit=')) {
      limit = parsePositiveIntegerOption('--limit', arg.slice('--limit='.length))
      continue
    }
    if (arg === '--status') {
      status = parseStatusOption(args[index + 1])
      index += 1
      continue
    }
    if (arg?.startsWith('--status=')) {
      status = parseStatusOption(arg.slice('--status='.length))
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (active_only && failed_only) {
    throw new Error('--active-only and --failed-only cannot be used together.')
  }

  return { active_only, failed_only, help, json, limit, status }
}

function parseStatusOption (value: string | undefined): RunnerRunStatus {
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error('--status requires a runner run status value.')
  }
  if (!RUN_STATUSES.includes(value as RunnerRunStatus)) {
    throw new Error(`--status must be one of: ${RUN_STATUSES.join(', ')}.`)
  }
  return value as RunnerRunStatus
}

function boolText (value: boolean): string {
  return value ? 'yes' : 'no'
}

function truncate (value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function cellValue (run: RunnerRunDiagnosticRecord, column: string): string {
  if (column === 'run_id') return run.run_id
  if (column === 'workflow') return run.workflow
  if (column === 'status') return run.status
  if (column === 'active') return boolText(run.is_active)
  if (column === 'terminal') return boolText(run.is_terminal)
  if (column === 'retry_exhausted') return boolText(run.retry_exhausted)
  if (column === 'attempts') return String(run.publish_attempts)
  if (column === 'remaining') return String(run.publish_attempts_remaining)
  if (column === 'failure_code') return run.failure_code ?? ''
  if (column === 'updated_at') return run.updated_at
  throw new Error(`Unknown diagnostics column: ${column}`)
}

export function formatRunnerRunDiagnostics (runs: RunnerRunDiagnosticRecord[]): string {
  const columns = [
    'run_id',
    'workflow',
    'status',
    'active',
    'terminal',
    'retry_exhausted',
    'attempts',
    'remaining',
    'failure_code',
    'updated_at'
  ]
  const rows = runs.map((run) => columns.map((column) => truncate(cellValue(run, column), 48)))
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...rows.map((row) => row[index]?.length ?? 0)
  ))
  const formatRow = (values: string[]): string => values
    .map((value, index) => value.padEnd(widths[index] ?? 0))
    .join('  ')
    .trimEnd()

  return [
    formatRow(columns),
    formatRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(formatRow)
  ].join('\n')
}

export function diagnosticsHelp (): string {
  return [
    'Usage: sec-review-runner-runs [options]',
    '',
    'Print recent GitHub integration runner run publication state.',
    '',
    'Options:',
    '  --limit <n>        Maximum number of rows to print. Defaults to 25.',
    `  --status <status>  Filter by status: ${RUN_STATUSES.join(', ')}.`,
    '  --active-only      Show only runs still active for the background publisher.',
    '  --failed-only      Show failed and publish_failed runs.',
    '  --json             Print JSON instead of a table.',
    '  -h, --help         Show this help text.'
  ].join('\n')
}

function diagnosticsStoreOptions (options: DiagnosticsOptions): RunnerRunDiagnosticsOptions {
  return {
    limit: options.limit,
    ...(options.status ? { status: options.status } : {}),
    ...(options.active_only ? { active_only: true } : {}),
    ...(options.failed_only ? { failed_only: true } : {})
  }
}

async function main (): Promise<void> {
  const options = parseDiagnosticsArgs(process.argv.slice(2))
  if (options.help) {
    console.log(diagnosticsHelp())
    return
  }

  process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET ?? 'true'
  const { runnerRunStore } = await import('../infrastructure/runner/run-store.js')
  const runs = runnerRunStore.listRunsForDiagnostics(diagnosticsStoreOptions(options))
  if (options.json) {
    console.log(JSON.stringify(runs, null, 2))
    return
  }
  console.log(formatRunnerRunDiagnostics(runs))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
