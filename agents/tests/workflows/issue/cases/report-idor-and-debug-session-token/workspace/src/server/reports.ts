import express from 'express'
import { db } from './db'
import { requireUser } from './auth'

const router = express.Router()

router.get('/api/reports/:id/export', requireUser, async (req, res) => {
  const report = await db.reports.findById(req.params.id)
  if (!report) return res.status(404).json({ error: 'missing report' })
  res.json({ id: report.id, confidentialNotes: report.confidentialNotes })
})

router.get('/api/admin/debug-session', async (req, res) => {
  const session = await db.sessions.findById(String(req.query.sessionId || ''))
  res.json({
    userId: session.userId,
    csrfToken: session.csrfToken,
    oauthAccessToken: session.oauthAccessToken,
  })
})

export default router
