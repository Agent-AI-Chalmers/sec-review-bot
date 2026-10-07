import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, login, type Run } from './api.js'
import './styles.css'

function Login(): React.JSX.Element {
  const [token, setToken] = React.useState('')
  const [error, setError] = React.useState('')
  return (
    <main className="login">
      <h1>Control Plane</h1>
      <p>Sign in to inspect review runs.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void login(token).then(
            () => {
              window.location.href = '/runs'
            },
            () => setError('Access denied.')
          )
        }}
      >
        <label>
          Access token
          <input
            autoFocus
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button type="submit">Sign in</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  )
}

function Runs(): React.JSX.Element {
  const [search, setSearch] = useSearchParams()
  const [data, setData] = React.useState<{ runs: Run[]; next_cursor: string | null }>()
  const [error, setError] = React.useState<unknown>()
  const [version, refresh] = React.useReducer((value) => value + 1, 0)
  React.useEffect(() => {
    setData(undefined)
    void api<{ runs: Run[]; next_cursor: string | null }>(`/runs?${search.toString()}`).then(
      setData,
      setError
    )
  }, [search, version])
  if (error) throw error
  const update = (name: string, value: string): void => {
    const next = new URLSearchParams(search)
    if (value) next.set(name, value)
    else next.delete(name)
    next.delete('cursor')
    setSearch(next)
  }
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Review Control Plane</p>
          <h1>Review runs</h1>
        </div>
        <button onClick={refresh}>Refresh</button>
      </header>
      <section className="filters" aria-label="Run filters">
        <label>
          Status
          <select
            value={search.get('status') ?? ''}
            onChange={(event) => update('status', event.target.value)}
          >
            <option value="">All</option>
            {[
              'preparing',
              'recovering',
              'queued',
              'running',
              'succeeded',
              'publishing',
              'published',
              'failed'
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Workflow
          <select
            value={search.get('workflow') ?? ''}
            onChange={(event) => update('workflow', event.target.value)}
          >
            <option value="">All</option>
            {['issue-review', 'pull-request-review', 'repository-review'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </section>
      {data === undefined ? (
        <p>Loading runs...</p>
      ) : data.runs.length === 0 ? (
        <p className="empty">No review runs match these filters.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Workflow</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.run_id}>
                    <td>
                      <Link to={`/runs/${encodeURIComponent(run.run_id)}`}>{run.run_id}</Link>
                    </td>
                    <td>{run.workflow}</td>
                    <td>
                      <span className={`status status-${run.status}`}>{run.status}</span>
                    </td>
                    <td>{new Date(run.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.next_cursor && (
            <button
              className="next"
              onClick={() => {
                const next = new URLSearchParams(search)
                next.set('cursor', data.next_cursor ?? '')
                setSearch(next)
              }}
            >
              Next page
            </button>
          )}
        </>
      )}
    </main>
  )
}

interface Step {
  step_key: string
  status: string
  attempts: number
  failure_code: string | null
}
function Detail(): React.JSX.Element {
  const { runId = '' } = useParams()
  const [run, setRun] = React.useState<Run>()
  const [steps, setSteps] = React.useState<Step[]>([])
  const [error, setError] = React.useState<unknown>()
  React.useEffect(() => {
    void Promise.all([
      api<{ run: Run }>(`/runs/${encodeURIComponent(runId)}`),
      api<{ publication_steps: Step[] }>(`/runs/${encodeURIComponent(runId)}/publication-steps`)
    ]).then(([runValue, stepValue]) => {
      setRun(runValue.run)
      setSteps(stepValue.publication_steps)
    }, setError)
  }, [runId])
  if (error) throw error
  return (
    <main>
      <Link className="back" to="/runs">
        Back to runs
      </Link>
      {run === undefined ? (
        <p>Loading run...</p>
      ) : (
        <>
          <header>
            <div>
              <p className="eyebrow">{run.workflow}</p>
              <h1 className="run-id">{run.run_id}</h1>
            </div>
            <span className={`status status-${run.status}`}>{run.status}</span>
          </header>
          <section>
            <h2>Execution</h2>
            <dl>
              <dt>Created</dt>
              <dd>{new Date(run.created_at).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(run.updated_at).toLocaleString()}</dd>
              <dt>Published</dt>
              <dd>
                {run.published_at ? new Date(run.published_at).toLocaleString() : 'Not published'}
              </dd>
              {run.failure_code && (
                <>
                  <dt>Failure</dt>
                  <dd>{run.failure_code}</dd>
                </>
              )}
            </dl>
          </section>
          <section>
            <h2>Artifact</h2>
            <pre>
              {run.artifact_publication === null
                ? 'No artifact publication recorded.'
                : JSON.stringify(run.artifact_publication, null, 2)}
            </pre>
          </section>
          <section>
            <h2>Publication steps</h2>
            {steps.length === 0 ? (
              <p>No publication steps recorded.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Failure</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step) => (
                    <tr key={step.step_key}>
                      <td>{step.step_key}</td>
                      <td>{step.status}</td>
                      <td>{step.attempts}</td>
                      <td>{step.failure_code ?? 'None'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {}
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }
  render(): React.ReactNode {
    if (this.state.error instanceof ApiError && this.state.error.status === 401) return <Login />
    if (this.state.error)
      return (
        <main>
          <h1>Unable to load Control Plane</h1>
          <p role="alert">The service could not complete this request.</p>
        </main>
      )
    return this.props.children
  }
}
function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:runId" element={<Detail />} />
        <Route path="*" element={<Runs />} />
      </Routes>
    </ErrorBoundary>
  )
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)
