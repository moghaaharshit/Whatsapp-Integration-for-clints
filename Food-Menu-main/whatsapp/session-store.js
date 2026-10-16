'use strict'

/*
 * ─── WhatsApp session store (Firestore) ─────────────────────────────────────────
 * Connect hone ke baad WhatsApp session (Baileys auth state) Firestore me save
 * hota hai → server restart / redeploy ke baad bhi bina QR scan ke reconnect.
 *
 * Storage model: useMultiFileAuthState ke files ko ek Firestore doc ke andar
 * `{ v, files: { 'creds.json': '<json>', 'session-...json': '<json>' } }` ki
 * tarah rakha jaata hai — bilkul wahi BufferJSON strings jo local folder me
 * jaati hain, isliye behaviour/file-naming 1:1 compatible hai. Agar Firestore me
 * session na mile aur local `.wa-auth/` me purana session ho to wo ek baar
 * Firestore me migrate ho jaata hai (dobara QR scan nahi karna padta).
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT       service account JSON (string ya base64)
 *   FIREBASE_SERVICE_ACCOUNT_FILE  service account JSON file ka path (alt)
 *   GOOGLE_APPLICATION_CREDENTIALS standard ADC (alt)
 *   FIREBASE_PROJECT_ID            optional project id override
 *   WA_SESSION_COLLECTION          default: waSessions
 *   WA_SESSION_DOC                 default: default (ek WhatsApp = ek doc)
 *   WA_SESSION_KEY                 optional passphrase → AES-256-GCM at rest
 *   WA_SESSION_RETRY_MS            firestore load retry gap (default 3000)
 *
 * Firebase configured NA ho (koi env nahi) to purana local-file mode
 * (`useMultiFileAuthState`) hi chalta hai — behaviour pehle jaisi.
 * Firestore configured hai par reachable nahi hai to server warning ke saath
 * us boot me local file mode pe fallback kar deta hai.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { initAuthCreds, BufferJSON, useMultiFileAuthState, proto } = require('@whiskeysockets/baileys')

const COLLECTION = String(process.env.WA_SESSION_COLLECTION || 'waSessions')
const DOC_ID = String(process.env.WA_SESSION_DOC || 'default')
const PASSPHRASE = String(process.env.WA_SESSION_KEY || '')
const RETRY_MS = Number(process.env.WA_SESSION_RETRY_MS) || 3000
const DEBOUNCE_MS = 1500
const MAX_DOC_BYTES = 900 * 1024 // Firestore doc limit 1MB

// useMultiFileAuthState ka file-naming rule (uske saath exact compatible rehne ke liye)
const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

// Har naye auth state ke baad purane state ke late writes Firestore doc ko na
// clobber karein — isliye epoch guard.
let storeEpoch = 0

// ─── codec: session blob ↔ string ───────────────────────────────────────────────
// Note: change-detection hamesha plain JSON par hota hai (enc me random IV hota
// hai, isliye encrypted string har baar alag banti — compare plain se karo).
function encodeJson(json) {
  if (!PASSPHRASE) return 'plain:v1:' + json
  const key = crypto.scryptSync(PASSPHRASE, 'wa-session-salt', 32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  return 'enc:v1:' + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

function encodeSession(obj) {
  return encodeJson(JSON.stringify(obj))
}

function decodeSession(raw) {
  const s = String(raw || '')
  let json
  if (s.startsWith('plain:v1:')) {
    json = s.slice(9)
  } else if (s.startsWith('enc:v1:')) {
    if (!PASSPHRASE) {
      throw new Error('Session encrypted hai lekin WA_SESSION_KEY set nahi hai')
    }
    const [ivB, tagB, ctB] = s.slice(7).split(':')
    const key = crypto.scryptSync(PASSPHRASE, 'wa-session-salt', 32)
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'))
    d.setAuthTag(Buffer.from(tagB, 'base64'))
    json = Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8')
  } else if (s.startsWith('{')) {
    json = s // plain JSON fallback (session passphrase baad me set kiya ho to bhi chale)
  } else {
    throw new Error('Session data ka format pehchan me nahi: ' + s.slice(0, 24))
  }
  return JSON.parse(json)
}

// ─── core: files-map par Baileys auth state ─────────────────────────────────────
// files: { '<fixed-name>.json': '<BufferJSON json string>' }
// write: async (encodedString) => {}   (persist callback; default = noop)
function buildState({ files, write } = {}) {
  const writer = typeof write === 'function' ? write : async () => {}
  const fmap = new Map(Object.entries(files || {}))

  const readRaw = (name) => {
    const raw = fmap.get(name)
    if (typeof raw !== 'string') return null
    try {
      return JSON.parse(raw, BufferJSON.reviver)
    } catch (_) {
      return null
    }
  }
  const ser = (value) => JSON.stringify(value, BufferJSON.replacer)

  let creds = readRaw('creds.json')
  if (!creds) {
    creds = initAuthCreds()
    fmap.set('creds.json', ser(creds))
  }

  const myEpoch = ++storeEpoch
  const isStale = () => storeEpoch !== myEpoch

  let lastWritten = null
  let pending = null
  let timer = null
  let chain = Promise.resolve()

  // creds Baileys in-place mutate karta hai (Object.assign) — isliye har
  // snapshot par fresh serialize, bilkul multi-file state jaisa.
  // snapshot = plain JSON string (encryption write ke waqt hoti hai).
  const snapshot = () => {
    fmap.set('creds.json', ser(creds))
    return JSON.stringify({ v: 1, files: Object.fromEntries(fmap) })
  }

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending === null) return chain
    const data = pending
    if (data === lastWritten) {
      pending = null
      return chain
    }
    pending = null
    chain = chain.then(async () => {
      try {
        const stored = encodeJson(data)
        const bytes = Buffer.byteLength(stored)
        if (bytes > MAX_DOC_BYTES) {
          console.warn('[session] session blob ' + bytes + ' bytes — Firestore doc limit (1MB) ke paas hai')
        }
        await writer(stored)
        lastWritten = data
      } catch (e) {
        console.error('[session] save failed:', e && e.message)
        // agla flush dobara try karega
        if (pending === null) pending = data
      }
    })
    return chain
  }

  const schedule = (immediate) => {
    if (isStale()) return
    pending = snapshot()
    if (immediate) return flush()
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        flush()
      }, DEBOUNCE_MS)
    }
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {}
        for (const id of ids) {
          let value = readRaw(fixFileName(`${type}-${id}.json`))
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          }
          out[id] = value
        }
        return out
      },
      set: async (data) => {
        if (isStale()) return
        for (const category in data) {
          for (const id in data[category]) {
            const name = fixFileName(`${category}-${id}.json`)
            const value = data[category][id]
            if (value) fmap.set(name, ser(value))
            else fmap.delete(name) // falsy = delete (multi-file behaviour)
          }
        }
        schedule(false) // debounce: bursts ek hi write me club ho
      }
    }
  }

  const saveCreds = async () => {
    schedule(true)
    await chain
  }

  const flushAll = async () => {
    if (!isStale()) flush()
    await chain
  }

  return { state, saveCreds, flush: flushAll }
}

// ─── local folder → files map (migration ke liye) ───────────────────────────────
function loadLocalFiles(authDir) {
  const files = {}
  try {
    for (const f of fs.readdirSync(authDir)) {
      if (!f.endsWith('.json')) continue
      const p = path.join(authDir, f)
      if (!fs.statSync(p).isFile()) continue
      files[f] = fs.readFileSync(p, 'utf8')
    }
  } catch (_) {}
  return files
}

// ─── Firestore setup ────────────────────────────────────────────────────────────
let db = null
let FieldValue = null
let mode = null // 'firestore' | 'file'
let modeP = null
let currentFlush = null // current firestore state ka shutdown-flush

function initFirestore() {
  const saJson = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()
  const saFile = String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '').trim()
  const adc = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
  if (!saJson && !saFile && !adc) return false

  const { initializeApp, getApps, cert, applicationDefault } = require('firebase-admin/app')
  const { getFirestore, FieldValue: FV } = require('firebase-admin/firestore')
  FieldValue = FV

  let credential
  if (saJson) {
    let text = saJson
    if (!text.startsWith('{')) {
      // base64 me paste kiya ho to
      try {
        text = Buffer.from(text, 'base64').toString('utf8')
      } catch (_) {}
    }
    let json
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT JSON parse nahi hua: ' + e.message)
    }
    credential = cert(json)
  } else if (saFile) {
    credential = cert(JSON.parse(fs.readFileSync(saFile, 'utf8')))
  } else {
    credential = applicationDefault()
  }

  const opts = { credential }
  if (process.env.FIREBASE_PROJECT_ID) opts.projectId = process.env.FIREBASE_PROJECT_ID
  const app = getApps().length ? getApps()[0] : initializeApp(opts)
  db = getFirestore(app)
  return true
}

// Ek baar decide hota hai: Firestore mode ya local file mode
function resolveMode() {
  if (mode) return Promise.resolve(mode)
  if (!modeP) {
    modeP = (async () => {
      try {
        const fb = initFirestore()
        mode = fb ? 'firestore' : 'file'
        if (fb) {
          console.log(
            '[session] storage -> firestore (' + COLLECTION + '/' + DOC_ID + ', encrypted=' + (PASSPHRASE ? 'yes' : 'no') + ')'
          )
        } else {
          console.log('[session] storage -> local file (FIREBASE_SERVICE_ACCOUNT set nahi hai)')
        }
      } catch (e) {
        console.error('[session] Firebase init fail — local file mode me chalenge:', e && e.message)
        db = null
        mode = 'file'
      }
      return mode
    })()
  }
  return modeP
}

// Session doc 3 tries me load; network/creds ki transient fail par throw
async function readSessionDoc() {
  let lastErr
  for (let i = 1; i <= 3; i++) {
    try {
      const snap = await db.collection(COLLECTION).doc(DOC_ID).get()
      return snap.exists ? snap.data() || {} : {}
    } catch (e) {
      lastErr = e
      console.warn('[session] Firestore load try ' + i + '/3 fail:', e && e.message)
      if (i < 3) await new Promise((r) => setTimeout(r, RETRY_MS))
    }
  }
  throw lastErr
}

// ─── public API ─────────────────────────────────────────────────────────────────

// Firestore doc -> files map. Doc me session ho to wahi, warna local folder
// (migration) — dono na ho to empty (fresh creds banenge, QR aayega).
function filesFromDoc(doc, authDir) {
  let files = null
  if (doc && typeof doc.data === 'string' && doc.data) {
    const payload = decodeSession(doc.data)
    if (payload && typeof payload.files === 'object' && payload.files) files = payload.files
  }
  let migrated = false
  if (!files || !Object.keys(files).length) {
    files = loadLocalFiles(authDir)
    migrated = Object.keys(files).length > 0
  }
  return { files, migrated }
}

// Baileys ke liye auth state. FIREBASE configured ho to Firestore (restart/
// redeploy ke baad bhi connected), warna local folder (pehle jaisa).
async function getAuthState(authDir) {
  const m = await resolveMode()

  if (m === 'firestore') {
    try {
      const doc = await readSessionDoc()
      const { files, migrated } = filesFromDoc(doc, authDir)
      if (migrated) console.log('[session] local session Firestore me migrate ho raha hai (dobara scan nahi lagega)')

      const ref = db.collection(COLLECTION).doc(DOC_ID)
      const st = buildState({
        files,
        write: (data) =>
          ref.set(
            {
              data,
              enc: Boolean(PASSPHRASE),
              size: Buffer.byteLength(data),
              updatedAt: FieldValue.serverTimestamp()
            },
            { merge: true }
          )
      })
      currentFlush = st.flush
      return { state: st.state, saveCreds: st.saveCreds, flush: st.flush }
    } catch (e) {
      // Firestore reachable nahi (creds galat / network) → is boot me file fallback
      console.warn('[session] Firestore se session nahi mila, local file fallback on:', e && e.message)
      mode = 'file'
      currentFlush = null
    }
  }

  const res = await useMultiFileAuthState(authDir)
  currentFlush = null
  return res
}

// Logout / logged-out: session dono jagah se mitao (Firestore doc + local folder)
async function clearSession(authDir) {
  storeEpoch++ // purane state ke late writes ab kuch save nahi karenge
  try {
    await resolveMode()
  } catch (_) {}
  try {
    fs.rmSync(authDir, { recursive: true, force: true })
  } catch (_) {}
  if (mode === 'firestore' && db) {
    try {
      await db.collection(COLLECTION).doc(DOC_ID).delete()
      console.log('[session] Firestore session doc delete ho gaya (naya QR scan hoga)')
    } catch (e) {
      console.error('[session] Firestore session delete fail:', e && e.message)
    }
  }
}

// SIGINT/SIGTERM pe pending session write flush kar do (deploy/restart safety)
function flushSessionWrites() {
  return currentFlush ? currentFlush() : Promise.resolve()
}

module.exports = {
  getAuthState,
  clearSession,
  flushSessionWrites,
  // testing ke liye
  encodeSession,
  decodeSession,
  buildState,
  loadLocalFiles,
  filesFromDoc
}
