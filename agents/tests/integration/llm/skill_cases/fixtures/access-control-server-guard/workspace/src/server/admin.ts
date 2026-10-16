export async function updateRole(req, res) {
  const actor = await requireSession(req)
  if (!actor.roles.includes('admin')) {
    res.status(403).end()
    return
  }
  await db.users.updateRole(req.params.id, req.body.role)
  res.json({ ok: true })
}
