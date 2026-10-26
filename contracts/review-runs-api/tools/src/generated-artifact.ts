// The shape a generator uses to declare what it produces.
//
// A generator exposes its outputs as `{ output, render }`, where `output` is an absolute path
// and `render()` returns the exact bytes that belong there (sync or async). `generate` writes
// each and `check` compares each to the committed file, so both walk the same description.
export interface GeneratedArtifact {
  /** Absolute path of the file this generator writes. */
  output: string
  /** The exact content that belongs at {@link output}. */
  render: () => string | Promise<string>
}
