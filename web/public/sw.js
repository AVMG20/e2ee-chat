// Service worker: lets the installed app open without a connection.
// Only the app's own files are cached (never messages: those stay encrypted in IndexedDB).
// Pages come from the network first, so a new version is used as soon as the server has it.
// One cache per build (the page registers sw.js?v=<build>); older ones are deleted on activate.
const CACHE = 'e2ee-chat-' + (new URL(self.location.href).searchParams.get('v') || 'dev')

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (res.ok && res.type === 'basic') await cache.put(key ?? request, res.clone())
    return res
  } catch (e) {
    const hit = await cache.match(key ?? request)
    if (hit) return hit
    throw e
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  // A missing file gets the app page back (200, text/html): never keep that under an asset's name.
  const html = (res.headers.get('content-type') || '').includes('text/html')
  if (res.ok && res.type === 'basic' && !html) await cache.put(request, res.clone())
  return res
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname === '/ws' || url.pathname === '/healthz') return
  if (req.mode === 'navigate') {
    // Every page of the app is index.html.
    event.respondWith(networkFirst(req, '/'))
  } else if (url.pathname.startsWith('/assets/')) {
    // Built files have a content hash in their name and never change.
    event.respondWith(cacheFirst(req))
  } else {
    event.respondWith(networkFirst(req))
  }
})
