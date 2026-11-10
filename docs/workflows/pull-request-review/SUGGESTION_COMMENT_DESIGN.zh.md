# Suggestion Comment 设计

语言：[English](SUGGESTION_COMMENT_DESIGN.md) | 中文

本文为 [SUGGESTION_COMMENT_DESIGN.md](SUGGESTION_COMMENT_DESIGN.md) 的中文译文；如有差异，以英文版为准。

## 目标

将修复补丁映射为 GitHub PR 的 inline suggestion，让审查者直接在 PR 页面应用修复：

![修改建议](../../../assets/screenshots/suggestion.png)

本项目通过这种评论提供与变更行关联的应用建议入口。普通摘要评论用于解释问题，补丁用于表达修改；它们不提供同样的行内操作。

参考资料：

- [GitHub REST API - Create a review for a pull request](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
- [GitHub REST API - Create a review comment for a pull request](https://docs.github.com/en/rest/pulls/comments)
- [GitHub Docs - Reviewing proposed changes in a pull request](https://docs.github.com/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request)

## inline suggestion 的范围限制

inline suggestion 必须关联 PR diff 中的文件和行区间，不能用来传递任意补丁。每条 inline suggestion 必须：

- 对应 PR 变更文件列表中的文件；
- 能定位到 PR diff 中可见的行区间。

修复补丁中超出这些范围的修改仍可保留，但通过摘要说明，不强行转换成 inline suggestion。

## 实现

### 发布条件

存在修复补丁，且至少一个 diff hunk 可以映射到 PR 可见行时，生成 candidate。每个 candidate 必须满足：

1. 文件出现在 PR 变更列表中，且有可用的 PR diff 内容。
2. diff hunk 能生成 suggestion block；删除操作允许替换内容为空。
3. diff hunk 能够定位到 PR diff 右侧，即当前版本的行区间。

这是 partial-admission pipeline：

- 无法定位的文件或 diff hunk 会被跳过，能够定位的建议仍会生成。
- 跳过项记录在 suggestion manifest 的 `unmapped_changes` 中。

### 映射流程

#### 1. 解析修复补丁

把 unified diff 解析为按文件分组的 hunk。

#### 2. 筛选 PR 可见文件

只保留本次运行 review window 内的文件：完整审查时是整个 PR，增量审查时只是上次审查的 head 之后变更的文件。这些文件带有变更信息和 diff hunk，供第 4 步锚定使用。

#### 3. 构造替换内容和评论正文

将 diff hunk 中连续的增删行拆成 suggestion block：

- 替换操作使用新增行作为替换文本；
- 删除操作使用空替换文本；
- 纯插入操作使用相邻上下文行定位，并把该行保留在替换文本中；
- 将替换文本放入 `suggestion` 代码块，作为评论正文。

#### 4. 根据重叠的 PR diff hunk 计算行位置

对每个 suggestion block，在同一文件中寻找与其重叠的 PR diff hunk，取两者在 PR 当前版本（右侧）中的重叠行区间作为锚点。没有重叠时跳过；重叠一行时提交单行建议，多行时提交多行建议。

#### 5. 在一次 Review 中发布 inline suggestion

创建一次 PR Review，包含：

- inline suggestion 评论：`path`、`body`、`line`、`side`，以及需要时的 `start_line`、`start_side`；
- `commit_id = head_sha`。

### 无法映射时如何处理

没有生成 candidate 时：

1. 不发布 inline suggestions。
2. 发布标准 top-level PR summary comment。

这样可以保持行为确定，并避免位置不准确或容易误导的 inline edits。

部分 candidate 已生成，但部分 diff hunk 无法 anchor 时：

1. 为能够 anchor 的 candidate 发布 inline suggestions。
2. 在 review body 中追加 `Unmapped Mitigation Changes` section，说明无法 anchor 的 diff hunk。
