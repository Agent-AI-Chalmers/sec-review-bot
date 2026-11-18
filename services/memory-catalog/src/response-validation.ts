import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { FastifyInstance, preSerializationHookHandler } from 'fastify'

/** Check response objects before Fastify serializes or projects their fields. */
export function registerResponseValidation(app: FastifyInstance): void {
  const ajv = new Ajv2020.default({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false
  })
  addFormats.default(ajv)
  app.addHook('onRoute', (route) => {
    if (!route.schema?.response) {
      return
    }
    const validators = new Map(
      Object.entries(route.schema.response).map(([status, schema]) => [
        status,
        ajv.compile(schema as object)
      ])
    )
    const validateResponse: preSerializationHookHandler = (_request, reply, payload, done) => {
      const validate = validators.get(String(reply.statusCode))
      if (!validate || !validate(payload)) {
        done(
          new Error(
            `Memory Catalog response violates contract: ${validate ? ajv.errorsText(validate.errors) : 'undocumented status'}`
          )
        )
        return
      }
      done(null, payload)
    }
    const previous = route.preSerialization
    route.preSerialization = [
      ...(Array.isArray(previous) ? previous : previous ? [previous] : []),
      validateResponse
    ]
  })
}
