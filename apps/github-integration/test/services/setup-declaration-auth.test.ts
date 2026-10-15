import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

import type { GitHubAppOctokit } from '../../src/github/octokit.js'
import type { IssueContext } from '../../src/github/issue-service.js'

// Regression guard for private repositories. The setup declaration is read by a
// separate fetch against the repository remote, so it needs the installation
// token exactly like the workspace materialization does. The issue and
// repository preparers once omitted the token (the PR path always passed it),
// which failed every private-repository run.
//
// A `file://` remote never asks for credentials, so the earlier tests could not
// catch this. This test serves a real git repository over HTTP behind Basic
// auth: the fetch only succeeds when the preparer forwards the installation
// token, so the omission fails here.

const execFileAsync = promisify(execFile)
const TOKEN_USER = 'x-access-token'
const TOKEN_PASS = 'test-installation-token'

interface AuthGitServer {
  url: string
  close: () => Promise<void>
}

/** Serve `root` over HTTP, requiring the installation-token Basic auth. */
async function startAuthGitServer(root: string): Promise<AuthGitServer> {
  const expected = `Basic ${Buffer.from(`${TOKEN_USER}:${TOKEN_PASS}`).toString('base64')}`
  const server = http.createServer((req, res) => {
    if (req.headers['authorization'] !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' })
      res.end('auth required\n')
      return
    }
    const parsed = new URL(req.url ?? '/', 'http://localhost')
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: parsed.pathname,
        QUERY_STRING: parsed.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? ''
      }
    })
    const body: Buffer[] = []
    req.on('data', (chunk) => body.push(chunk))
    req.on('end', () => child.stdin.end(Buffer.concat(body)))
    let headerBuffer = Buffer.alloc(0)
    let headersParsed = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersParsed) {
        res.write(chunk)
        return
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      const boundary = headerBuffer.indexOf('\r\n\r\n')
      if (boundary === -1) return
      headersParsed = true
      const head = headerBuffer.subarray(0, boundary).toString()
      const rest = headerBuffer.subarray(boundary + 4)
      let status = 200
      for (const line of head.split('\r\n')) {
        const match = line.match(/^([^:]+):\s*(.*)$/)
        const name = match?.[1]
        const value = match?.[2]
        if (name === undefined || value === undefined) continue
        if (name.toLowerCase() === 'status') {
          status = Number.parseInt(value, 10)
          continue
        }
        res.setHeader(name, value)
      }
      res.writeHead(status)
      if (rest.length) res.write(rest)
    })
    child.stdout.on('end', () => res.end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function createBareRepoWithSetupFile(root: string): Promise<{ sha: string }> {
  const remote = path.join(root, 'octo', 'demo.git')
  const source = path.join(root, 'source')
  await fs.mkdir(path.dirname(remote), { recursive: true })
  await execFileAsync('git', ['init', '--quiet', '--bare', remote])
  await execFileAsync('git', ['init', '--quiet', source])
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: source })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source })
  await fs.mkdir(path.join(source, '.sec-review'), { recursive: true })
  await fs.writeFile(
    path.join(source, '.sec-review', 'setup.yml'),
    'setup:\n  - run: echo hi\n',
    'utf8'
  )
  await fs.writeFile(path.join(source, 'README.md'), 'x\n', 'utf8')
  await execFileAsync('git', ['add', '.'], { cwd: source })
  await execFileAsync('git', ['commit', '--quiet', '-m', 'init'], { cwd: source })
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: source })
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: source })
  await execFileAsync('git', ['push', '--quiet', 'origin', 'main'], { cwd: source })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
  return { sha: stdout.trim() }
}

function octokitFor(sha: string): GitHubAppOctokit {
  return {
    auth: async () => ({ token: TOKEN_PASS }),
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getBranch: async () => ({ data: { commit: { sha } } })
      },
      issues: { listEventsForTimeline: async () => ({ data: [] }) }
    }
  } as unknown as GitHubAppOctokit
}

function issueContext(): IssueContext {
  return {
    action: 'opened',
    repo_name: 'demo',
    repo_full_name: 'octo/demo',
    owner_login: 'octo',
    sender_login: 'alice',
    default_branch: 'main',
    issue_number: 42,
    issue_title: 'demo issue',
    issue_body: 'body',
    issue_author: 'alice',
    issue_state: 'open',
    labels: [],
    html_url: 'https://github.com/octo/demo/issues/42',
    api_url: 'https://api.github.com/repos/octo/demo/issues/42',
    comments_url: 'https://api.github.com/repos/octo/demo/issues/42/comments',
    is_pull_request: false
  }
}

test(
  'issue prepare-input reads the setup declaration from an authenticated remote',
  { concurrency: false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-auth-issue-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    const previousBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
    process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = path.join(root, 'bundles')
    const serverRoot = path.join(root, 'server-root')
    await fs.mkdir(serverRoot, { recursive: true })
    const server = await startAuthGitServer(serverRoot)
    try {
      const { sha } = await createBareRepoWithSetupFile(serverRoot)
      process.env['GITHUB_SERVER_URL'] = server.url
      const { prepareIssueReviewInput } = await import('../../src/reviews/issues/prepare-input.js')
      const prepared = await prepareIssueReviewInput({
        run_id: 'run-issue-auth',
        octokit: octokitFor(sha),
        issue: issueContext(),
        trusted_default_branch: { default_branch: 'main', head_sha: sha }
      })
      assert.equal(
        (prepared.input as { setup_declaration?: string }).setup_declaration,
        'setup:\n  - run: echo hi\n'
      )
    } finally {
      await server.close()
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      if (previousBundleRoot === undefined) delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
      else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousBundleRoot
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)

test(
  'repository prepare-input reads the setup declaration from an authenticated remote',
  { concurrency: false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-auth-repo-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    const previousBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
    process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = path.join(root, 'bundles')
    const serverRoot = path.join(root, 'server-root')
    await fs.mkdir(serverRoot, { recursive: true })
    const server = await startAuthGitServer(serverRoot)
    try {
      const { sha } = await createBareRepoWithSetupFile(serverRoot)
      process.env['GITHUB_SERVER_URL'] = server.url
      const { prepareRepositoryReviewInput } =
        await import('../../src/reviews/repositories/prepare-input.js')
      const prepared = await prepareRepositoryReviewInput({
        run_id: 'run-repo-auth',
        octokit: octokitFor(sha),
        repo_full_name: 'octo/demo',
        trusted_default_branch: { default_branch: 'main', head_sha: sha },
        scan_mode: 'full'
      })
      assert.equal(
        (prepared.input as { setup_declaration?: string }).setup_declaration,
        'setup:\n  - run: echo hi\n'
      )
    } finally {
      await server.close()
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      if (previousBundleRoot === undefined) delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
      else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousBundleRoot
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)
