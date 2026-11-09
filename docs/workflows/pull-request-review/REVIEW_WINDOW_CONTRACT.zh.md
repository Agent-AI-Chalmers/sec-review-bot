# Pull Request Review Window Contract

语言：[English](REVIEW_WINDOW_CONTRACT.md) | 中文

本文为 [REVIEW_WINDOW_CONTRACT.md](REVIEW_WINDOW_CONTRACT.md) 的中文译文；如有差异，以英文版为准。

## 问题

一次 pull request 审查 run 会物化以下产物，用来描述同一份变更：

- `changed-files.json`：该窗口的文件列表；
- `incremental.patch`：该窗口的 diff；
- 输入中的 `files` 集合，是另一份导出，用于锚定 inline suggestion 和 mitigation patch。

如果这些产物描述的是不同的变更窗口，这次 run 就是自相矛盾的。

### Agent 如何得知窗口

Agent 通过工作区里的 git 读取窗口，边界取自本次 run 自己的范围，并只保留与那里发生的变化相关的结论。git 持有窗口的两端，能回答与补丁相同的问题，同时允许 Agent 只读它需要的那部分改动，而不是一份完整的预渲染 diff：小改动一条命令即可，大改动本来也无法从头读到尾。

### 产物为什么保留

`changed-files.json` 与 `incremental.patch` 是本次 run 审过什么的稳定记录，不必依赖仓库状态重建窗口即可查看。这是 run 自身的属性，不取决于任何消费者，也就不受“让 Agent 读什么”影响。

suggestion 锚定是另一件事，它使用输入中的 `files` 集合，由输入准备阶段与补丁一起导出。

本文记录窗口语义、所涉 GitHub API 的实测行为、审查工具生态的通行做法，以及本项目最终采用的契约。

## 候选窗口

对任意一次 run，候选窗口如下：

| 窗口 | 范围 | 含义 |
| --- | --- | --- |
| 完整 PR | `base_sha...head_sha` | pull request 相对 merge base 引入的全部变更。 |
| Push | `previous_head_sha..head_sha` | 仅触发本次 run 的 `synchronize` 事件新增的提交。 |

`previous_head_sha` 来自 [`pull_request` webhook 的 `before` 字段](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)。`synchronize` 载荷类型要求同时存在 `after` 与 `before`，其定义来自本仓库锁定的 `@octokit/openapi-webhooks-types`：

```ts
"webhook-pull-request-synchronize": {
  action: "synchronize";
  after: string;
  before: string;
  ...
}
```

这个类型是唯一可得的规范性陈述。webhook 文档对分支被 force-push 后 `before` 的含义没有任何说明，而 [compare 端点](https://docs.github.com/en/rest/commits/commits#compare-two-commits) 只文档化了它自己的 `basehead` 参数，没有说明其背后提交的可达性。

## 实测的 API 行为

以下行为均针对线上 API 实测，而非从文档推断。

### 完整 PR 窗口必须使用三点范围

GitHub 把 `pull_request.base.sha` 报告为**目标分支当前 tip**，而不是分支分叉点。实测：`apache/hbase` 上四个不同的开放 pull request 都返回同一个 `base.sha`（`09474ab7...`），即 `master` 的 tip。

因此 base 与 head 可能位于已经分叉的历史上。两点 diff（`base..head`）比较的是两棵树，于是分叉之后落在目标分支上的工作会被渲染成 pull request 的删除。三点 diff（`base...head`）从 merge base 开始比较，与 pull request 的真实变更集合一致。这与 [GitHub compare 端点](https://docs.github.com/en/rest/commits/commits#compare-two-commits) 语义相同，其 `basehead` 参数文档明确写为 `BASE...HEAD`。

三点 diff 需要 merge base 存在，因此工作区不能是浅克隆。多 ref 物化因而不加 `--depth`。

### 按 SHA fetch 会让提交不可达

按具体 commit SHA 执行 fetch 不会创建任何指向它的分支或标签。既有的工作区清理步骤会修剪不可达对象（先 `reflog expire --expire=now --all`，再 `gc --prune=now`），这曾把 base commit 删除，使比较失败于 `fatal: Invalid symmetric difference expression`。

现在被 fetch 的提交会在清理之前固定到 `refs/sec-review/base` 与 `refs/sec-review/head`，按其在 review window 中的角色命名：

- `head` 是最后一个请求的 ref；
- `base` 是与调用方显式传入的 `window_base_sha` 相匹配的 ref。

pull request 会先传自身 base 再传窗口 base，且在 `synchronize` 时两者是不同的提交，因此第一个 ref 会被固定为 `pinned-N`，而不是被假定为窗口起点。

### 大 pull request 上文件列表 API 会省略 `patch`

[`GET /repos/{owner}/{repo}/pulls/{number}/files`](https://docs.github.com/en/rest/pulls/pulls#list-files-for-a-pull-request) 的响应上限为 3000 个文件。对于大 pull request，部分文件的 `patch` 字段可能为空，因此不能依靠该字段拼装完整补丁。本项目从工作区仓库导出补丁，避免遗漏变更。

实测例子：`apache/hbase` #7722 返回了 340 个文件，其中 93 个文件的 `patch` 字段为空，包括部分最大的文件。从工作区仓库导出的补丁则包含全部 340 个文件。

### 对不可达的 base 执行 compare 会失败，而不是返回空

[`GET /repos/{owner}/{repo}/compare/{basehead}`](https://docs.github.com/en/rest/commits/commits#compare-two-commits) 在两种关键情形下行为不同：

| 情形 | 响应 |
| --- | --- |
| 两个相同提交，空 diff | `200`、`files: []`、`status: identical` |
| base commit 不可达 | `404 Not Found` |

<!-- doc-default: github-integration.resolveReviewWindowFiles; source=apps/github-integration/src/reviews/pull-requests/review-window.ts -->
`synchronize` 事件通常只审查本次推送的变更。如果 GitHub 无法提供上次提交到当前提交的比较结果，并返回 `404`，则改为审查整个 PR，回退原因为 `synchronize-previous-head-unreachable`。其他请求错误仍按准备阶段的重试和失败规则处理。

强制推送后，旧提交不一定立即无法访问。因此，是否因 `404` 回退取决于接口响应，而不是是否发生过强制推送。

## 其他审查工具怎么做

### CodeRabbit

文档给出了明确的双模式策略，引自 [Pull Request Reviews](https://docs.coderabbit.ai/overview/pull-request-review.md)：

> **New PRs**: Full analysis of all changes with detailed findings
> **New commits**: Incremental reviews that track what's new since the last review
> **Every update**: Fresh insights without repeating resolved comments

### PR-Agent（开源，已阅读源码）

[`pr_agent/servers/github_app.py`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/servers/github_app.py)：

- `synchronize` 事件路由到 `handle_push_trigger_for_new_commits`，执行 `push_commands`；默认值为 `['/describe', '/review']`，也就是说默认的 `synchronize` 行为是**完整**重审，而不是增量；
- 增量路径需通过 `-i` 参数显式开启（`IncrementalPR`），并且有 gate 保护。[`pr_reviewer.py`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/tools/pr_reviewer.py) 在没有上一次审查，或没有任何提交早于上一次审查时，回退到完整审查；
- [`github_provider.py`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/git_providers/github_provider.py) 给出的理由很明确："Every commit post-dates the review (e.g. the branch was fully rebased), so there is no baseline commit to diff against. Fall back to a full review rather than diffing against a None ref, which silently yields empty original content."
- 同一文件还会跳过 merge commit，并把未审查文件记录在 `unreviewed_files_map`。

结构上的教训正是本文主张的那一点：PR-Agent 的文件集合、diff 与提示词范围都来自**同一个**窗口。它从不会出现一个产物用完整窗口、另一个用 push 窗口的情况。

### 社区对增量审查的评估

[Anantys-oss/koan#666](https://github.com/Anantys-oss/koan/issues/666) 基于一次 PR-Agent 分析总结了取舍：

> **Pros**: Saves significant quota on iterative PR workflows; avoids repeating previous feedback; faster review cycles
>
> **Cons**: Requires tracking last-reviewed commit per PR; **delta diffs can miss context from earlier changes**; more complex state management

## 候选契约

促使本文形成的审计把选择框定为下列契约。在本项目中这些契约并不对等。

| | `synchronize` 时完整复审 | `synchronize` 时增量复审 |
| --- | --- | --- |
| 窗口 | 所有产物都用 `base...head` | 所有产物都用 `previous..head` |
| 成本 | 每次 push 重复完整分析 | 受 push 规模限制 |
| 重复报告 | 跨 run 很可能出现 | 不太可能出现 |
| 跨文件因果 | 保留 | push 修改共享代码时**可能遗漏** |
| `changed-files.json` 语义 | 与补丁一致 | 与补丁一致 |

决定性的要求不是哪个窗口更好，而是**无论选哪个窗口，这些产物都必须共用它**。

## 本项目采用的契约

`synchronize` 对这些产物统一使用 **push 窗口**。理由：

- 事件本身就带有该窗口，审计也确认它是原本意图的范围；
- 与 CodeRabbit 对新提交的文档化行为一致；
- 每次 push 完整重审的成本随 pull request 规模线性增长，这与本仓库实测的大 pull request 成本（一个真实 340 文件的 pull request 是 7.6 MB 的 diff）配合不佳；
- Analyzer 仍然可以读取 `/workspace` 获取跨文件上下文，被收窄的只是**报告范围**。

窗口只解析**一次**并贯穿传递，而不是由每个产物各自决定。由一个函数决定窗口，并同时产出文件列表、补丁范围和 suggestion 文件集合。

实现还提供以下保护：

1. **在无法建立 push 窗口时回退到完整窗口**：`previous_head_sha` 缺失、compare 返回空变更集合，或 compare 以 `404` 失败。只有 compare 的 `404` 触发这一错误回退，其他错误仍然失败。
2. **绝不混用窗口**。一个 run 如果文件列表来自一个窗口、补丁来自另一个窗口，应被拒绝而不是发布，因为它产生的 Analyzer 指令自相矛盾，且 suggestion 锚定会静默丢弃变更。

3. **当 push 窗口不是快进时回退到完整窗口。** 前一个 head 不是当前 head 的祖先时，compare 响应会在两侧都报告提交（`behind_by`），这正是 force-push 留下的状态。这样的窗口已不再描述增量变更，工作区也无从包含被丢弃的 head，因此 run 改为覆盖整个 pull request。

祖先判定读取的是 compare 响应本来就返回的字段，不产生额外请求。GitHub 仍未文档化被 force-push 的提交能保持可解析多久，因此上述 404 回退依然必要而非冗余。
