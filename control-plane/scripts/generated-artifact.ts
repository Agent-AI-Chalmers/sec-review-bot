// The shape every generator uses to declare what it produces.
//
// A generator exposes its outputs as a list of `{ output, render }`, where `output` is an
// absolute path and `render()` returns the exact bytes that belong at that path (sync or
// async). A single contract checker walks these lists from the manifest, renders each output,
// and compares it to disk — so "what is generated" and "is the committed copy fresh" have one
// description instead of being restated in each test.
export interface GeneratedArtifact {
  /** Absolute path of the file this generator writes. */
  output: string
  /** The exact content that belongs at {@link output}. */
  render: () => string | Promise<string>
}
