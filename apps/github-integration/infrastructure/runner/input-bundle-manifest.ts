import fs from 'fs/promises'
import path from 'path'

import { WORKSPACE_SNAPSHOT_TAR_NAME } from './git-workspace.js'

export const INPUT_BUNDLE_MANIFEST_NAME = 'manifest.json'

export async function writeInputBundleManifest ({
  input_bundle_root,
  include_incremental_window
}: {
  input_bundle_root: string
  include_incremental_window: boolean
}): Promise<void> {
  const manifest: Record<string, unknown> = {
    contract_version: 'v4',
    kind: 'runner-input-bundle',
    workspace: {
      snapshot: WORKSPACE_SNAPSHOT_TAR_NAME
    },
    history: {
      path: 'history'
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
