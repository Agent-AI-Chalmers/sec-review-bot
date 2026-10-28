import type { OperationOptionsById } from './execution-api-types-generated.js'

type OperationId = keyof OperationOptionsById
type Operation<Id extends OperationId> = OperationOptionsById[Id]

export type RequestBody<Id extends OperationId> =
  Operation<Id> extends { body: infer Body } ? Body : never

export type PathParameters<Id extends OperationId> =
  Operation<Id> extends { path: infer Parameters } ? Parameters : never
