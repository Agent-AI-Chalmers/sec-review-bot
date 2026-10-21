import express from 'express'
import { db } from './db'
import { requireUser } from './auth'

const router = express.Router()

router.get('/api/reports/:id/export', requireUser, async (req, res) => {
  const report = await db.reports.findById(req.params.id)
  if (!report) {
    res.status(404).json({ error: 'missing report' })
    return
  }
  const exportBody = await buildReportExport(report)
  res.json(exportBody)
})

router.get('/api/reports/search', requireUser, async (req, res) => {
  const query = String(req.query.q || '')
  const rows = await db.query(
    'select id, title from reports where owner_id = $1 and title ilike $2',
    [req.user.id, `%${query}%`],
  )
  res.json({ rows })
})

async function buildReportExport(report) {
  return {
    id: report.id,
    title: report.title,
    confidentialNotes: report.confidentialNotes,
  }
}

export default router
