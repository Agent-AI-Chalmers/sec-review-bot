import express from 'express'
import { db } from './db'

const router = express.Router()

router.post('/api/admin/users/:id/role', async (req, res) => {
  const requestedRole = String(req.body.role || '')
  await db.users.updateRole(req.params.id, requestedRole)
  res.json({ ok: true })
})

export default router
