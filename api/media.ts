// Client-upload token endpoint for room media. Browsers upload media BLOBS
// directly to Vercel Blob storage (serverless bodies cap at ~4.5MB — a real
// clip never fits), this function only signs the request. The pathname is
// forced under the room's media prefix so a token can't write anywhere else.

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const ROOM_RE = /^[a-z0-9-]{4,40}$/i
/** Per-file ceiling — a typical gameplay source fits; absurdities don't. */
const MAX_MEDIA_BYTES = 512 * 1024 * 1024

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  const room = String(req.query.room ?? '')
  if (!ROOM_RE.test(room)) {
    res.status(400).json({ error: 'bad room id' })
    return
  }
  const prefix = `reel-rooms/${room}/media/`
  try {
    const result = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(prefix)) throw new Error('pathname outside the room media prefix')
        return {
          maximumSizeInBytes: MAX_MEDIA_BYTES,
          addRandomSuffix: false,
          allowOverwrite: true,
          // Media types only — the relay log has its own endpoint.
          allowedContentTypes: ['video/*', 'audio/*', 'image/*', 'application/octet-stream'],
        }
      },
      onUploadCompleted: async () => {
        // Nothing to do server-side; peers discover uploads via the room list.
      },
    })
    res.status(200).json(result)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'upload token error' })
  }
}
