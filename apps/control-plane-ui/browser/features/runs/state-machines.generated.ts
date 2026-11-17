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
 * structure is identical across languages; only title, label, and description differ. A
 * machine's steps, when it has them, are its `step` member. */
export const STATE_MACHINES_BY_LANGUAGE: Readonly<
  Record<Language, readonly StateMachine[]>
> = {
  en: [
    {
      axis: 'preparation',
      order: 1,
      title: 'Preparation',
      field: 'preparation.status',
      initial: 'pending',
      terminal: ['submitted', 'failed'],
      states: [
        'pending',
        'preparing',
        'uncertain',
        'disconnected',
        'submitted',
        'failed'
      ],
      details: {
        pending: {
          label: 'Pending',
          description: 'Admitted, but no preparer has claimed the work yet.'
        },
        preparing: {
          label: 'Preparing',
          description:
            'A coordinator currently owns the claim and is building the Execution input.'
        },
        uncertain: {
          label: 'Uncertain',
          description:
            'The claim lapsed before the preparer reported, so it is unknown whether the prepared input reached Review Runs. This is not a failure: a claim may rebuild the input and resubmit it under the same identity, which is idempotent.'
        },
        disconnected: {
          label: 'Disconnected',
          description:
            "Automatic work stopped without a conclusion, because the run's persisted state no longer admits the only transition expiry could make. Nothing retries this row on its own; an operator resumes it into `uncertain`, gives it up, or abandons it."
        },
        submitted: {
          label: 'Submitted',
          description:
            'The input was accepted and handed to the Execution API provider; preparation is done.'
        },
        failed: {
          label: 'Failed',
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
          description:
            'Admitted, but its prepared input has not been submitted to the Execution API provider yet.'
        },
        queued: {
          label: 'Queued',
          description:
            'The Execution API provider accepted the submission; polling has not yet seen it start.'
        },
        running: {
          label: 'Running',
          description:
            'Polling observed that the Execution API provider is executing this run. A transient network blip while polling does not change this state: the run keeps the last observed value and is polled again, so this state may be slightly out of date.'
        },
        succeeded: {
          label: 'Succeeded',
          description:
            'The Execution API provider returned a result; it now becomes eligible for publication.'
        },
        skipped: {
          label: 'Skipped',
          description:
            'Execution never ran because preparation failed. This is not an execution failure; the reason is on the preparation axis.'
        },
        uncertain: {
          label: 'Uncertain',
          description:
            'The task was submitted, but no response arrived, so it is unknown whether the Execution API provider accepted it. This is not a failure: the submission is replayed under the same run_id.'
        },
        disconnected: {
          label: 'Disconnected',
          description:
            'Automatic recovery used its budget without a conclusive Execution API provider answer. The run is visible for operator action and is not reported as failed.'
        },
        failed: {
          label: 'Failed',
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
          description:
            'Waiting for a successful execution result before publishing.'
        },
        publishing: {
          label: 'Publishing',
          description:
            'A coordinator owns the publication claim and is performing the side effects.'
        },
        uncertain: {
          label: 'Uncertain',
          description:
            'A step may have completed its side effect remotely and is being reconciled. The axis reflects its strongest step; this is not a failure, and other steps keep publishing.'
        },
        disconnected: {
          label: 'Disconnected',
          description:
            'Automatic reconciliation of a step stopped without an answer, so an operator has to establish what is on the remote system. The axis reflects its strongest step.'
        },
        published: {
          label: 'Published',
          description: 'All publication steps succeeded; the result is visible.'
        },
        failed: {
          label: 'Failed',
          description:
            'Publishing ended in failure, either because its owner concluded it as failed (for example after a terminal failure or with steps that did not succeed) or because an operator gave up. A retryable failure returns to `pending` instead.'
        },
        skipped: {
          label: 'Skipped',
          description:
            'There was nothing to publish because execution did not succeed.'
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
            description:
              'Not attempted yet, or returned to the queue with fresh budgets by an operator.'
          },
          running: {
            label: 'Running',
            description:
              'An attempt started. Its owner may still be performing the side effect, or may have died after performing it, so a later claim cannot assume nothing happened.'
          },
          failed: {
            label: 'Attempt failed',
            description:
              'The last attempt failed. The system retries while attempts remain; once they are exhausted, it checks the remote result before concluding.'
          },
          uncertain: {
            label: 'Uncertain',
            description:
              'The attempt budget is spent, but any started attempt may have taken effect remotely, so the connector must reconcile against the remote system before the step can conclude.'
          },
          disconnected: {
            label: 'Disconnected',
            description:
              'Reconciliation used its budget without an answer. An operator has to establish what is on the remote system.'
          },
          succeeded: {
            label: 'Succeeded',
            description:
              'The side effect exists, either written by an attempt or found by reconciliation.'
          },
          terminal_failed: {
            label: 'Terminal failure',
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
            label: 'taken over by a new owner'
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
      states: [
        'pending',
        'preparing',
        'uncertain',
        'disconnected',
        'submitted',
        'failed'
      ],
      details: {
        pending: {
          label: '等待中',
          description: '已接纳，但还没有准备者领取这项工作。'
        },
        preparing: {
          label: '准备中',
          description: '协调方当前持有认领，正在构造执行输入。'
        },
        uncertain: {
          label: '待确认',
          description:
            '认领在准备者回报之前过期，因此不确定准备好的输入是否已到达 Review Runs。这不是失败：可以重新认领，用同一身份重建并重新提交输入，这一操作是幂等的。'
        },
        disconnected: {
          label: '失联',
          description:
            '自动处理停止且没有结论：运行已持久化的状态不再允许过期唯一能做的那次转换。不会自动重试；由 operator 将其恢复到 `uncertain`、放弃等待，或者作废（abandon）。'
        },
        submitted: {
          label: '已提交',
          description: '输入已被接受并交给 Execution API 提供方，准备阶段完成。'
        },
        failed: {
          label: '失败',
          description:
            '准备没有得到可用结果，分两种情况：(1) 准备永久失败（重试预算用尽，或无法构造输入），Execution API 提供方从未收到输入，因此执行被跳过；(2) operator 对失联的准备决定不再等待或作废。operator 决定之后，输入可能已经提交，任务也可能仍在远端执行。'
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
          label: '重新领取以确认'
        },
        {
          from: 'preparing',
          to: 'disconnected',
          reason: 'EXECUTION_ALREADY_ADVANCED',
          label: '无法自动收尾'
        },
        {
          from: 'disconnected',
          to: 'uncertain',
          reason: 'PREPARATION_RESUMED_BY_OPERATOR',
          label: '由 operator 恢复'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PREPARATION_GIVEN_UP_BY_OPERATOR',
          label: '由 operator 放弃等待'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PREPARATION_ABANDONED_BY_OPERATOR',
          label: '由 operator 放弃'
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
          description: '已接纳，但准备好的输入尚未提交给 Execution API 提供方。'
        },
        queued: {
          label: '排队中',
          description:
            'Execution API 提供方已接受提交，轮询尚未观察到它开始执行。'
        },
        running: {
          label: '执行中',
          description:
            '轮询观察到 Execution API 提供方正在执行该运行。轮询时偶发的网络抖动不会改变这个状态：运行保留上次观察到的值并继续轮询，因此这个状态可能略有滞后。'
        },
        succeeded: {
          label: '执行成功',
          description: 'Execution API 提供方返回了结果，现在可以发布。'
        },
        skipped: {
          label: '已跳过',
          description:
            '准备失败，因此执行从未运行。这不是执行失败，原因记录在准备轴上。'
        },
        uncertain: {
          label: '待确认',
          description:
            '任务已提交但没有收到响应，因此不确定 Execution API 提供方是否已接受。这不是失败：会用同一个 run_id 重放这次提交。'
        },
        disconnected: {
          label: '失联',
          description:
            '自动恢复已用完预算，仍未得到 Execution API 提供方的确定答复。该运行会显示出来等待 operator 处理，不会被报告为失败。'
        },
        failed: {
          label: '失败',
          description:
            '这个运行不再跟踪该任务，分两种情况：(1) 确定的失败：轮询得到任务不可能成功的确定答复（Execution API 提供方报告失败，或者找不到该运行、没有返回结果、响应违反协议），或重试的提交得到确定的失败；(2) operator 对失联的执行决定不再等待，或作废了这个运行的准备。operator 决定之后不会发送取消请求，因此任务可能仍在远端执行，甚至可能成功。临时网络错误（超时、5xx、连接中断）不算确定的失败。'
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
          label: '领取重放'
        },
        {
          from: 'uncertain',
          to: 'queued',
          label: '重放被接受'
        },
        {
          from: 'uncertain',
          to: 'failed',
          label: '重放被拒绝'
        },
        {
          from: 'uncertain',
          to: 'disconnected',
          reason: 'SUBMISSION_RECOVERY_EXHAUSTED',
          label: '恢复停止'
        },
        {
          from: 'disconnected',
          to: 'uncertain',
          reason: 'SUBMISSION_RECOVERY_RESUMED_BY_OPERATOR',
          label: '由 operator 恢复'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'SUBMISSION_RECOVERY_GIVEN_UP_BY_OPERATOR',
          label: '由 operator 放弃等待'
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
          description: '等待执行成功的结果，然后开始发布。'
        },
        publishing: {
          label: '发布中',
          description: '协调方持有发布认领，正在执行各项副作用。'
        },
        uncertain: {
          label: '待确认',
          description:
            '某个步骤可能已在远端完成副作用，正在核对。该轴反映最强的步骤状态；这不是失败，其他步骤会继续发布。'
        },
        disconnected: {
          label: '失联',
          description:
            '某个步骤的自动核对已停止且没有答案，需要 operator 确认远端的实际情况。该轴反映最强的步骤状态。'
        },
        published: {
          label: '已发布',
          description: '所有发布步骤均已成功，结果已可见。'
        },
        failed: {
          label: '失败',
          description:
            '发布以失败结束：owner 将其收尾为失败（例如出现终止失败，或仍有步骤未成功），或者 operator 放弃。可重试的失败会回到 `pending`。'
        },
        skipped: {
          label: '已跳过',
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
          label: '恢复发布，仍有未核对的步骤'
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
          label: '步骤已结算'
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
          label: '由 operator 恢复'
        },
        {
          from: 'disconnected',
          to: 'failed',
          reason: 'PUBLICATION_GIVEN_UP_BY_OPERATOR',
          label: '由 operator 放弃'
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
          label: '终止失败'
        },
        {
          from: 'uncertain',
          to: 'pending',
          label: '可重试的失败'
        },
        {
          from: 'uncertain',
          to: 'failed',
          label: '终止失败'
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
            description: '尚未尝试，或者已由 operator 放回队列并重置预算。'
          },
          running: {
            label: '进行中',
            description:
              '一次尝试已经开始。它的 owner 可能仍在执行副作用，也可能在执行后中止，因此后续认领不能假定什么都没发生。'
          },
          failed: {
            label: '尝试失败',
            description:
              '上一次尝试失败。还有剩余次数时会重试；次数用尽后，先核对远端结果再下结论。'
          },
          uncertain: {
            label: '待确认',
            description:
              '尝试预算已用完，但任何已开始的尝试都可能已在远端生效，因此 connector 必须先核对远端，步骤才能结束。'
          },
          disconnected: {
            label: '失联',
            description:
              '核对用完了预算仍没有答案，需要 operator 确认远端的实际情况。'
          },
          succeeded: {
            label: '发布成功',
            description: '副作用已存在：由某次尝试写入，或由核对发现。'
          },
          terminal_failed: {
            label: '最终失败',
            description:
              '这个步骤不会再尝试：某次尝试终止失败，或者核对确认副作用不存在。'
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
            label: '由新 owner 接管'
          },
          {
            from: 'failed',
            to: 'running',
            label: '开始重试'
          },
          {
            from: 'running',
            to: 'succeeded',
            label: '副作用已写入'
          },
          {
            from: 'running',
            to: 'failed',
            label: '可重试的失败'
          },
          {
            from: 'running',
            to: 'terminal_failed',
            label: '终止失败'
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
            label: '核对确认存在'
          },
          {
            from: 'uncertain',
            to: 'terminal_failed',
            label: '核对确认不存在或终止失败'
          },
          {
            from: 'uncertain',
            to: 'uncertain',
            label: '核对无结论'
          },
          {
            from: 'uncertain',
            to: 'disconnected',
            label: '核对预算用尽'
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
            label: '由 operator 恢复'
          }
        ]
      }
    }
  ]
} as const

/** The machines with the contract's own (English) text. */
export const STATE_MACHINES: readonly StateMachine[] =
  STATE_MACHINES_BY_LANGUAGE.en

/** The machine for one axis, with its text in `language`. */
export function stateMachine(
  axis: CoordinationAxis,
  language: Language = 'en'
): StateMachine {
  const machine = STATE_MACHINES_BY_LANGUAGE[language].find(
    (candidate) => candidate.axis === axis
  )
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
