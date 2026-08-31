import dotenv from 'dotenv'
import fs from 'fs'
import nodePath from 'path'
import { fileURLToPath } from 'url'

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url)
const CURRENT_DIR_PATH = nodePath.dirname(CURRENT_FILE_PATH)
const PACKAGE_ENV_PATH = nodePath.resolve(CURRENT_DIR_PATH, '.env')
const DIST_ENV_PATH = nodePath.resolve(CURRENT_DIR_PATH, '..', '.env')

const ENV_FILE_PATH = [
  PACKAGE_ENV_PATH,
  DIST_ENV_PATH
].find((candidatePath) => fs.existsSync(candidatePath))

if (ENV_FILE_PATH) {
  dotenv.config({
    path: ENV_FILE_PATH
  })
} else {
  dotenv.config()
}

const app_id = process.env['APP_ID']
const private_key_path = process.env['PRIVATE_KEY_PATH']
const secret = process.env['WEBHOOK_SECRET']
const enterprise_hostname = process.env['ENTERPRISE_HOSTNAME']
const github_api_version = process.env['GITHUB_API_VERSION'] || '2026-03-10'
const port = process.env['PORT'] || 30000
const webhook_path = '/api/webhook'
const repository_review_dispatch_path = '/api/repository-review/dispatch'
const repository_review_dispatch_max_body_bytes = Number.parseInt(
  process.env['SEC_BOT_DISPATCH_MAX_BODY_BYTES'] || '1048576',
  10
)
const repository_review_dispatch_read_timeout_ms = Number.parseInt(
  process.env['SEC_BOT_DISPATCH_READ_TIMEOUT_MS'] || '10000',
  10
)
const input_bundle_staging_root = nodePath.resolve(
  process.cwd(),
  process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] || '.agent-input-bundles'
)
const app_state_root = nodePath.resolve(
  process.cwd(),
  process.env['SEC_REVIEW_APP_STATE_ROOT'] || '.agent-app-state'
)
const runner_run_state_db_path = nodePath.join(app_state_root, 'runner-runs.sqlite')

export {
  app_id,
  private_key_path,
  secret,
  enterprise_hostname,
  github_api_version,
  port,
  webhook_path,
  repository_review_dispatch_path,
  repository_review_dispatch_max_body_bytes,
  repository_review_dispatch_read_timeout_ms,
  input_bundle_staging_root,
  app_state_root,
  runner_run_state_db_path
}
