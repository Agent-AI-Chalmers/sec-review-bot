exports.listReports = async function listReports(req, res) {
  const sort = req.query.sort || 'created_at desc'
  const rows = await db('reports')
    .where({ tenant_id: req.user.tenantId })
    .orderByRaw(sort)
  res.json(rows)
}
