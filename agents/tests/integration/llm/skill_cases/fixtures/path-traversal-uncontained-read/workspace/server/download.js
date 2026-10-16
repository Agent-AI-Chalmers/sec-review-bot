const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'exports')

exports.download = async function download(req, res) {
  const name = req.query.file
  const target = path.join(root, name)
  const data = await fs.promises.readFile(target)
  res.type('application/octet-stream').send(data)
}
