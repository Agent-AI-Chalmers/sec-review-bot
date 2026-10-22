import type { operations } from './contract-types-generated.js'

type OperationId = keyof operations
type Operation<Id extends OperationId> = operations[Id]

export type RequestBody<Id extends OperationId> =
  Operation<Id> extends {
    requestBody: { content: { 'application/json': infer Body } }
  }
    ? Body
    : never

export type PathParameters<Id extends OperationId> =
  Operation<Id> extends { parameters: { path: infer Parameters } }
    ? Parameters
    : never

export type QueryParameters<Id extends OperationId> =
  Operation<Id> extends { parameters: { query?: infer Parameters } }
    ? Parameters
    : never
