import express from 'express'
import { db } from './db'
import { makeInviteToken } from '@acme/invite-tokens'

const router = express.Router()

export async function createInvite(req, res) {
  const token = await makeInviteToken({ orgId: req.user.orgId })
  await db.invites.insert({
    token,
    orgId: req.user.orgId,
    role: 'member',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    redeemedAt: null,
  })
  res.json({ inviteUrl: `${process.env.APP_URL}/join?token=${token}` })
}

router.post('/api/invites/redeem', async (req, res) => {
  const invite = await db.invites.findFirst({
    where: {
      token: String(req.body.token || ''),
      expiresAt: { gte: new Date() },
    },
  })
  if (!invite) return res.status(404).json({ error: 'invalid invite' })

  const user = await db.users.create({
    email: String(req.body.email || ''),
    orgId: invite.orgId,
    role: invite.role,
  })
  res.json({ userId: user.id })
})

export default router
