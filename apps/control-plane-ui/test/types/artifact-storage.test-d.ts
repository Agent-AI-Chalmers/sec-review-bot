// Archive availability must retain its reference requirements, independently of generation freshness.
import { expectTypeOf, test } from 'vitest'

import type { ArtifactStorage } from '../../browser/features/runs/api.js'

type Storage = NonNullable<ArtifactStorage>
type Archive = {
  kind: 'execution_archive'
  uri: string
  media_type: 'application/tar+zstd'
  digest: string
  size_bytes: number
}

test('available storage accepts a complete archive reference', () => {
  expectTypeOf<{ status: 'available'; artifact: Archive }>().toExtend<Storage>()
})

test('available storage requires an archive', () => {
  expectTypeOf<{ status: 'available' }>().not.toExtend<Storage>()
})

test('an available archive requires its URI', () => {
  expectTypeOf<{
    status: 'available'
    artifact: Omit<Archive, 'uri'>
  }>().not.toExtend<Storage>()
})

test('an available archive requires its digest', () => {
  expectTypeOf<{
    status: 'available'
    artifact: Omit<Archive, 'digest'>
  }>().not.toExtend<Storage>()
})

test('unavailable storage needs no archive reference', () => {
  expectTypeOf<{ status: 'unavailable' }>().toExtend<Storage>()
})
