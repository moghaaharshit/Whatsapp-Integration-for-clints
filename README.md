# 🍽️ Food Menu + 🔗 WhatsApp Integration

**CRISP AND CLOUD** food menu (React + Firebase PWA) jisme **WhatsApp Link System** integrate hai — admin panel ka naya **WhatsApp section**: wahan number save hota hai (Firebase) aur **naya order aate hi** order details + Google Map location ke saath WhatsApp notification automatic chalti hai.

## ✨ Features

- 🍔 **Food Menu app** — menu, cart, checkout (location detect), orders, PWA
- 🔐 **Admin panel** — products, categories, orders, users, payment QR, shop status
- 💬 **NEW: WhatsApp section (admin)** — sidebar me `💬 WhatsApp`:
  - 📱 **Order Alert Number input** — number daal ke 💾 Save karo (Firebase `site/whatsapp` me) + 🧪 Test button
  - 🔗 **WhatsApp Link System embed** — QR connect page wahin iframe me (ya "Open in new tab ↗")
- 🔔 **Auto order notification** — admin **logged-in** ho aur website (**menu ya admin panel**, kisi bhi page pe) khuli ho, to naya order aate hi saved number pe professional WhatsApp message jata hai (items, total, payment, address + **Google Map link** ke saath). Server orderId se **dedup** karta hai — multiple tabs/browsers open ho to bhi message **sirf ek baar** jayega
- 📱 **QR Connect** — WhatsApp → Linked Devices → Link a Device se scan, realtime Socket.IO status
- ✅ Manual send — connected hone ke baad Phone (+91 default, 40+ countries) + Message inputs

## 📁 Project structure

```
Food-Menu-main/
├── index.html              → Food menu + admin panel (React + Firebase)
├── firebase-config.js      → Firebase (Firestore/Auth) + Cloudinary config
├── manifest.json, order.mp3, img1/2.png, logo.png
└── whatsapp/
    ├── index.html          → WhatsApp Link System page (React CDN + QR)
    └── server.js           → Express + Socket.IO + Baileys server
package.json                → npm start (server yahan se chalta hai)
render.yaml                 → Render blueprint
```

## 🖥️ Local setup

```bash
npm install
npm start
```

- **http://localhost:3000/** → Food menu (admin panel isi me)
- **http://localhost:3000/whatsapp** → WhatsApp connect page

### Admin panel setup (3 step)

1. Admin login → sidebar me **💬 WhatsApp** section kholo
2. **Order Alert Number** input me number daalo (example `+919876543210`) → **💾 Save** → **🧪 Test** se confirm karo
3. Neeche iframe me QR aayega → phone se scan karke WhatsApp **connect** karo (status 🟢 Connected hona chahiye)

Bas! Ab jab bhi naya order aayega, saved number pe message jayega:

```
🍽️ *NEW ORDER RECEIVED*
🆔 *Order ID:* #123XYZ
👤 *Customer:* Rahul
🛒 *Items Ordered:*
1. Chicken Biryani × 2  —  ₹498
💰 *TOTAL: ₹558*
📍 *Address:* Sector 12, Chandigarh
🗺️ *Google Map:* https://www.google.com/maps/search/?api=1&query=...
```

## 🚀 GitHub + Render deploy

```bash
git add .
git commit -m "Food menu + WhatsApp order notifications"
git push
```

Render → **New + → Web Service** → repo → Build: `npm install` → Start: `npm start` → deploy. Link kholo:

| URL | Kya milega |
|---|---|
| `/` | Food menu + admin panel |
| `/whatsapp` | WhatsApp QR connect system |

> ⚠️ **ACCESS PIN** (recommended): Render → Environment → `ACCESS_PIN` = koi 4-6 digit pin. Bina pin ke koi bhi link pe aakar tumhara WhatsApp session use kar sakta hai.

## ⚠️ Notes / limitations

- **Server restart/redeploy pe session as-is resume:** server start hote hi saved auth folder se WhatsApp apne aap dobara connect ho jata hai (bina QR scan). Render pe **Disk** add karke (`/data/wa-auth`) session permanently bhi rakh sakte ho — server `/data` khud detect karta hai (render.yaml me instructions hain). Free plan pe disk nahi lagta → redeploy ke baad dobara QR scan
- **Order alert tabhi jayega jab:** (a) admin ka account **logged-in** ho aur website khuli ho — **chahe menu page ya admin panel**, (b) WhatsApp connected hoga, (c) number saved hoga — warna console me warning aati hai
- Number format: `+91XXXXXXXXXX` ya seedha 10 digit (`+91` apne aap lagta hai) — Firestore doc: `site/whatsapp { notifyNumber }`
- Agar food menu kisi aur host pe ho (alag origin) to Firestore `site/whatsapp.serverUrl` me WhatsApp server ka URL daal do (empty = same origin)
- **WhatsApp ToS:** apne hi orders/customers ke liye use karo, spam nahi
- Firestore rules me `site` collection ke admin writes allowed hone chahiye (payment QR waise hi save hota hai, to normally already allowed)

## 🔌 API (developer)

| Method | Endpoint | Kaam |
|---|---|---|
| GET | `/api/status` | status + QR (`x-pin` agar ACCESS_PIN set hai) |
| POST | `/api/send` | `{ phone: "+91...", message: "..." }` (manual send) |
| POST | `/api/notify` | `{ orderId, phone, message }` — order alert, orderId se dedup (sirf ek baar) |
| POST | `/api/connect` / `/api/logout` | session start / unlink |
| WS | Socket.IO `state` | realtime `{ status, qr, user }` |
