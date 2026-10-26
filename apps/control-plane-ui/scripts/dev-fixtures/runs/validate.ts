import type { FixtureRun, FixtureStep } from './generate.js'

export function validateRun(
  run: FixtureRun,
  steps: readonly FixtureStep[]
): void {
  const fail = (reason: string): never => {
    throw new Error(
      `dev fixture ${run.run_id} describes an unreachable run: ${reason}`
    )
  }
  const execution = run.execution.status
  const preparation = run.preparation
  const publication = run.publication.status
  // `uncertain` and `disconnected` are mid-phase states, so a publication that reports one has
  // necessarily started: the axis reflects a step that may already have taken effect remotely.
  const startedPublication = [
    'publishing',
    'uncertain',
    'disconnected',
    'published',
    'failed'
  ].includes(publication)

  // Each axis records a start and an end, and the fixture must respect the same rules the store
  // enforces: a start exists once the phase has begun, an end exists once it is terminal, and
  // neither may be present on a phase that never got that far.
  const preparationStarted = preparation.status !== 'pending'
  if ((preparation.started_at !== null) !== preparationStarted) {
    fail('preparation.started_at is set exactly when the phase has begun')
  }
  const preparationFinished =
    preparation.status === 'submitted' || preparation.status === 'failed'
  if ((preparation.finished_at !== null) !== preparationFinished) {
    fail('preparation.finished_at is set exactly when the phase is terminal')
  }
  if (
    (run.execution.finished_at !== null) !==
    (execution === 'succeeded' ||
      execution === 'failed' ||
      execution === 'skipped')
  ) {
    fail('execution_finished_at is set exactly when the execution is terminal')
  }
  // `skipped` ends the axis without starting it: preparation failed before the Execution Gateway was ever
  // called, so there is an end but no `execution.started_at`. Every other terminal state ran.
  if (run.execution.finished_at !== null && execution !== 'skipped') {
    if (run.execution.started_at === null) {
      fail('an execution that ran to a terminal state must also have started')
    }
  }
  if (execution === 'skipped' && run.execution.started_at !== null) {
    fail('a skipped execution was never submitted, so it has no start')
  }
  if ((run.publication.started_at !== null) !== startedPublication) {
    fail('publication_started_at is set exactly when the publication has begun')
  }

  if (startedPublication && execution !== 'succeeded') {
    fail(`publication ${publication} requires a succeeded execution`)
  }
  const startedAt = Date.parse(run.created_at)
  for (const [name, value] of [
    ['preparation.started_at', preparation.started_at],
    ['preparation.finished_at', preparation.finished_at],
    ['execution.started_at', run.execution.started_at],
    ['execution_finished_at', run.execution.finished_at],
    ['publication_started_at', run.publication.started_at]
  ] as const) {
    if (value !== null && Date.parse(value) < startedAt) {
      fail(`${name} must not precede created_at`)
    }
  }
  if (
    preparation.started_at !== null &&
    preparation.finished_at !== null &&
    Date.parse(preparation.finished_at) < Date.parse(preparation.started_at)
  ) {
    fail('preparation must not end before it started')
  }
  if (
    preparation.started_at !== null &&
    Date.parse(preparation.updated_at) < Date.parse(preparation.started_at)
  ) {
    fail('preparation.updated_at must not precede preparation.started_at')
  }
  if (
    run.execution.started_at !== null &&
    run.execution.finished_at !== null &&
    Date.parse(run.execution.finished_at) < Date.parse(run.execution.started_at)
  ) {
    fail('execution must not end before it was submitted')
  }
  if (execution === 'succeeded' && publication === 'skipped') {
    fail('a succeeded execution always has a publication to perform')
  }
  if (
    (execution === 'failed' || execution === 'skipped') &&
    publication !== 'skipped'
  ) {
    fail('a terminal execution leaves nothing to publish')
  }
  if (execution === 'skipped' && preparation.status !== 'failed') {
    fail('execution is skipped only when preparation failed before it ran')
  }
  if (
    (execution === 'uncertain' || execution === 'disconnected') &&
    publication !== 'pending'
  ) {
    // An unconfirmed submission may still be accepted, so it is not yet a conclusion that
    // nothing is publishable. Publication must stay `pending`; only a conclusive failure may
    // skip it, and the state machine has no `skipped -> pending` edge to undo an early skip.
    fail('an unconfirmed submission keeps its publication pending')
  }
  // A blocked run is the deliberate exception: coordination found preparation unfinished while
  // execution had already advanced, which is exactly the contradiction it refuses to resolve on
  // its own. That state is unreachable by a normal write path but reachable by a partial repair,
  // and the console has to be able to render it, so the fixture models it here.
  if (
    preparation.status !== 'submitted' &&
    execution !== 'pending' &&
    execution !== 'skipped' &&
    preparation.disconnect_reason === null
  ) {
    fail('only a pending or skipped run can have unfinished preparation')
  }
  if (preparation.status === 'failed' && execution !== 'skipped') {
    fail('a terminal preparation failure skips execution')
  }
  // `preparation_notice` is only meaningful while preparation is failed, exactly as `step`
  // is only meaningful once a publication has started: a scenario may name either without
  // the other, so the pairing is checked here rather than in the type.
  // A notice is queued by whichever axis ended the run, so the pairing is with the run being
  // over, not with preparation having failed. A run whose execution failed carries an execution
  // notice even though its preparation completed normally.
  const failedAxis =
    preparation.status === 'failed'
      ? 'preparation'
      : execution === 'failed'
        ? 'execution'
        : null
  if (failedAxis !== null && run.notices.length === 0) {
    fail(
      'a run that failed on an axis names the stage its failure notice reached'
    )
  }
  // A parked run is not a failed run, but the requester is still told that automation stopped,
  // so an attention notice exists for exactly those two parked states and nothing else.
  if (
    failedAxis === null &&
    execution !== 'disconnected' &&
    publication !== 'disconnected' &&
    run.notices.length > 0
  ) {
    fail('only a failed or disconnected run has a notice')
  }
  if (
    run.notices.length > 0 &&
    failedAxis !== null &&
    run.notices[0]?.axis !== failedAxis
  ) {
    fail('a failure notice names the axis that actually failed')
  }
  if (execution === 'disconnected') {
    const notice = run.notices[0]
    if (
      run.notices.length !== 1 ||
      notice?.kind !== 'attention' ||
      notice.axis !== 'execution' ||
      notice.reason_code !== 'SUBMISSION_RECOVERY_EXHAUSTED'
    ) {
      fail('a disconnected execution queues one execution attention notice')
    }
  }
  if (publication === 'disconnected') {
    const notice = run.notices[0]
    if (
      run.notices.length !== 1 ||
      notice?.kind !== 'attention' ||
      notice.axis !== 'publication'
    ) {
      fail('a disconnected publication queues one publication attention notice')
    }
  }
  if (
    preparation.status === 'submitted' &&
    ![
      'uncertain',
      'disconnected',
      'queued',
      'running',
      'succeeded',
      'failed'
    ].includes(execution)
  ) {
    fail(
      'a submitted preparation means the run has moved on to the Execution Gateway lifecycle'
    )
  }
  if (
    run.artifact_storage !== null &&
    !['succeeded', 'failed'].includes(execution)
  ) {
    fail('the diagnostic artifact is only reported at execution terminal')
  }
  const failedOnAnAxis =
    execution === 'failed' ||
    execution === 'skipped' ||
    publication === 'failed'
  if (failedOnAnAxis && run.failure_code === null) {
    fail('a terminal failure carries its failure code')
  }
  if (
    run.failure_code !== null &&
    !failedOnAnAxis &&
    execution !== 'uncertain' &&
    execution !== 'disconnected' // an unconfirmed submission keeps its code
  ) {
    fail(
      'only a terminal failure or unconfirmed submission carries a failure code'
    )
  }
  if (run.created_at > run.execution.updated_at) {
    fail('execution.updated_at must not precede created_at')
  }
  if (
    (execution === 'pending' ||
      execution === 'uncertain' ||
      execution === 'disconnected' ||
      execution === 'skipped') !==
    (run.execution.started_at === null)
  ) {
    fail(
      'an unaccepted, pending, or skipped execution has no execution.started_at, and every other state has one'
    )
  }
  if (
    run.execution.started_at !== null &&
    run.execution.started_at < run.created_at
  ) {
    fail('execution.started_at must not precede created_at')
  }
  if (
    run.execution.started_at !== null &&
    run.execution.started_at > run.execution.updated_at
  ) {
    fail('execution.started_at must not follow execution.updated_at')
  }
  if (run.publication.finished_at !== null) {
    if (run.publication.finished_at < run.created_at) {
      fail('publication_finished_at must not precede created_at')
    }
    if (
      run.publication.started_at !== null &&
      run.publication.finished_at < run.publication.started_at
    ) {
      fail('a publication must not end before it started')
    }
  }
  if (
    run.publication.started_at !== null &&
    run.publication.started_at < run.execution.updated_at
  ) {
    fail('a started publication must not precede the execution it publishes')
  }
  // `updated_at` is the axis' write time, so it can never precede the start it moved past, and
  // it is what a running publication advances while its bounds stay fixed.
  if (run.publication.started_at !== null) {
    if (run.publication.updated_at < run.publication.started_at) {
      fail('publication.updated_at must not precede publication.started_at')
    }
    if (
      publication === 'publishing' &&
      run.publication.updated_at === run.publication.started_at
    ) {
      fail(
        'a running publication keeps being written, so updated_at moves past its start'
      )
    }
  }
  // A finished publication exists exactly for the terminal outcomes; a skipped one never
  // started, so it has an end but no start.
  const publicationFinished =
    publication === 'published' ||
    publication === 'failed' ||
    publication === 'skipped'
  if ((run.publication.finished_at !== null) !== publicationFinished) {
    fail(
      'publication_finished_at is set exactly when the publication is terminal'
    )
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      run.run_id
    )
  ) {
    fail('run ids are UUID v4, as Review Runs assigns them')
  }

  if (steps.length > 0 && !startedPublication) {
    fail('publication steps only exist once the publication has started')
  }
  if (startedPublication && steps.length === 0) {
    fail('a started publication always has steps')
  }
  if (
    publication === 'published' &&
    steps.some((step) => step.status !== 'succeeded')
  ) {
    fail('a published run has only succeeded steps')
  }
  if (
    publication === 'publishing' &&
    steps.every((step) => step.status === 'succeeded')
  ) {
    fail('a publishing run still has work outstanding')
  }
  if (
    publication === 'failed' &&
    steps.filter((step) => step.status === 'terminal_failed').length !== 1
  ) {
    fail('a failed publication has exactly one terminal step')
  }
}

/** A stand-in for the comment URL GitHub returns when the notice is delivered.
 *
 * Only a delivered notice has one: it is the comment the requester can open, and inventing one
 * for a pending or failed delivery would show a link that goes nowhere.
 */
