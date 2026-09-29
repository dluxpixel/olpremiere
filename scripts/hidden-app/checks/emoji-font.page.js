(async () => {
  const RANGE = 'U+2600-27BF, U+FE0F, U+200D, U+1F000-1FAFF'
  const out = {}
  const t = performance.now()
  const r = await fetch('/user-fonts/apple-emoji.ttf')
  out.status = r.status
  const buf = await r.arrayBuffer()
  out.mb = +(buf.byteLength / 1e6).toFixed(1)
  out.fetchMs = Math.round(performance.now() - t)
  const face = new FontFace('OLP Apple Emoji', 'url(/user-fonts/apple-emoji.ttf)', { unicodeRange: RANGE })
  await face.load()
  document.fonts.add(face)
  out.page = face.status
  const c = document.createElement('canvas')
  c.width = 900
  c.height = 360
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#123'
  ctx.fillRect(0, 0, 900, 360)
  ctx.fillStyle = '#fff'
  ctx.font = "700 90px 'OLP Apple Emoji', 'Segoe UI', sans-serif"
  ctx.fillText('page 😂🔥💀', 20, 110)
  function workerMain() {
    self.onmessage = async (e) => {
      const f = new FontFace('OLP Apple Emoji', 'url(' + e.data.url + ')', { unicodeRange: e.data.range })
      await f.load()
      self.fonts.add(f)
      const oc = new OffscreenCanvas(900, 140)
      const x = oc.getContext('2d')
      x.fillStyle = '#fff'
      x.font = "700 90px 'OLP Apple Emoji', 'Segoe UI', sans-serif"
      x.fillText('worker 😭❤️', 20, 110)
      const bmp = oc.transferToImageBitmap()
      self.postMessage(bmp, [bmp])
    }
  }
  const w = new Worker(URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' })))
  const bmp = await new Promise((res, rej) => {
    w.onmessage = (e) => res(e.data)
    w.onerror = (e) => rej(new Error('worker: ' + e.message))
    w.postMessage({ url: location.origin + '/user-fonts/apple-emoji.ttf', range: RANGE })
  })
  ctx.drawImage(bmp, 0, 180)
  out.png = c.toDataURL()
  return out
})()
