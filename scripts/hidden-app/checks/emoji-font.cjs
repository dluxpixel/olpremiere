// Fetches the Apple emoji font through the app's own app:// route (which starts
// the one-time download when it is not on disk yet) and draws with it in the
// page and in a worker, like the preview and the export worker do. Writes
// emoji.png. Pass --seed-font to skip the download.
const fs = require('fs')
const path = require('path')

module.exports = async ({ wc, root }) => {
  const r = await wc.executeJavaScript(fs.readFileSync(path.join(__dirname, 'emoji-font.page.js'), 'utf8'))
  fs.writeFileSync(path.join(root, 'emoji.png'), Buffer.from(r.png.split(',')[1], 'base64'))
  delete r.png
  return r
}
