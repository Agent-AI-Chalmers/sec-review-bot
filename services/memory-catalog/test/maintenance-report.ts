import type { MaintenanceReport } from '../src/contract-types-generated.js'

export function learningReport(extractionIds: string[]): MaintenanceReport {
  return {
    summary: 'Added consumed observations to memory.',
    observation_decisions: extractionIds.map((observation_id) => ({
      observation_id,
      action: 'added',
      topics: ['/memory/topics/example.md'],
      reason: 'Adds durable review guidance.',
    })),
  }
}

export const reorganizationReport: MaintenanceReport = {
  summary: 'Reviewed memory; no observations consumed.',
  observation_decisions: [],
}
