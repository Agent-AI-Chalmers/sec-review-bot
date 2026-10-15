// The runner's workflow vocabulary, restated here because Control Plane's admission and
// publication layers switch on it.
export type WorkflowName =
  'issue-review' | 'pull-request-review' | 'repository-review'
