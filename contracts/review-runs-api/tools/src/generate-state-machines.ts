// Project the contract's `x-state-machines` block into the module the console and Review Runs
// read, and into the Markdown page people read. The block is the single source of truth for the
// coordination lifecycles. Its text is English; `v1/overlays/zh.yaml` is an OpenAPI Overlay that
// supplies the Chinese title, label, and description for the same machines. Regenerate with
// `pnpm --dir contracts/review-runs-api/tools run generate`.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import prettier from 'prettier'
import { parse as parseYaml } from 'yaml'

import type { GeneratedArtifact } from './generated-artifact.js'
import { REPO_ROOT } from './repo-root.js'

const SPEC_PATH = path.resolve(
  REPO_ROOT,
  'contracts',
  'review-runs-api',
  'v1',
  'openapi.yaml'
)

/** The languages the console shows. English is the contract itself; every other language is an
 * overlay of it. */
const LANGUAGES = ['en', 'zh'] as const

export type Language = (typeof LANGUAGES)[number]

/** The three run axes. Each owns one row per run and one state machine; this is the only sense
 * of "axis" the contract uses. */
export type CoordinationAxis = 'preparation' | 'execution' | 'publication'

export interface StateTransition {
  from: string
  to: string
  /** Machine-readable cause a write path attaches, when the transition has one. */
  reason?: string
  /** Short English label shown as the edge tooltip; the console localizes it by key. */
  label?: string
}

/** One state on a machine: its display labels and the sentence shown when it is hovered. This
 * text lives in the contract so a tooltip can never describe a state differently from the
 * diagram or the schema. */
export interface StateDetail {
  /** English label; the console localizes it by state key. */
  label: string
  /** English sentence shown on hover; the console localizes it by state key. */
  description: string
}

/** The lifecycle of one row: an axis row, or a step row nested under its axis. */
export interface MachineBody {
  /** The schema field whose enum this machine's states must equal. */
  field: string
  initial: string
  terminal: string[]
  /** State keys in declaration order. */
  states: string[]
  /** Per-state label and hover description, keyed by the same values as `states`. */
  details: Record<string, StateDetail>
  transitions: StateTransition[]
}

export interface StateMachine extends MachineBody {
  axis: CoordinationAxis
  /** Display order across axes: earlier in the lifecycle sorts first (preparation before
   * execution before publication). */
  order: number
  title: string
  /** The machine of the steps this axis is made of, when it has steps. Step transitions are
   * recorded on this axis with a `step_key`. */
  step?: MachineBody
}

const AXES: readonly CoordinationAxis[] = [
  'preparation',
  'execution',
  'publication'
]

/** Read and validate the `x-state-machines` block. Validation here is deliberately strict:
 * a generator that silently accepts a malformed machine would produce a diagram that no
 * longer means what the contract says. */
export function readStateMachines(language: Language = 'en'): StateMachine[] {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as {
    'x-state-machines'?: Record<string, unknown>
  }
  const block = spec['x-state-machines']
  if (block === undefined)
    throw new Error('openapi.yaml has no x-state-machines block')
  if (language !== 'en') {
    const overlay = OVERLAY_SOURCES[language]
    applyTextOverlay(
      block,
      parseYaml(readFileSync(path.resolve(REPO_ROOT, overlay), 'utf8')),
      overlay
    )
  }
  const unknown = Object.keys(block).filter(
    (key) => !(AXES as readonly string[]).includes(key)
  )
  if (unknown.length > 0)
    throw new Error(
      `x-state-machines declares ${unknown.join(', ')}, which is not an axis`
    )
  const machines = AXES.map((axis): StateMachine => {
    const raw = asRecord(block[axis], axis)
    const body = readMachineBody(raw, axis)
    const step =
      raw.step === undefined
        ? undefined
        : readMachineBody(asRecord(raw.step, `${axis}.step`), `${axis}.step`)
    return {
      axis,
      order: asNumber(raw.order, `${axis}.order`),
      title: asString(raw.title, `${axis}.title`),
      ...body,
      ...(step === undefined ? {} : { step })
    }
  })
  // The lifecycle order is declared in the contract (`order`), not implied by YAML key order,
  // so the diagram reads preparation -> execution -> publication.
  return machines.sort((left, right) => left.order - right.order)
}

function readMachineBody(
  raw: Record<string, unknown>,
  where: string
): MachineBody {
  const { states, details } = readStates(raw.states, `${where}.states`)
  const terminal = asStringArray(raw.terminal, `${where}.terminal`)
  const initial = asString(raw.initial, `${where}.initial`)
  const field = asString(raw.field, `${where}.field`)
  if (!states.includes(initial))
    throw new Error(
      `x-state-machines.${where}.initial is not one of its states`
    )
  for (const state of terminal)
    if (!states.includes(state))
      throw new Error(
        `x-state-machines.${where}.terminal ${state} is not a state`
      )
  if (!Array.isArray(raw.transitions))
    throw new Error(`x-state-machines.${where}.transitions must be an array`)
  const transitions = raw.transitions.map((edge, index): StateTransition => {
    const record = asRecord(edge, `${where}.transitions[${index}]`)
    const from = asString(record.from, `${where}.transitions[${index}].from`)
    const to = asString(record.to, `${where}.transitions[${index}].to`)
    if (!states.includes(from) || !states.includes(to))
      throw new Error(
        `x-state-machines.${where}.transitions[${index}] names an unknown state`
      )
    return {
      from,
      to,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {})
    }
  })
  return { field, initial, terminal, states, details, transitions }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`x-state-machines.${where} must be an object`)
  return value as Record<string, unknown>
}

/** Read the `states` map: each key is a state value, each value its labels and hover
 * description. Every field is required, so a state cannot be added without saying what it
 * means. */
function readStates(
  value: unknown,
  where: string
): { states: string[]; details: Record<string, StateDetail> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`x-state-machines.${where} must be a state map`)
  const details: Record<string, StateDetail> = {}
  const states: string[] = []
  for (const [state, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null)
      throw new Error(`x-state-machines.${where}.${state} must be an object`)
    const record = raw as Record<string, unknown>
    details[state] = {
      label: asString(record.label, `${where}.${state}.label`),
      description: asString(record.description, `${where}.${state}.description`)
    }
    states.push(state)
  }
  if (states.length === 0)
    throw new Error(`x-state-machines.${where} must declare at least one state`)
  return { states, details }
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`x-state-machines.${where} must be a string array`)
  return value as string[]
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`x-state-machines.${where} must be a number`)
  return value
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string')
    throw new Error(`x-state-machines.${where} must be a string`)
  return value
}

/** The text fields an overlay may replace. Anything else (states, transitions, reasons, fields)
 * is the contract's structure and stays English-only. */
const TEXT_FIELDS = new Set(['title', 'label', 'description'])

/** The JSONPath forms this tool evaluates: a machine, a state, or one transition picked by its
 * `from`, `to`, and `reason`. Overlay targets may be any RFC 9535 expression; restricting them
 * here keeps every action pointing at exactly one node by name rather than by position. */
const TARGET = new RegExp(
  String.raw`^\$\['x-state-machines'\]\.([\w-]+)(\.step)?` +
    String.raw`(?:\.states\.([\w-]+)|\.transitions\[\?@\.from=='([\w-]+)'\s*&&\s*@\.to=='([\w-]+)'\s*&&\s*(?:@\.reason=='([\w-]+)'|!@\.reason)\])?$`
)

/** Apply an OpenAPI Overlay that translates the state machines' text.
 *
 * It fails rather than skipping: an action that matches no node means the contract changed
 * under the translation; an action that updates a non-text field would change the contract's
 * meaning in one language only; and a text field left untranslated would show English in a
 * translated console. */
export function applyTextOverlay(
  block: Record<string, unknown>,
  document: unknown,
  where: string
): void {
  const overlay = asRecord(document, where)
  if (typeof overlay.overlay !== 'string' || !overlay.overlay.startsWith('1.'))
    throw new Error(`${where} must be an Overlay 1.x document`)
  if (!Array.isArray(overlay.actions))
    throw new Error(`${where} must list actions`)
  const updated = new Map<object, Set<string>>()
  for (const [index, raw] of overlay.actions.entries()) {
    const action = asRecord(raw, `${where} actions[${index}]`)
    const target = asString(action.target, `${where} actions[${index}].target`)
    const node = resolveTarget(block, target)
    if (node === undefined)
      throw new Error(`${where}: ${target} matches no node in openapi.yaml`)
    if (updated.has(node))
      throw new Error(`${where}: ${target} is updated by more than one action`)
    const fields = new Set<string>()
    updated.set(node, fields)
    const update = asRecord(action.update, `${where} ${target}.update`)
    for (const [field, value] of Object.entries(update)) {
      if (!TEXT_FIELDS.has(field) || !(field in node))
        throw new Error(
          `${where}: ${target} may only replace the existing title, label, or description, not ${field}`
        )
      if (typeof value !== 'string' || value.trim() === '')
        throw new Error(`${where}: ${target}.${field} must be non-empty text`)
      ;(node as Record<string, unknown>)[field] = value
      fields.add(field)
    }
  }
  // Coverage is per field: a node whose label is translated but whose description is not would
  // still show English in the translated console.
  for (const node of textNodes(block)) {
    const fields = updated.get(node)
    for (const field of TEXT_FIELDS)
      if (field in node && !fields?.has(field))
        throw new Error(
          `${where} has no ${field} translation for ${JSON.stringify(node).slice(0, 80)}`
        )
  }
}

function resolveTarget(
  block: Record<string, unknown>,
  target: string
): object | undefined {
  const match = TARGET.exec(target)
  if (match === null)
    throw new Error(
      `overlay target ${target} is not a machine, state, or transition by from/to/reason`
    )
  const [, axis, step, state, from, to, reason] = match
  const axisNode = block[axis!] as Record<string, unknown> | undefined
  const machine = (step === undefined ? axisNode : axisNode?.step) as
    Record<string, unknown> | undefined
  if (machine === undefined) return undefined
  if (state !== undefined)
    return (machine.states as Record<string, object> | undefined)?.[state]
  if (from === undefined) return machine
  if (!Array.isArray(machine.transitions))
    throw new Error(
      `overlay target ${target} names a machine without transitions`
    )
  const matches = (machine.transitions as Record<string, unknown>[]).filter(
    (edge) =>
      edge.from === from &&
      edge.to === to &&
      (reason === undefined
        ? edge.reason === undefined
        : edge.reason === reason)
  )
  if (matches.length > 1)
    throw new Error(
      `overlay target ${target} matches ${matches.length} transitions`
    )
  return matches[0]
}

/** Every node of the block that carries text an overlay has to translate. */
function textNodes(block: Record<string, unknown>): object[] {
  const nodes: object[] = []
  const visit = (machine: Record<string, unknown>) => {
    if ('title' in machine) nodes.push(machine)
    nodes.push(...Object.values(machine.states as Record<string, object>))
    nodes.push(
      ...(machine.transitions as Record<string, unknown>[]).filter(
        (edge) => 'label' in edge
      )
    )
  }
  for (const axis of AXES) {
    const machine = block[axis] as Record<string, unknown>
    visit(machine)
    if (machine.step !== undefined)
      visit(machine.step as Record<string, unknown>)
  }
  return nodes
}

/** The overlay a language's text comes from, as a repository-relative path; English is the
 * contract itself. */
const OVERLAY_SOURCES: Readonly<Record<Exclude<Language, 'en'>, string>> = {
  zh: 'contracts/review-runs-api/v1/overlays/zh.yaml'
}

/** The source files a rendering reads: the contract, plus the overlay of each other language. */
function sources(languages: readonly Language[]): string[] {
  return [
    'contracts/review-runs-api/v1/openapi.yaml',
    ...languages.flatMap((language) =>
      language === 'en' ? [] : [OVERLAY_SOURCES[language]]
    )
  ]
}

function moduleHeader(languages: readonly Language[]): string {
  return `// Generated from (paths relative to the repository root):
${sources(languages)
  .map((source) => `//   ${source}\n`)
  .join(
    ''
  )}// Do not edit. The contract's \`x-state-machines\` block is the single source of truth;
// this file is its TypeScript view. Change state, transition, or title text there and regenerate
// with \`pnpm --dir contracts/review-runs-api/tools run generate\`.
`
}

/** The rendered module body. Both consumers read the same module: the console shows the text
 * in each language, and Review Runs reads the structure, which is identical across languages. */
async function renderStateMachinesModule(): Promise<string> {
  const machines = `/** The three axis machines, in lifecycle order, with their text in each console language. The
 * structure is identical across languages; only title, label, and description differ. A
 * machine's steps, when it has them, are its \`step\` member. */
export const STATE_MACHINES_BY_LANGUAGE: Readonly<
  Record<Language, readonly StateMachine[]>
> = ${JSON.stringify(
    Object.fromEntries(
      LANGUAGES.map((language) => [language, readStateMachines(language)])
    ),
    null,
    2
  )} as const

/** The machines with the contract's own (English) text. */
export const STATE_MACHINES: readonly StateMachine[] = STATE_MACHINES_BY_LANGUAGE.en

/** The machine for one axis, with its text in \`language\`. */
export function stateMachine(
  axis: CoordinationAxis,
  language: Language = 'en'
): StateMachine {
  const machine = STATE_MACHINES_BY_LANGUAGE[language].find(
    (candidate) => candidate.axis === axis
  )
  if (machine === undefined) throw new Error(\`no state machine for \${axis}\`)
  return machine
}

/** The machine whose states an audit event's \`from_status\` and \`to_status\` name: the axis
 * itself, or its step machine when the event names a step. */
export function machineForEvent(
  event: { axis: CoordinationAxis; step_key: string | null },
  language: Language = 'en'
): MachineBody | undefined {
  const machine = stateMachine(event.axis, language)
  return event.step_key === null ? machine : machine.step
}
`
  const rendered = `${moduleHeader(LANGUAGES)}
export type Language = ${LANGUAGES.map((language) => `'${language}'`).join(' | ')}

export type CoordinationAxis = ${AXES.map((axis) => `'${axis}'`).join(' | ')}

export interface StateTransition {
  from: string
  to: string
  reason?: string
  label?: string
}

export interface StateDetail {
  label: string
  description: string
}

export interface MachineBody {
  field: string
  initial: string
  terminal: string[]
  states: string[]
  details: Record<string, StateDetail>
  transitions: StateTransition[]
}

export interface StateMachine extends MachineBody {
  axis: CoordinationAxis
  order: number
  title: string
  step?: MachineBody
}

${machines}`
  const options = await prettier.resolveConfig(
    path.resolve(
      REPO_ROOT,
      'apps',
      'control-plane-ui',
      'browser',
      'features',
      'runs'
    )
  )
  return await prettier.format(rendered, {
    ...options,
    filepath: path.resolve(
      REPO_ROOT,
      'apps',
      'control-plane-ui',
      'browser',
      'features',
      'runs',
      'state-machines.generated.ts'
    )
  })
}

/** Escape text for a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

/** Mermaid labels are quoted strings, so a `"` in contract or overlay text must be an entity. */
function mermaidText(text: string): string {
  return text.replaceAll('"', '#quot;')
}

/** Mermaid node ids must be unique per graph and cannot be reserved words such as `end`, so
 * each state gets a prefixed id and keeps its value as the visible label. */
function mermaid(machine: MachineBody, prefix: string): string {
  const id = (state: string) => `${prefix}_${state}`
  const lines = ['```mermaid', 'flowchart LR']
  for (const state of machine.states) lines.push(`  ${id(state)}["${state}"]`)
  for (const edge of machine.transitions) {
    const label =
      edge.label === undefined ? '' : `|"${mermaidText(edge.label)}"|`
    lines.push(`  ${id(edge.from)} -->${label} ${id(edge.to)}`)
  }
  lines.push('```')
  return lines.join('\n')
}

/** The fixed words of the Markdown page, per language. Machine, state, and transition text
 * comes from the contract or its overlay; only this frame is written here. */
const PAGE_TEXT = {
  en: {
    language: 'Language: English | [中文](STATE_MACHINES.zh.md)',
    title: 'Review Runs State Machines',
    intro: (axes: string) =>
      `Every Review Runs lifecycle state and allowed transition, rendered from the \`x-state-machines\` block of [openapi.yaml](openapi.yaml). Each run has three axes (${axes}), and a publication is made of steps with their own machine. The same status name can mean different things on different machines, so read a status together with its machine. For example, a publication step's \`failed\` is one failed attempt that can still be retried or reconciled, while an axis's \`failed\` is a final conclusion.`,
    loops:
      'A transition that keeps the same state, such as a takeover or an inconclusive reconciliation, records an audit event without changing the status. "Recorded reason" is the `reason_code` written to the run\'s event log, when the transition has one.',
    step: (title: string) => `${title} step`,
    field: 'Field: ',
    stateHeader: '| State | Label | Role | Meaning |',
    edgeHeader: '| From | To | Transition | Recorded reason |',
    initial: 'initial',
    terminal: 'terminal',
    listSeparator: ', '
  },
  zh: {
    language: '语言：[English](STATE_MACHINES.md) | 中文',
    title: 'Review Runs 状态机',
    intro: (axes: string) =>
      `Review Runs 全部生命周期状态和允许的转换，由 [openapi.yaml](openapi.yaml) 的 \`x-state-machines\` 和中文覆盖层 [overlays/zh.yaml](overlays/zh.yaml) 生成。每个 run 有三条轴（${axes}），一次发布由若干步骤组成，步骤有自己的状态机。同一个状态名在不同状态机上含义可能不同，读状态时要连同它所在的状态机一起看。例如，发布步骤的 \`failed\` 只是一次尝试失败，仍可重试或核对；轴的 \`failed\` 则是最终结论。`,
    loops:
      '保持同一状态的转换（例如接管或核对无结论）只记录审计事件，不改变状态。“记录的原因”是转换写入 run 事件日志的 `reason_code`（如有）。',
    step: (title: string) => `${title}步骤`,
    field: '字段：',
    stateHeader: '| 状态 | 标签 | 角色 | 含义 |',
    edgeHeader: '| 从 | 到 | 转换 | 记录的原因 |',
    initial: '初始',
    terminal: '终止',
    listSeparator: '、'
  }
} as const

function machineSection(
  text: (typeof PAGE_TEXT)[Language],
  heading: string,
  machine: MachineBody,
  prefix: string
): string {
  const states = machine.states
    .map((state) => {
      const role = [
        state === machine.initial ? text.initial : '',
        machine.terminal.includes(state) ? text.terminal : ''
      ]
        .filter((part) => part !== '')
        .join(text.listSeparator)
      const detail = machine.details[state]!
      return `| \`${state}\` | ${cell(detail.label)} | ${role} | ${cell(detail.description)} |`
    })
    .join('\n')
  const transitions = machine.transitions
    .map(
      (edge) =>
        `| \`${edge.from}\` | \`${edge.to}\` | ${cell(edge.label ?? '')} | ${
          edge.reason === undefined ? '' : `\`${edge.reason}\``
        } |`
    )
    .join('\n')
  return `${heading}

${text.field}\`${machine.field}\`

${mermaid(machine, prefix)}

${text.stateHeader}
| --- | --- | --- | --- |
${states}

${text.edgeHeader}
| --- | --- | --- | --- |
${transitions}
`
}

/** The human-readable view of the same block, in one language: per machine a diagram, what each
 * state means, and every allowed transition. Generated so the only place a reader learns what a
 * status means is the contract and its overlay. */
async function renderStateMachinesMarkdown(
  language: Language
): Promise<string> {
  const text = PAGE_TEXT[language]
  const machines = readStateMachines(language)
  const sections = machines.flatMap((machine) => {
    const own = machineSection(
      text,
      `## ${machine.title}`,
      machine,
      machine.axis
    )
    return machine.step === undefined
      ? [own]
      : [
          own,
          machineSection(
            text,
            `## ${text.step(machine.title)}`,
            machine.step,
            `${machine.axis}_step`
          )
        ]
  })
  const rendered = `<!-- Generated from ${sources([language]).join(' and ')} (x-state-machines). Do not edit. Regenerate with \`pnpm --dir contracts/review-runs-api/tools run generate\`. -->

# ${text.title}

${text.language}

${text.intro(machines.map((machine) => `\`${machine.axis}\``).join(text.listSeparator))}

${text.loops}

${sections.join('\n')}`
  return await prettier.format(rendered, { parser: 'markdown' })
}

export function generatedArtifacts(): GeneratedArtifact[] {
  return [
    {
      output: path.resolve(
        REPO_ROOT,
        'contracts',
        'review-runs-api',
        'v1',
        'STATE_MACHINES.md'
      ),
      render: () => renderStateMachinesMarkdown('en')
    },
    {
      output: path.resolve(
        REPO_ROOT,
        'contracts',
        'review-runs-api',
        'v1',
        'STATE_MACHINES.zh.md'
      ),
      render: () => renderStateMachinesMarkdown('zh')
    },
    {
      output: path.resolve(
        REPO_ROOT,
        'apps',
        'control-plane-ui',
        'browser',
        'features',
        'runs',
        'state-machines.generated.ts'
      ),
      render: () => renderStateMachinesModule()
    },
    {
      output: path.resolve(
        REPO_ROOT,
        'services',
        'review-runs',
        'src',
        'state-machines.generated.ts'
      ),
      render: () => renderStateMachinesModule()
    }
  ]
}
