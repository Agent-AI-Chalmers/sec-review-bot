import { Octokit, App } from 'octokit'
import fs from 'fs'

import { app_id, private_key_path, secret, enterprise_hostname, github_api_version } from './config.js'

const defaultOctokit = Octokit.defaults({
  // Keep explicit REST API version to avoid deprecated API behavior.
  // Docs: https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10
  headers: {
    'X-GitHub-Api-Version': github_api_version
  }
})

function requireConfigValue (name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export function createGitHubApp () {
  const required_app_id = requireConfigValue('APP_ID', app_id)
  const required_private_key_path = requireConfigValue('PRIVATE_KEY_PATH', private_key_path)
  const required_secret = requireConfigValue('WEBHOOK_SECRET', secret)
  const private_key = fs.readFileSync(required_private_key_path, 'utf8')

  return new App({
    appId: required_app_id,
        privateKey: private_key,
    webhooks: {
      secret: required_secret
    },
    Octokit: defaultOctokit,
    ...(enterprise_hostname && {
      Octokit: defaultOctokit.defaults({
        baseUrl: `https://${enterprise_hostname}/api/v3`
      })
    })
  })
}
