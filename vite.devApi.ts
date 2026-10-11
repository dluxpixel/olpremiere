import type { Plugin } from 'vite'

/**
 * THE DEV SERVER HAS NO RELAY, SO /api/* IS A 404 THERE (2026-10-11).
 *
 * The collab relay and the media upload live in api/room.ts and api/media.ts, which
 * only Vercel runs. In dev nothing serves them, and the app asks anyway:
 * relayAvailable() (collab/httpTransport.ts) probes `/api/room` the moment a room
 * starts or is joined, and a 404 is its answer for "no relay, use tabs".
 *
 * But `/api/room` has no file extension, and Vite takes an extensionless URL for a
 * module. It found api/room.ts, COMPILED it and sent it back as JavaScript. That
 * compile imports `@vercel/blob`, a server only package no page ever loads, so on a
 * cold dependency cache Vite logged "new dependencies optimized: @vercel/blob ...
 * reloading" and reloaded EVERY open page a few seconds later. In the gate that was
 * the first collab spec, with both tabs mid edit: both pages reloaded and tab B
 * ended on an empty sequence (collab.spec.ts line 31, 0 clips for 15 s). A warm
 * cache hid it, which is why it passed alone and failed only on a cold one.
 *
 * Answered before Vite's own middleware, nothing under api/ is ever compiled for the
 * browser, so no server only dependency can be found mid test. Dev only: a build
 * never serves anything and Vercel runs the real functions.
 */
export function devApiNotFound(): Plugin {
  return {
    name: 'olp-dev-api-not-found',
    apply: 'serve',
    configureServer(server) {
      // Registered here, not in the returned hook: that one runs AFTER the
      // transform middleware this has to get in front of.
      server.middlewares.use('/api', (_req, res) => {
        res.statusCode = 404
        res.end()
      })
    },
  }
}
