// Generated from (paths relative to the repository root):
//   contracts/review-runs-api/v1/openapi.yaml
//   contracts/review-runs-api/v1/overlays/zh.yaml
// Do not edit. The contract's `x-state-machines` block is the single source of truth;
// this file is its TypeScript view. Change state, transition, or title text there and regenerate
// with `pnpm --dir contracts/review-runs-api/tools run generate`.

export type Language = 'en' | 'zh'

export type CoordinationAxis = 'preparation' | 'execution' | 'publication'

export interface StateTransition {
  from: string
  to: string
  reason?: string
  label?: string
}

export interface StateDetail {
  label: string
  summary: string
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

/** The three axis machines, in lifecycle order, with their text in each console language. The
 * structure is identical across languages; only title, label, summary, and description differ. A
 * machine's steps, when it has them, are its `step` member. */
export const STATE_MACHINES_BY_LANGUAGE: Readonly<Record<Language, readonly StateMachine[]>> = {
  en: [
    {
      axis: 'preparation',
      order: 1,
      title: 'Preparation',
      field: 'preparation.status',
      initial: 'pending',
      terminal: ['submitted', 'failed'],
      states: ['pending', 'preparing', 'uncertain', 'disconnected', 'submitted', 'failed'],
      details: {
        pending: {
          label: 'Pending',
          summary: 'The run was accepted and is waiting for input preparation to start.',
          description: 'Admitted, but no preparer has claimed the work yet.'
        },
        preparing: {
          label: 'Preparing',
          summary: 'Review input is being prepared.',
          description: 'A coordinator currently owns the claim and is building the Execution input.'
        },
        uncertain: {
          label: 'Uncertain',
          summary:
            'Preparation claim expired; saved input is unconfirmed. Recovery can resubmit under the same run identity.',
          description:
            'The claim lapsed before the preparer reported, so it is unknown whether the prepared input reached Review Runs. This is not a failure: a claim may rebuild the input and resubmit it under the same identity, which is idempotent.'
        },
        disconnected: {
          label: 'Disconnected',
          summary:
            'Conflicting preparation and execution records stopped recovery. Manual review is required.',
          description:
            "Automatic work stopped without a conclusion, because the run's persisted state no longer admits the only transition expiry could make. Nothing retries this row on its own; an operator resumes it into `uncertain`, gives it up, or abandons it."
        },
        submitted: {
          label: 'Submitted',
          summary: 'Input is ready and has been submitted for execution.',
          description:
            'The input was accepted and handed to the Execution API provider; preparation is done.'
        },
        failed: {
          label: 'Failed',
          summary:
            'Preparation failed permanently or was stopped manually. Failure skips execution; manual closure may leave a remote task running.',
          description:
            'Preparation ended without a usable result, in one of two ways: (1) it failed for good (retry budget exhausted, or the input could not be built), so the Execution API provider was never handed input and execution is skipped; (2) an operator gave up on or abandoned a disconnected preparation. After an operator decision the input may already have been submitted, and the task may still be running remotely.'
        }
      },
      transitions: [
        {
          from: 'pending',
          to: 'preparing',
          label: 'claimed'
        },
        {
          from: 'preparing',
          to: 'submitted',
          label: 'input accepted'
        },
        {
          from: 'preparing',
          to: 'pending',
          label: 'retry'
        },
        {
          from: 'preparing',
          to: 'uncertain',
          label: 'claim lapsed'
        },
        {
          from: 'uncertain',
          to: 'preparing',
          label: 'reclaim to confirm'
        },
        {
          from: 'preparing',
          to: 'disconnected',
          reason: 'EXECUTION_ALREADY_ADVANCED',
          label: 'cannot be concluded automatically'
        },
        {
          from: 'disconnected',
          to: 'uncertain',
          reason: 'PREPARATION_RESUMED_BY_OPERATOR',
          label: 'resumed by an operator'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PREPARATION_GIVEN_UP_BY_OPERATOR',
          label: 'given up by an operator'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PREPARATION_ABANDONED_BY_OPERATOR',
          label: 'abandoned by an operator'
        },
        {
          from: 'preparing',
          to: 'failed',
          label: 'failed'
        }
      ]
    },
    {
      axis: 'execution',
      order: 2,
      title: 'Execution',
      field: 'execution.status',
      initial: 'pending',
      terminal: ['succeeded', 'skipped', 'failed'],
      states: [
        'pending',
        'queued',
        'running',
        'succeeded',
        'skipped',
        'uncertain',
        'disconnected',
        'failed'
      ],
      details: {
        pending: {
          label: 'Pending',
          summary: 'Waiting for prepared input to be submitted to the execution service.',
          description:
            'Admitted, but its prepared input has not been submitted to the Execution API provider yet.'
        },
        queued: {
          label: 'Queued',
          summary: 'The execution service accepted the task. It has not yet been observed running.',
          description:
            'The Execution API provider accepted the submission; polling has not yet seen it start.'
        },
        running: {
          label: 'Running',
          summary:
            'Last reported running. Temporary polling errors keep that status, which may be out of date.',
          description:
            'Polling observed that the Execution API provider is executing this run. A transient network blip while polling does not change this state: the run keeps the last observed value and is polled again, so this state may be slightly out of date.'
        },
        succeeded: {
          label: 'Succeeded',
          summary:
            'The execution service returned a successful result. It is ready for publication.',
          description:
            'The Execution API provider returned a result; it now becomes eligible for publication.'
        },
        skipped: {
          label: 'Skipped',
          summary:
            'Preparation failed, so execution was skipped. See the preparation failure for the cause.',
          description:
            'Execution never ran because preparation failed. This is not an execution failure; the reason is on the preparation axis.'
        },
        uncertain: {
          label: 'Uncertain',
          summary: 'Acceptance is unconfirmed. Recovery resubmits under the same run identity.',
          description:
            'The task was submitted, but no response arrived, so it is unknown whether the Execution API provider accepted it. This is not a failure: the submission is replayed under the same run_id.'
        },
        disconnected: {
          label: 'Disconnected',
          summary:
            'Recovery retries ran out; acceptance remains unknown. Manual review is required, not a failure conclusion.',
          description:
            'Automatic recovery used its budget without a conclusive Execution API provider answer. The run is visible for operator action and is not reported as failed.'
        },
        failed: {
          label: 'Failed',
          summary:
            'Tracking ended after failure, an unusable result, or an operator decision. Stopping the wait does not cancel remote work.',
          description:
            "This run no longer tracks the task, in one of two ways: (1) a definite failure, where polling produced a conclusive answer that the task cannot succeed (the Execution API provider reported it failed, or the run could not be found, returned no result, or the response broke the protocol) or a retried submission failed conclusively; (2) an operator gave up on a disconnected execution or abandoned the run's preparation. After an operator decision no cancellation is sent, so the task may still be running or may succeed remotely. A transient network error (a timeout, a 5xx, a dropped connection) is not a definite failure."
        }
      },
      transitions: [
        {
          from: 'pending',
          to: 'queued',
          label: 'input submitted'
        },
        {
          from: 'pending',
          to: 'skipped',
          label: 'preparation failed'
        },
        {
          from: 'pending',
          to: 'uncertain',
          reason: 'SUBMISSION_STATE_UNCERTAIN',
          label: 'submission unconfirmed'
        },
        {
          from: 'uncertain',
          to: 'uncertain',
          reason: 'SUBMISSION_RECOVERY_CLAIMED',
          label: 'replay claimed'
        },
        {
          from: 'uncertain',
          to: 'queued',
          label: 'replay accepted'
        },
        {
          from: 'uncertain',
          to: 'failed',
          label: 'replay rejected'
        },
        {
          from: 'uncertain',
          to: 'disconnected',
          reason: 'SUBMISSION_RECOVERY_EXHAUSTED',
          label: 'recovery disconnected'
        },
        {
          from: 'disconnected',
          to: 'uncertain',
          reason: 'SUBMISSION_RECOVERY_RESUMED_BY_OPERATOR',
          label: 'resumed by an operator'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'SUBMISSION_RECOVERY_GIVEN_UP_BY_OPERATOR',
          label: 'given up by an operator'
        },
        {
          from: 'queued',
          to: 'running',
          label: 'execution started'
        },
        {
          from: 'queued',
          to: 'succeeded',
          label: 'execution succeeded'
        },
        {
          from: 'running',
          to: 'succeeded',
          label: 'execution succeeded'
        },
        {
          from: 'queued',
          to: 'failed',
          label: 'polling concluded failure'
        },
        {
          from: 'running',
          to: 'failed',
          label: 'polling concluded failure'
        }
      ]
    },
    {
      axis: 'publication',
      order: 3,
      title: 'Publication',
      field: 'publication.status',
      initial: 'pending',
      terminal: ['published', 'failed', 'skipped'],
      states: [
        'pending',
        'publishing',
        'uncertain',
        'disconnected',
        'published',
        'failed',
        'skipped'
      ],
      details: {
        pending: {
          label: 'Pending',
          summary: 'Waiting for a successful execution result to publish.',
          description: 'Waiting for a successful execution result before publishing.'
        },
        publishing: {
          label: 'Publishing',
          summary: 'Review results are being published.',
          description:
            'A coordinator owns the publication claim and is performing the side effects.'
        },
        uncertain: {
          label: 'Uncertain',
          summary:
            'A step may have taken effect and is being checked. Other steps can continue; failure is not established.',
          description:
            'A step may have completed its side effect remotely and is being reconciled. The axis reflects its strongest step; this is not a failure, and other steps keep publishing.'
        },
        disconnected: {
          label: 'Disconnected',
          summary:
            'Automatic checks stopped without confirming a step. Manual review of the remote result is required.',
          description:
            'Automatic reconciliation of a step stopped without an answer, so an operator has to establish what is on the remote system. The axis reflects its strongest step.'
        },
        published: {
          label: 'Published',
          summary: 'All publication steps succeeded. The results are available.',
          description: 'All publication steps succeeded; the result is visible.'
        },
        failed: {
          label: 'Failed',
          summary:
            'Publication failed or was stopped manually; some steps may have taken effect. Retryable failures requeue instead.',
          description:
            'Publishing ended in failure, either because its owner concluded it as failed (for example after a terminal failure or with steps that did not succeed) or because an operator gave up. A retryable failure returns to `pending` instead.'
        },
        skipped: {
          label: 'Skipped',
          summary: 'No result will be published because execution did not succeed.',
          description: 'There was nothing to publish because execution did not succeed.'
        }
      },
      transitions: [
        {
          from: 'pending',
          to: 'publishing',
          label: 'publishing started'
        },
        {
          from: 'pending',
          to: 'uncertain',
          label: 'publishing resumed with an unresolved step'
        },
        {
          from: 'uncertain',
          to: 'uncertain',
          reason: 'PUBLICATION_LEASE_EXPIRED',
          label: 'reconciliation lease expired'
        },
        {
          from: 'publishing',
          to: 'uncertain',
          label: 'a step may have taken effect'
        },
        {
          from: 'uncertain',
          to: 'publishing',
          label: 'step settled'
        },
        {
          from: 'uncertain',
          to: 'disconnected',
          label: 'reconciliation could not conclude'
        },
        {
          from: 'disconnected',
          to: 'pending',
          reason: 'PUBLICATION_RESUMED_BY_OPERATOR',
          label: 'resumed by an operator'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PUBLICATION_GIVEN_UP_BY_OPERATOR',
          label: 'given up by an operator'
        },
        {
          from: 'publishing',
          to: 'published',
          label: 'published'
        },
        {
          from: 'publishing',
          to: 'publishing',
          reason: 'PUBLICATION_LEASE_EXPIRED',
          label: 'publishing lease expired'
        },
        {
          from: 'publishing',
          to: 'pending',
          label: 'retryable failure'
        },
        {
          from: 'publishing',
          to: 'failed',
          label: 'terminal failure'
        },
        {
          from: 'uncertain',
          to: 'pending',
          label: 'retryable failure'
        },
        {
          from: 'uncertain',
          to: 'failed',
          label: 'terminal failure'
        },
        {
          from: 'pending',
          to: 'skipped',
          label: 'execution not published'
        },
        {
          from: 'publishing',
          to: 'skipped',
          reason: 'PUBLICATION_ABANDONED',
          label: 'execution failed'
        }
      ],
      step: {
        field: 'ObservedPublicationStep.status',
        initial: 'pending',
        terminal: ['succeeded', 'terminal_failed'],
        states: [
          'pending',
          'running',
          'failed',
          'uncertain',
          'disconnected',
          'succeeded',
          'terminal_failed'
        ],
        details: {
          pending: {
            label: 'Pending',
            summary: 'Not attempted, or manually requeued with retry and recovery limits reset.',
            description:
              'Not attempted yet, or returned to the queue with fresh budgets by an operator.'
          },
          running: {
            label: 'Running',
            summary: 'An attempt started and may have taken effect, even if its process stopped.',
            description:
              'An attempt started. Its owner may still be performing the side effect, or may have died after performing it, so a later claim cannot assume nothing happened.'
          },
          failed: {
            label: 'Attempt failed',
            summary:
              'The last attempt failed. Retry while attempts remain; otherwise check the remote result before concluding.',
            description:
              'The last attempt failed. The system retries while attempts remain; once they are exhausted, it checks the remote result before concluding.'
          },
          uncertain: {
            label: 'Uncertain',
            summary:
              'No attempts remain; an earlier one may have taken effect. Check the remote result before concluding.',
            description:
              'The attempt budget is spent, but any started attempt may have taken effect remotely, so the connector must reconcile against the remote system before the step can conclude.'
          },
          disconnected: {
            label: 'Disconnected',
            summary: 'Checks ran out; the remote result needs manual confirmation.',
            description:
              'Reconciliation used its budget without an answer. An operator has to establish what is on the remote system.'
          },
          succeeded: {
            label: 'Succeeded',
            summary: 'The remote change was made successfully or confirmed by a later check.',
            description:
              'The side effect exists, either written by an attempt or found by reconciliation.'
          },
          terminal_failed: {
            label: 'Terminal failure',
            summary:
              'No more retries: a permanent failure occurred, or the remote change was confirmed absent.',
            description:
              'The step will not be attempted again: an attempt failed terminally, or reconciliation confirmed that the side effect is absent.'
          }
        },
        transitions: [
          {
            from: 'pending',
            to: 'running',
            label: 'attempt started'
          },
          {
            from: 'running',
            to: 'running',
            label: 'taken over by another process'
          },
          {
            from: 'failed',
            to: 'running',
            label: 'retry started'
          },
          {
            from: 'running',
            to: 'succeeded',
            label: 'side effect written'
          },
          {
            from: 'running',
            to: 'failed',
            label: 'retryable failure'
          },
          {
            from: 'running',
            to: 'terminal_failed',
            label: 'terminal failure'
          },
          {
            from: 'running',
            to: 'uncertain',
            label: 'attempts exhausted'
          },
          {
            from: 'failed',
            to: 'uncertain',
            label: 'attempts exhausted'
          },
          {
            from: 'uncertain',
            to: 'succeeded',
            label: 'reconciled present'
          },
          {
            from: 'uncertain',
            to: 'terminal_failed',
            label: 'reconciled absent or terminal failure'
          },
          {
            from: 'uncertain',
            to: 'uncertain',
            label: 'reconciliation inconclusive'
          },
          {
            from: 'uncertain',
            to: 'disconnected',
            label: 'reconciliation budget spent'
          },
          {
            from: 'uncertain',
            to: 'failed',
            label: 'failure reported without retry'
          },
          {
            from: 'disconnected',
            to: 'pending',
            reason: 'PUBLICATION_RESUMED_BY_OPERATOR',
            label: 'resumed by an operator'
          }
        ]
      }
    }
  ],
  zh: [
    {
      axis: 'preparation',
      order: 1,
      title: '准备',
      field: 'preparation.status',
      initial: 'pending',
      terminal: ['submitted', 'failed'],
      states: ['pending', 'preparing', 'uncertain', 'disconnected', 'submitted', 'failed'],
      details: {
        pending: {
          label: '等待中',
          summary: '运行已接收，等待准备审查输入。',
          description: '运行已接收，尚无准备进程领取任务。'
        },
        preparing: {
          label: '准备中',
          summary: '正在准备审查输入。',
          description: '协调进程已领取准备任务，正在构建执行所需的输入。'
        },
        uncertain: {
          label: '待确认',
          summary: '准备认领已过期，输入是否已保存待确认；可用同一运行标识重新提交。',
          description:
            '准备进程尚未报告结果，认领就已过期，因此无法确认准备好的输入是否已送达 Review Runs。这不表示准备失败。任务可被重新领取，并使用同一运行标识重建、提交输入；重复提交是幂等的。'
        },
        disconnected: {
          label: '失联',
          summary: '准备与执行记录冲突，自动恢复已停止，需人工核查。',
          description:
            '已保存的运行状态不允许执行认领过期时应有的状态转换，因此自动处理已停止，尚无最终结论。系统不会自行重试；管理员可将其恢复为 `uncertain`、放弃等待或作废运行。'
        },
        submitted: {
          label: '已提交',
          summary: '输入已准备完成并提交执行。',
          description: '输入已被接受并提交给 Execution API 提供方，准备阶段已完成。'
        },
        failed: {
          label: '失败',
          summary: '准备已永久失败或由人工结束。永久失败会跳过执行；人工结束后远端任务仍可能继续。',
          description:
            '准备阶段已结束，未得到可用结果。可能是准备永久失败（重试次数用尽或无法构建输入），此时输入从未提交给 Execution API 提供方，执行会被跳过；也可能是管理员对失联的准备任务选择放弃等待或作废运行，此时输入可能已经提交，任务可能仍在远端执行。'
        }
      },
      transitions: [
        {
          from: 'pending',
          to: 'preparing',
          label: '已领取'
        },
        {
          from: 'preparing',
          to: 'submitted',
          label: '输入已被接受'
        },
        {
          from: 'preparing',
          to: 'pending',
          label: '重试'
        },
        {
          from: 'preparing',
          to: 'uncertain',
          label: '认领过期'
        },
        {
          from: 'uncertain',
          to: 'preparing',
          label: '重新领取准备任务'
        },
        {
          from: 'preparing',
          to: 'disconnected',
          reason: 'EXECUTION_ALREADY_ADVANCED',
          label: '无法自动结束准备'
        },
        {
          from: 'disconnected',
          to: 'uncertain',
          reason: 'PREPARATION_RESUMED_BY_OPERATOR',
          label: '由管理员恢复'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PREPARATION_GIVEN_UP_BY_OPERATOR',
          label: '由管理员放弃等待'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PREPARATION_ABANDONED_BY_OPERATOR',
          label: '由管理员作废'
        },
        {
          from: 'preparing',
          to: 'failed',
          label: '失败'
        }
      ]
    },
    {
      axis: 'execution',
      order: 2,
      title: '执行',
      field: 'execution.status',
      initial: 'pending',
      terminal: ['succeeded', 'skipped', 'failed'],
      states: [
        'pending',
        'queued',
        'running',
        'succeeded',
        'skipped',
        'uncertain',
        'disconnected',
        'failed'
      ],
      details: {
        pending: {
          label: '等待中',
          summary: '等待将准备好的输入提交给执行服务。',
          description: '运行已接收，准备好的输入尚未提交给 Execution API 提供方。'
        },
        queued: {
          label: '排队中',
          summary: '执行服务已接受任务，尚未观察到任务开始执行。',
          description: 'Execution API 提供方已接受任务，轮询尚未发现任务开始执行。'
        },
        running: {
          label: '执行中',
          summary: '最近报告为执行中；查询暂时失败时保留原状态，显示可能滞后。',
          description:
            '轮询结果表明，Execution API 提供方正在执行该任务。轮询期间出现临时网络错误时，系统会保留上次获取的状态并继续查询，因此显示的状态可能滞后。'
        },
        succeeded: {
          label: '执行成功',
          summary: '执行服务已返回成功结果，可以开始发布。',
          description: 'Execution API 提供方已返回结果，可以开始发布。'
        },
        skipped: {
          label: '已跳过',
          summary: '准备失败，执行已跳过。具体原因见准备阶段的失败信息。',
          description: '准备失败，执行未开始。失败原因记录在准备轴上，不属于执行失败。'
        },
        uncertain: {
          label: '待确认',
          summary: '任务是否已被接受待确认；系统会用同一运行标识重新提交。',
          description:
            '任务已提交，但未收到响应，无法确认 Execution API 提供方是否已接受任务。这不表示执行失败；系统会使用同一个 run_id 重新提交。'
        },
        disconnected: {
          label: '失联',
          summary: '恢复次数已用尽，提交结果仍未知，需人工核查；不代表执行失败。',
          description:
            '自动恢复次数已用尽，Execution API 提供方仍未给出确定答复。该运行将等待管理员处理，不会被记为失败。'
        },
        failed: {
          label: '失败',
          summary: '因失败、结果不可用或人工决定而停止跟踪；停止等待不会取消远端任务。',
          description:
            '该运行已停止跟踪执行状态。可能是轮询确认了失败（Execution API 提供方报告失败、找不到运行、未返回结果或响应违反协议），或重新提交时收到确定的失败答复；也可能是管理员对失联的执行选择放弃等待，或作废了准备阶段。管理员的这些操作不会发送取消请求，远端任务仍可能继续执行并成功。临时网络错误（超时、5xx、连接中断）不属于确定的失败。'
        }
      },
      transitions: [
        {
          from: 'pending',
          to: 'queued',
          label: '输入已提交'
        },
        {
          from: 'pending',
          to: 'skipped',
          label: '准备失败'
        },
        {
          from: 'pending',
          to: 'uncertain',
          reason: 'SUBMISSION_STATE_UNCERTAIN',
          label: '提交未得到确认'
        },
        {
          from: 'uncertain',
          to: 'uncertain',
          reason: 'SUBMISSION_RECOVERY_CLAIMED',
          label: '领取重新提交任务'
        },
        {
          from: 'uncertain',
          to: 'queued',
          label: '重新提交已被接受'
        },
        {
          from: 'uncertain',
          to: 'failed',
          label: '重新提交被拒绝'
        },
        {
          from: 'uncertain',
          to: 'disconnected',
          reason: 'SUBMISSION_RECOVERY_EXHAUSTED',
          label: '自动恢复已停止'
        },
        {
          from: 'disconnected',
          to: 'uncertain',
          reason: 'SUBMISSION_RECOVERY_RESUMED_BY_OPERATOR',
          label: '由管理员恢复'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'SUBMISSION_RECOVERY_GIVEN_UP_BY_OPERATOR',
          label: '由管理员放弃等待'
        },
        {
          from: 'queued',
          to: 'running',
          label: '开始执行'
        },
        {
          from: 'queued',
          to: 'succeeded',
          label: '执行成功'
        },
        {
          from: 'running',
          to: 'succeeded',
          label: '执行成功'
        },
        {
          from: 'queued',
          to: 'failed',
          label: '轮询确认失败'
        },
        {
          from: 'running',
          to: 'failed',
          label: '轮询确认失败'
        }
      ]
    },
    {
      axis: 'publication',
      order: 3,
      title: '发布',
      field: 'publication.status',
      initial: 'pending',
      terminal: ['published', 'failed', 'skipped'],
      states: [
        'pending',
        'publishing',
        'uncertain',
        'disconnected',
        'published',
        'failed',
        'skipped'
      ],
      details: {
        pending: {
          label: '等待中',
          summary: '等待可发布的执行成功结果。',
          description: '等待执行成功并返回结果，再开始发布。'
        },
        publishing: {
          label: '发布中',
          summary: '正在发布审查结果。',
          description: '协调进程已领取发布任务，正在执行远端发布操作。'
        },
        uncertain: {
          label: '待确认',
          summary: '某个步骤可能已生效，正在核对；其他步骤可继续，尚未判定失败。',
          description:
            '某个发布步骤可能已在远端生效，系统正在核对结果。发布轴的状态由优先级最高的步骤状态决定。此状态不表示失败，其他步骤仍可继续发布。'
        },
        disconnected: {
          label: '失联',
          summary: '自动核对已停止，某个步骤的远端结果仍待人工确认。',
          description:
            '某个发布步骤的自动核对已停止，结果仍不确定，需要管理员核查远端情况。发布轴的状态由优先级最高的步骤状态决定。'
        },
        published: {
          label: '已发布',
          summary: '所有发布步骤均已成功，结果已可见。',
          description: '所有发布步骤均已成功，结果已可见。'
        },
        failed: {
          label: '失败',
          summary: '发布失败或由人工停止，部分步骤可能已生效；可重试的失败会重新排队。',
          description:
            '发布已结束并记为失败：可能是负责发布的进程确认发布失败（例如发生不可重试的失败，或仍有步骤未成功），也可能是管理员放弃等待。可重试的失败会回到 `pending`。'
        },
        skipped: {
          label: '已跳过',
          summary: '执行未成功，不会发布结果。',
          description: '执行没有成功，因此没有可发布的内容。'
        }
      },
      transitions: [
        {
          from: 'pending',
          to: 'publishing',
          label: '开始发布'
        },
        {
          from: 'pending',
          to: 'uncertain',
          label: '恢复发布，仍有步骤待确认'
        },
        {
          from: 'uncertain',
          to: 'uncertain',
          reason: 'PUBLICATION_LEASE_EXPIRED',
          label: '核对租约过期'
        },
        {
          from: 'publishing',
          to: 'uncertain',
          label: '某个步骤可能已生效'
        },
        {
          from: 'uncertain',
          to: 'publishing',
          label: '步骤已确认，继续发布'
        },
        {
          from: 'uncertain',
          to: 'disconnected',
          label: '核对无法得出结论'
        },
        {
          from: 'disconnected',
          to: 'pending',
          reason: 'PUBLICATION_RESUMED_BY_OPERATOR',
          label: '由管理员恢复'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PUBLICATION_GIVEN_UP_BY_OPERATOR',
          label: '由管理员放弃等待'
        },
        {
          from: 'publishing',
          to: 'published',
          label: '已发布'
        },
        {
          from: 'publishing',
          to: 'publishing',
          reason: 'PUBLICATION_LEASE_EXPIRED',
          label: '发布租约过期'
        },
        {
          from: 'publishing',
          to: 'pending',
          label: '可重试的失败'
        },
        {
          from: 'publishing',
          to: 'failed',
          label: '不可重试的失败'
        },
        {
          from: 'uncertain',
          to: 'pending',
          label: '可重试的失败'
        },
        {
          from: 'uncertain',
          to: 'failed',
          label: '不可重试的失败'
        },
        {
          from: 'pending',
          to: 'skipped',
          label: '执行结果不发布'
        },
        {
          from: 'publishing',
          to: 'skipped',
          reason: 'PUBLICATION_ABANDONED',
          label: '执行失败'
        }
      ],
      step: {
        field: 'ObservedPublicationStep.status',
        initial: 'pending',
        terminal: ['succeeded', 'terminal_failed'],
        states: [
          'pending',
          'running',
          'failed',
          'uncertain',
          'disconnected',
          'succeeded',
          'terminal_failed'
        ],
        details: {
          pending: {
            label: '等待中',
            summary: '尚未尝试，或已由管理员重新排队并重置尝试与核对次数。',
            description: '该步骤尚未尝试，或已由管理员重新排队并重置允许尝试和核对的次数。'
          },
          running: {
            label: '进行中',
            summary: '尝试已开始；即使进程中断，远端操作也可能已生效。',
            description:
              '一次发布尝试已开始。负责该步骤的进程可能仍在执行，也可能在远端操作生效后中断。后续进程领取任务时，必须考虑操作已生效的可能。'
          },
          failed: {
            label: '尝试失败',
            summary: '上次尝试失败；有剩余次数可重试，否则须先核对远端结果。',
            description:
              '上一次尝试失败。有剩余尝试次数时会重试；次数用尽后，须先核对远端结果，再确定最终状态。'
          },
          uncertain: {
            label: '待确认',
            summary: '尝试次数已用尽，先前操作可能已生效；须核对远端结果后才能结束。',
            description:
              '尝试次数已用尽，之前的尝试可能已在远端生效。连接器必须先核对远端结果，才能结束该步骤。'
          },
          disconnected: {
            label: '失联',
            summary: '核对次数已用尽，远端结果仍待人工确认。',
            description: '核对次数已用尽，仍无法确认结果，需要管理员核查远端情况。'
          },
          succeeded: {
            label: '发布成功',
            summary: '远端操作已成功完成，或已通过后续核对确认。',
            description: '远端操作已生效：发布尝试已报告成功，或后续核对已确认结果存在。'
          },
          terminal_failed: {
            label: '最终失败',
            summary: '不会再尝试：已发生不可重试的失败，或已确认远端操作未生效。',
            description:
              '该步骤不会再次尝试：某次尝试发生不可重试的失败，或核对已确认远端操作未生效。'
          }
        },
        transitions: [
          {
            from: 'pending',
            to: 'running',
            label: '开始尝试'
          },
          {
            from: 'running',
            to: 'running',
            label: '由另一处理进程接管'
          },
          {
            from: 'failed',
            to: 'running',
            label: '开始重试'
          },
          {
            from: 'running',
            to: 'succeeded',
            label: '远端操作已生效'
          },
          {
            from: 'running',
            to: 'failed',
            label: '可重试的失败'
          },
          {
            from: 'running',
            to: 'terminal_failed',
            label: '不可重试的失败'
          },
          {
            from: 'running',
            to: 'uncertain',
            label: '尝试次数用尽'
          },
          {
            from: 'failed',
            to: 'uncertain',
            label: '尝试次数用尽'
          },
          {
            from: 'uncertain',
            to: 'succeeded',
            label: '已确认远端操作生效'
          },
          {
            from: 'uncertain',
            to: 'terminal_failed',
            label: '已确认未生效或不可重试'
          },
          {
            from: 'uncertain',
            to: 'uncertain',
            label: '核对结果仍不确定'
          },
          {
            from: 'uncertain',
            to: 'disconnected',
            label: '核对次数用尽'
          },
          {
            from: 'uncertain',
            to: 'failed',
            label: '报告失败且不重试'
          },
          {
            from: 'disconnected',
            to: 'pending',
            reason: 'PUBLICATION_RESUMED_BY_OPERATOR',
            label: '由管理员恢复'
          }
        ]
      }
    }
  ]
} as const

/** The machines with the contract's own (English) text. */
export const STATE_MACHINES: readonly StateMachine[] = STATE_MACHINES_BY_LANGUAGE.en

/** The machine for one axis, with its text in `language`. */
export function stateMachine(axis: CoordinationAxis, language: Language = 'en'): StateMachine {
  const machine = STATE_MACHINES_BY_LANGUAGE[language].find((candidate) => candidate.axis === axis)
  if (machine === undefined) throw new Error(`no state machine for ${axis}`)
  return machine
}

/** The machine whose states an audit event's `from_status` and `to_status` name: the axis
 * itself, or its step machine when the event names a step. */
export function machineForEvent(
  event: { axis: CoordinationAxis; step_key: string | null },
  language: Language = 'en'
): MachineBody | undefined {
  const machine = stateMachine(event.axis, language)
  return event.step_key === null ? machine : machine.step
}
