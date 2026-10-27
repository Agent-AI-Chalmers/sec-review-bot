import type { FastifyReply, FastifyRequest } from 'fastify'

export type OperationHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => unknown

export type OperationHandlers = Record<string, OperationHandler>
