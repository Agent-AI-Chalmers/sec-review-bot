import fs from 'fs/promises'
import path from 'path'

import { WORKSPACE_SNAPSHOT_TAR_NAME } from '../artifacts/git-workspace.js'

export const INPUT_BUNDLE_MANIFEST_NAME = 'manifest.json'

export async function writeInputBundleManifest({
  input_bundle_root,
  include_incremental_window,
  trusted_setup_path
}: {
  input_bundle_root: string
  include_incremental_window: boolean
  /**
   * Bundle-relative path to the trusted setup declaration (e.g.
   * `trusted-setup/setup.yml`). Omit when the repository has no declaration;
   * the field is optional and its absence means "no trusted setup".
   */
  trusted_setup_path?: string
}): Promise<void> {
  const manifest: Record<string, unknown> = {
    contract_version: 'v6',
    kind: 'runner-input-bundle',
    workspace: {
      snapshot: WORKSPACE_SNAPSHOT_TAR_NAME
    },
    history: {
      path: 'history'
    }
  }
  if (trusted_setup_path) {
    manifest.trusted_setup = {
      path: trusted_setup_path
    }
  }
  if (include_incremental_window) {
    manifest.incremental_window = {
      path: 'incremental-window'
    }
  }
  await fs.writeFile(
    path.join(input_bundle_root, INPUT_BUNDLE_MANIFEST_NAME),
    JSON.stringify(manifest, null, 2),
    'utf8'
  )
}
