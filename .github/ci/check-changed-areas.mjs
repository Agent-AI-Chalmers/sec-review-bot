// Check the changed-area model against the world outside it.
//
// `.github/ci/changed-areas.yml` is the hand-written list of which changes run which jobs;
// `dorny/paths-filter` reads it directly (see ci.yml). It is the source of truth for *intent* —
// but intent cannot state its own completeness: whether it names every generated artifact, or
// every tracked file, is a fact about the repository, not about the file. That is what this
// checks, plus the one place the workflow must restate the model (below).
//
// What it does NOT do is "make the model trustworthy": the model is trusted as given. What it
// checks is *completeness* — facts about the repository that no file can state about itself:
// that every generated artifact is covered, every tracked file is covered or acknowledged, the
// seam is wired, and no filter is dead (declared with no job, or gated with no declaration).
//
// Run with `node --test .github/ci/check-changed-areas.mjs`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const FILTERS_PATH = path.join(HERE, 'changed-areas.yml')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')

/** Paths that intentionally run no CI job. A tracked file must be covered by an area or listed
 * here; keeping the list beside the check makes "invisible to CI" a reviewable choice rather
 * than an oversight. A glob — not a literal — so a whole added tree is acknowledged once. */
const UNCOVERED = [
  ['assets/**', 'Screenshots and logo; no build consumes them.'],
  [
    'evaluation/**',
    'Committed evaluation data and reports; not executed by a suite (their Markdown is covered by the documentation area).'
  ],
  ['LICENSE', 'License text.'],
  ['AGENTS.md', 'Repository guidance; Markdown, covered by the documentation area.'],
  ['.gitattributes', 'Git attributes; no build reads them.'],
  ['.gitignore', 'Git ignore rules; no build reads them.'],
  ['.dockerignore', 'Docker ignore rules for the root context, which no service uses.']
]

/** Parse the changed-areas file: top-level `area:` keys whose values are scalar glob lists. The
 * format is deliberately narrower than general YAML, but scalar quoting is presentation rather
 * than policy, so both quote styles and unquoted values are accepted. */
function parseChangedAreas(text) {
  const areas = {}
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const areaMatch = line.match(/^([a-z0-9-]+):$/)
    if (areaMatch) {
      current = areaMatch[1]
      areas[current] = []
      continue
    }
    const globMatch = line.match(
      /^-\s*(?:'([^']+)'|"([^"]+)"|([^#\s][^#]*?))$/
    )
    if (globMatch) {
      assert.notEqual(current, null, `a glob appears outside any area: ${raw}`)
      areas[current].push(globMatch[1] ?? globMatch[2] ?? globMatch[3].trim())
      continue
    }
    assert.fail(`unparsable line in changed-areas.yml: ${raw}`)
  }
  return areas
}

/** Translate one glob (with `**` and `*`) into an anchored regex over a repo-relative path. */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\uE000')
    .replace(/\*\*/g, '\uE001')
    .replace(/\*/g, '[^/]*')
    .replace(/\uE000/g, '(?:.*/)?')
    .replace(/\uE001/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** Whether any glob in `globs` matches a repo-relative path. */
function covers(globs, candidate) {
  return globs.some((glob) => globToRegExp(glob).test(candidate))
}

/** The areas a workflow job gates on, read from its `if:` expression. Each gate is
 * `needs.changes.outputs.<area> == 'true'`. */
function areasReferencedByWorkflow(source) {
  return new Set(
    [...source.matchAll(/needs\.changes\.outputs\.([a-z0-9-]+) == 'true'/g)].map(
      (match) => match[1]
    )
  )
}

/** The area names in the `changes` job's `outputs:` map, which the workflow requires as a static
 * map and so has to restate. The model cannot generate it; the test below keeps them in step. */
function declaredChangeOutputs(source) {
  const block = source.match(/^    outputs:\n((?:^      [\w-]+:.*\n)+)/m)
  assert.notEqual(block, null, 'could not find the `changes` job outputs block')
  return new Set([...block[1].matchAll(/^      ([\w-]+):/gm)].map((match) => match[1]))
}

const areas = parseChangedAreas(readFileSync(FILTERS_PATH, 'utf8'))
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8')

test('every area the model declares gates a job, and every gated area is declared', () => {
  const declared = new Set(Object.keys(areas))
  const referenced = areasReferencedByWorkflow(workflowSource)
  for (const area of referenced) {
    assert.ok(declared.has(area), `a job gates on area \`${area}\`, which the model does not declare`)
  }
  for (const area of declared) {
    assert.ok(
      referenced.has(area),
      `the model declares area \`${area}\`, but no job gates on it (its filter would be dead)`
    )
  }
})

test('the changes job exposes exactly the model areas as outputs', () => {
  // A static `outputs:` map is a GitHub Actions requirement, so the workflow has to restate the
  // areas here; this catches the two drifting (an area a job needs but the map does not expose
  // reads as `undefined`). It exists because of the restatement — `dorny/paths-filter`'s `changes`
  // JSON output would remove it, at the cost of a `contains(fromJSON(...))` in every `if:`.
  assert.deepEqual([...declaredChangeOutputs(workflowSource)].sort(), Object.keys(areas).sort())
})

test("every contract tool's generated artifact is covered by the contract-tools area", () => {
  // The staleness check runs in the contract-tools job, so its filter must fire for a hand edit
  // of any artifact the tools produce — including projections that land in other packages. The
  // required set is derived from the tools' manifests, so a new projection cannot be added
  // without this area being wired to it.
  const manifests = [
    'contracts/review-runs-api/tools/generated-artifacts.json',
    'contracts/execution-api/tools/generated-artifacts.json',
    'contracts/memory-catalog-api/tools/generated-artifacts.json'
  ]
  const outputs = manifests.flatMap((manifestPath) => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, manifestPath), 'utf8'))
    if (Array.isArray(manifest.generators))
      return manifest.generators.flatMap((generator) => generator.outputs)
    if (Array.isArray(manifest.artifacts))
      return manifest.artifacts.map((artifact) =>
        path.normalize(path.join(path.dirname(manifestPath), artifact.output))
      )
    assert.fail(`${manifestPath} has no generated artifact entries`)
  })
  assert.ok(outputs.length > 0, 'expected at least one generated artifact')
  for (const output of outputs) {
    assert.ok(
      covers(areas['contract-tools'], output),
      `the contract-tools area does not cover generated artifact ${output}; a hand edit of it ` +
        'would run no job that detects the drift'
    )
  }
})

test('the client<->server seam stays wired to both packages', () => {
  // The seam test lives in Review Runs but drives the GitHub-integration client, so a change
  // to either side must re-run it. This coupling is why the seam is listed under both areas, and
  // its absence is what let the empty-200 bug land.
  const seamPaths = [
    'apps/github-integration/src/review-runs/client.ts',
    'apps/github-integration/src/review-runs/review-runs-api.ts'
  ]
  for (const candidate of seamPaths) {
    assert.ok(
      covers(areas['review-runs'], candidate),
      `the review-runs area must trigger on ${candidate} (the seam test loads it)`
    )
    assert.ok(
      covers(areas['github-integration'], candidate),
      `the github-integration area must trigger on ${candidate}`
    )
  }
})

test('the Execution Workflow contract triggers the Gateway job', () => {
  const schema =
    'contracts/execution-workflow/v1/execution-workflow-input.schema.json'
  assert.ok(
    covers(areas['execution-gateway'], schema),
    `the execution-gateway area must trigger on ${schema}`
  )
})

test('every tracked file is covered by an area or declared as intentionally uncovered', () => {
  // A tracked file no area covers — and that `UNCOVERED` does not name — is invisible to CI:
  // changing it runs nothing, with no record that the silence was intended. This catches a new
  // top-level tree added without wiring it up, rather than letting it default to green.
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
  const allGlobs = Object.values(areas).flat()
  const invisible = files.filter(
    (file) => !covers(allGlobs, file) && !covers(UNCOVERED.map(([glob]) => glob), file)
  )
  assert.deepEqual(
    invisible,
    [],
    `these tracked files are neither covered by an area nor listed in UNCOVERED, so a change to ` +
      `them would run no job: ${invisible.slice(0, 20).join(', ')}${
        invisible.length > 20 ? ' …' : ''
      }`
  )
})
