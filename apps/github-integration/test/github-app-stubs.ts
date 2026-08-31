import type { App } from 'octokit'

interface InstallationAppStubOptions {
  installation_octokit: unknown
  installation_id?: number
  expected_owner?: string
  expected_repo?: string
}

export function appWithInstallationOctokit ({
  installation_octokit,
  installation_id = 123,
  expected_owner,
  expected_repo
}: InstallationAppStubOptions): App {
  return {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async ({ owner, repo }: { owner: string, repo: string }) => {
            if (expected_owner !== undefined && owner !== expected_owner) {
              throw new Error(`Unexpected installation owner: ${owner}`)
            }
            if (expected_repo !== undefined && repo !== expected_repo) {
              throw new Error(`Unexpected installation repo: ${repo}`)
            }
            return {
              data: {
                id: installation_id
              }
            }
          }
        }
      }
    },
    getInstallationOctokit: async (requested_installation_id: number) => {
      if (requested_installation_id !== installation_id) {
        throw new Error(`Unexpected installation id: ${requested_installation_id}`)
      }
      return installation_octokit
    }
  } as unknown as App
}
