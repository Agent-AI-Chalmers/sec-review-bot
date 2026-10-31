import type { FastifyReply, FastifyRequest } from 'fastify'

import type {
  OperationOptionsById,
  OperationResponseById
} from '../contract-types-generated.js'

export type OperationId = keyof OperationOptionsById

export type OperationRequest<Id extends OperationId> = FastifyRequest<{
  Body: OperationOptionsById[Id]['body']
  Params: OperationOptionsById[Id]['path']
  // listRuns declares a form/explode object: its filter properties are top-level query keys.
  Querystring: Id extends 'listRuns'
    ? NonNullable<OperationOptionsById['listRuns']['query']>['filter']
    : OperationOptionsById[Id]['query']
}>

type OperationResult<Id extends OperationId> =
  | (OperationResponseById[Id] extends undefined
      ? void
      : OperationResponseById[Id])
  | FastifyReply

export type OperationHandler<Id extends OperationId> = (
  request: OperationRequest<Id>,
  reply: FastifyReply
) => OperationResult<Id> | Promise<OperationResult<Id>>

/** Each operation owns its request and success result; the assembled registry must be complete. */
export type OperationHandlers = {
  [Id in OperationId]: OperationHandler<Id>
}
