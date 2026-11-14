// Type behavior matters independently of generated-file freshness: a generator regression
// must not let UI callers treat an available archive as missing its reference.
import type { ArtifactStorage } from '../browser/features/runs/api.js'

type Expect<T extends true> = T
type Storage = NonNullable<ArtifactStorage>
type Archive = {
  kind: 'execution_archive'
  uri: string
  media_type: 'application/tar+zstd'
  digest: string
  size_bytes: number
}

export type AvailableArchiveIsAccepted = Expect<
  { status: 'available'; artifact: Archive } extends Storage ? true : false
>

export type AvailableStorageRequiresArtifact = Expect<
  { status: 'available' } extends Storage ? false : true
>

export type AvailableArchiveRequiresUri = Expect<
  { status: 'available'; artifact: Omit<Archive, 'uri'> } extends Storage
    ? false
    : true
>

export type AvailableArchiveRequiresDigest = Expect<
  { status: 'available'; artifact: Omit<Archive, 'digest'> } extends Storage
    ? false
    : true
>

export type UnavailableStorageNeedsNoArtifact = Expect<
  { status: 'unavailable' } extends Storage ? true : false
>
