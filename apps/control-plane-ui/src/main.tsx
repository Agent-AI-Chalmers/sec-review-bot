import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, login, type Run } from './api.js'
import {
  formatDate,
  PreferenceControls,
  Preferences,
  useMessages,
  usePreferences
} from './preferences.js'
import './styles.css'

function Login(): React.JSX.Element {
  const t = useMessages()
  const [token, setToken] = React.useState('')
  const [error, setError] = React.useState('')
  return (
    <main className="login">
      <h1>Control Plane</h1>
      <p>{t('signInHint')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void login(token).then(
            () => {
              window.location.href = '/runs'
            },
            () => setError(t('denied'))
          )
        }}
      >
        <label>
          {t('accessToken')}
          <input
            autoFocus
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button type="submit">{t('signIn')}</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  )
}

function Runs(): React.JSX.Element {
  const { language } = usePreferences()
  const t = useMessages()
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
          <h1>{t('runs')}</h1>
        </div>
        <button onClick={refresh}>{t('refresh')}</button>
      </header>
      <section className="filters" aria-label="Run filters">
        <label>
          {t('status')}
          <select
            value={search.get('status') ?? ''}
            onChange={(event) => update('status', event.target.value)}
          >
            <option value="">{t('all')}</option>
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
          {t('workflow')}
          <select
            value={search.get('workflow') ?? ''}
            onChange={(event) => update('workflow', event.target.value)}
          >
            <option value="">{t('all')}</option>
            {['issue-review', 'pull-request-review', 'repository-review'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </section>
      {data === undefined ? (
        <p>{t('loadingRuns')}</p>
      ) : data.runs.length === 0 ? (
        <p className="empty">{t('emptyRuns')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('run')}</th>
                  <th>{t('workflow')}</th>
                  <th>{t('status')}</th>
                  <th>{t('updated')}</th>
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
                    <td>{formatDate(run.updated_at, language)}</td>
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
              {t('nextPage')}
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
  const { language } = usePreferences()
  const t = useMessages()
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
        {t('back')}
      </Link>
      {run === undefined ? (
        <p>{t('loadingRun')}</p>
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
            <h2>{t('execution')}</h2>
            <dl>
              <dt>{t('created')}</dt>
              <dd>{formatDate(run.created_at, language)}</dd>
              <dt>{t('updated')}</dt>
              <dd>{formatDate(run.updated_at, language)}</dd>
              <dt>{t('published')}</dt>
              <dd>
                {run.published_at ? formatDate(run.published_at, language) : t('notPublished')}
              </dd>
              {run.failure_code && (
                <>
                  <dt>{t('failure')}</dt>
                  <dd>{run.failure_code}</dd>
                </>
              )}
            </dl>
          </section>
          <section>
            <h2>{t('artifact')}</h2>
            <pre>
              {run.artifact_publication === null
                ? t('noArtifact')
                : JSON.stringify(run.artifact_publication, null, 2)}
            </pre>
          </section>
          <section>
            <h2>{t('publicationSteps')}</h2>
            {steps.length === 0 ? (
              <p>{t('noSteps')}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('step')}</th>
                    <th>{t('status')}</th>
                    <th>{t('attempts')}</th>
                    <th>{t('failure')}</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step) => (
                    <tr key={step.step_key}>
                      <td>{step.step_key}</td>
                      <td>{step.status}</td>
                      <td>{step.attempts}</td>
                      <td>{step.failure_code ?? t('none')}</td>
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
    if (this.state.error) return <ErrorFallback />
    return this.props.children
  }
}
function ErrorFallback(): React.JSX.Element {
  const t = useMessages()
  return (
    <main>
      <h1>{t('unable')}</h1>
      <p role="alert">{t('requestFailed')}</p>
    </main>
  )
}
function App(): React.JSX.Element {
  return (
    <>
      <div className="app-bar">
        <div className="app-bar-inner">
          <Link className="brand" to="/runs">
            Review Control Plane
          </Link>
          <PreferenceControls />
        </div>
      </div>
      <ErrorBoundary>
        <Routes>
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:runId" element={<Detail />} />
          <Route path="*" element={<Runs />} />
        </Routes>
      </ErrorBoundary>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <Preferences>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </Preferences>
)
