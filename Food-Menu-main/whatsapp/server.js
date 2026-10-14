'use strict'

const path = require('path')
const fs = require('fs')
const http = require('http')
const express = require('express')
const { Server } = require('socket.io')
const pino = require('pino')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000
// WhatsApp session files yahan save hote hain. Server start (restart/redeploy)
// pe agar auth files maujud hain to session apne aap as-is resume hota hai -
// dobara QR scan ki zaroorat nahi.
// Render pe Disk mount karne par (/data/wa-auth) wo khud detect ho jata hai,
// warna local .wa-auth/ folder use hota hai.
const AUTH_DIR = process.env.AUTH_DIR
  || (fs.existsSync('/data') ? '/data/wa-auth' : path.join(__dirname, '.wa-auth'))
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch (_) {}
// Food menu project (ek folder upar) + WhatsApp connect page
const FOOD_DIR = path.join(__dirname, '..')
const FOOD_PAGE = path.join(FOOD_DIR, 'index.html')
const WA_PAGE = path.join(__dirname, 'index.html')
// Optional security PIN: agar set ho to API/socket ko PIN chahiye hoga
const ACCESS_PIN = process.env.ACCESS_PIN || ''

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: true } })

app.use(express.json({ limit: '20kb' }))

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const wa = { status: 'disconnected', qr: null, user: null }
// status: 'connecting' | 'qr' | 'connected' | 'disconnected'
let sock = null
let intentionalClose = false
let restartTimer = null

const snapshot = () => ({
  status: wa.status,
  qr: wa.qr,
  user: wa.user,
  pinRequired: Boolean(ACCESS_PIN),
})

const push = () => io.emit('state', snapshot())

function pinOk(pin) {
  if (!ACCESS_PIN) return true
  return String(pin || '') === ACCESS_PIN
}

// ---------------------------------------------------------------------------
// Order-alert dedup: ek order ka alert sirf EK baar bhejo, chahe admin ke
// kitne bhi tabs/browsers khule hon (server hi decide karta hai)
// ---------------------------------------------------------------------------
const notifiedOrders = new Map() // orderId -> sentAt (ms)
const NOTIFY_TTL = 48 * 60 * 60 * 1000 // 48 ghante baad bhool jao

function alreadyNotified(orderId) {
  const now = Date.now()
  if (notifiedOrders.size > 500) {
    for (const [id, t] of notifiedOrders) if (now - t > NOTIFY_TTL) notifiedOrders.delete(id)
  }
  const t = notifiedOrders.get(orderId)
  return t !== undefined && now - t < NOTIFY_TTL
}

function markNotified(orderId) {
  notifiedOrders.set(orderId, Date.now())
}

// Phone number normalize + validate -> full digits (ya null)
function normalizePhone(raw, countryCode) {
  const s = String(raw || '').trim()
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  // Agar "+" se shuru hua to wahi final number, warna country code prefix hoga
  const full = s.startsWith('+') ? digits : String(countryCode || '+91').replace(/\D/g, '') + digits
  if (!/^\d{7,15}$/.test(full)) return null
  return full
}

// WhatsApp pe actual delivery - connected check + existence probe + send
async function deliverText(full, text) {
  if (!sock || wa.status !== 'connected') {
    return { ok: false, status: 400, error: 'Pehle WhatsApp connect kariye (QR scan kariye).' }
  }
  const jid = full + '@s.whatsapp.net'

  // Number WhatsApp par hai ya nahi - check karo (best effort)
  try {
    const check = await sock.onWhatsApp(jid)
    if (Array.isArray(check) && check.length && check[0] && check[0].exists === false) {
      return { ok: false, status: 404, error: '+' + full + ' WhatsApp par nahi hai.' }
    }
  } catch (_) { /* check fail ho to bhi send try karenge */ }

  const sent = await sock.sendMessage(jid, { text })
  const id = sent && sent.key && sent.key.id
  console.log('[wa] message sent -> +' + full + ' id=' + id)
  return { ok: true, id: id || null, to: '+' + full }
}

function apiGuard(req, res, next) {
  const pin = req.headers['x-pin'] || req.query.pin
  if (pinOk(pin)) return next()
  res.status(401).json({ ok: false, error: 'PIN galat hai. Sahi PIN daaliye.' })
}

// ---------------------------------------------------------------------------
// Baileys socket
// ---------------------------------------------------------------------------
async function startWa() {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (sock) {
    const old = sock
    sock = null
    intentionalClose = true
    try { old.end(undefined) } catch (_) {}
    intentionalClose = false
  }

  wa.status = 'connecting'
  wa.qr = null
  wa.user = null
  push()

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch (_) {}

  const opts = {
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp Link System', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  }
  if (version) opts.version = version

  const s = makeWASocket(opts)
  sock = s

  // Purane socket ke events ignore ho jaate hain (session replace ho chuka hai)
  s.ev.on('creds.update', (c) => {
    if (sock !== s) return
    saveCreds(c).catch((e) => console.error('[wa] saveCreds', e && e.message))
  })

  s.ev.on('connection.update', (u) => {
    if (sock !== s) return
    handleUpdate(u)
  })
}

function handleUpdate(u) {
  const { connection, lastDisconnect, qr } = u

  if (qr) {
    wa.status = 'qr'
    wa.qr = qr
    push()
    console.log('[wa] QR mila - browser me scan karne ke liye ready')
  }

  if (connection === 'open') {
    wa.status = 'connected'
    wa.qr = null
    wa.user = {
      id: (sock.user && sock.user.id) || null,
      name: (sock.user && sock.user.name) || null,
    }
    push()
    console.log('[wa] connected ->', wa.user.id)
  }

  if (connection === 'close') {
    const err = lastDisconnect && lastDisconnect.error
    const code = err && err.output && err.output.statusCode
    const loggedOut = code === DisconnectReason.loggedOut
    console.log('[wa] connection closed, code=' + code + ' loggedOut=' + loggedOut)

    sock = null
    wa.status = 'disconnected'
    wa.qr = null
    wa.user = null
    push()

    if (intentionalClose) return

    // Logged out = session dead -> auth wipe karke fresh QR generate karo
    if (loggedOut) {
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch (_) {}
    }

    if (!restartTimer) {
      restartTimer = setTimeout(() => {
        restartTimer = null
        startWa().catch((e) => console.error('[wa] restart failed:', e && e.message))
      }, loggedOut ? 1500 : 4000)
    }
  }
}

// ---------------------------------------------------------------------------
// Pages: Food menu (root) + WhatsApp system (/whatsapp)
// ---------------------------------------------------------------------------
// Server ke internal files static serving se block karo
app.use((req, res, next) => {
  if (/^\/whatsapp\/(server\.js|package[^/]*\.json|node_modules)/.test(req.path)) {
    return res.status(404).end()
  }
  next()
})

// WhatsApp connect page (QR system)
app.get(['/whatsapp', '/whatsapp/'], (req, res) => res.sendFile(WA_PAGE))

// Food menu app (admin panel isi ke andar hai)
app.get(['/', '/index.html'], (req, res) => res.sendFile(FOOD_PAGE))

// Food menu ke assets (firebase-config.js, images, manifest, order.mp3...)
app.use(express.static(FOOD_DIR, { index: false }))

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/api/status', apiGuard, (req, res) => {
  res.json(snapshot())
})

app.post('/api/connect', apiGuard, async (req, res) => {
  try {
    if (wa.status === 'connected' || wa.status === 'connecting' || wa.status === 'qr') {
      return res.json(snapshot())
    }
    await startWa()
    res.json(snapshot())
  } catch (e) {
    console.error('[api] connect error', e)
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

app.post('/api/logout', apiGuard, async (req, res) => {
  const old = sock
  sock = null
  intentionalClose = true
  try { if (old) await old.logout() } catch (e) { console.error('[wa] logout', e && e.message) }
  try { if (old) old.end(undefined) } catch (_) {}
  intentionalClose = false

  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch (_) {}

  wa.status = 'disconnected'
  wa.qr = null
  wa.user = null
  push()

  try { await startWa() } catch (e) { console.error('[wa] restart after logout', e && e.message) }
  res.json(snapshot())
})

app.post('/api/send', apiGuard, async (req, res) => {
  try {
    const body = req.body || {}
    const text = String(body.message || '').trim()

    if (!text) return res.status(400).json({ ok: false, error: 'Message khaali hai.' })
    if (text.length > 4096) {
      return res.status(400).json({ ok: false, error: 'Message 4096 characters se chhota rakhiye.' })
    }

    const full = normalizePhone(body.phone, body.countryCode)
    if (!String(body.phone || '').trim()) return res.status(400).json({ ok: false, error: 'Phone number daaliye.' })
    if (!full) return res.status(400).json({ ok: false, error: 'Number galat lag raha hai (7-15 digits hone chahiye).' })

    const r = await deliverText(full, text)
    res.status(r.ok ? 200 : r.status).json(r)
  } catch (e) {
    console.error('[api] send error', e)
    res.status(500).json({ ok: false, error: 'Message nahi bheja: ' + String((e && e.message) || e) })
  }
})

// Order-alert endpoint: admin ka browser (menu ya admin panel - kisi bhi page
// pe) naya order detect karke yahan bhejta hai. orderId se dedup -> sirf EK
// message jayega, chahe admin ke kitne bhi tabs/browsers khule hon.
app.post('/api/notify', apiGuard, async (req, res) => {
  try {
    const body = req.body || {}
    const text = String(body.message || '').trim()
    const orderId = String(body.orderId || '').trim()

    if (!text) return res.status(400).json({ ok: false, error: 'Message khaali hai.' })
    if (text.length > 4096) {
      return res.status(400).json({ ok: false, error: 'Message 4096 characters se chhota rakhiye.' })
    }

    const full = normalizePhone(body.phone, body.countryCode)
    if (!full) return res.status(400).json({ ok: false, error: 'Number galat lag raha hai (7-15 digits hone chahiye).' })

    // Dedup: ye order pehle hi kisi aur tab/browser se notify ho chuka hai
    if (orderId && alreadyNotified(orderId)) {
      return res.json({ ok: true, deduped: true, to: '+' + full })
    }

    const r = await deliverText(full, text)
    if (r.ok && orderId) markNotified(orderId)
    res.status(r.ok ? 200 : r.status).json(r)
  } catch (e) {
    console.error('[api] notify error', e)
    res.status(500).json({ ok: false, error: 'Message nahi bheja: ' + String((e && e.message) || e) })
  }
})

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  const pin = socket.handshake.auth && socket.handshake.auth.pin
  if (!pinOk(pin)) {
    socket.emit('state', { denied: true, pinRequired: true })
    socket.disconnect(true)
    return
  }
  socket.emit('state', snapshot())
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))

server.listen(PORT, () => {
  console.log('Server chal raha hai -> http://localhost:' + PORT)
  console.log('[wa] auth dir ->', AUTH_DIR, '(yahan session save hota hai — restart pe yahi se resume)')
  // Boot pe saved session apne aap resume: agar auth files maujud hain to
  // bina QR scan ke WhatsApp connect ho jayega, warna naya QR generate hoga.
  startWa().catch((e) => console.error('[wa] start failed:', e && e.message))
})
