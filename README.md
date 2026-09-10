# SV Granges — Coupon Campaign Admin

Admin tool to send **300 exclusive discount coupons** to SV Granges residents on WhatsApp.

## Coupon pool (300 total)

| Discount | Count | Code range |
|----------|------:|------------|
| 50% off | 3 | SVGR-001 … SVGR-003 |
| 40% off | 7 | SVGR-004 … SVGR-010 |
| 30% off | 50 | SVGR-011 … SVGR-060 |
| 10% off | 140 | SVGR-061 … SVGR-200 |
| 20% off | 100 | SVGR-201 … SVGR-300 |

Each code can only be used **once**. After you send it to a customer, it is marked as used.

## Run locally

1. **WhatsApp:** Start the billing app once (`laundry-billing\Start Billing.bat`) and link WhatsApp via QR — the same session is reused here.
2. Double-click **`Start SV Granges Offer.bat`**
3. Open **http://localhost:5090**
4. Sign in with admin password: **`SVGranges@22`**

## Admin workflow

1. Enter **customer name** and **phone number**
2. Pick an **available coupon code** from the dropdown
3. Click **Send coupon on WhatsApp**

The customer receives a WhatsApp message with their code, discount %, and your Google review link.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SV_GRANGES_ADMIN_PASSWORD` | `SVGranges@22` | Admin login |
| `WHATSAPP_BRIDGE_URL` | `http://127.0.0.1:3001` | Billing WhatsApp bridge |
| `PORT` | `5090` | This app's port |

## Folder layout

```
offer 2(SV Granges)/
  Start SV Granges Offer.bat
  index.html
  css/styles.css
  js/app.js
  server/
    app.py
    database.py
    whatsapp_send.py
  data/
    sv-granges.db    ← created on first run
```

## Reset all coupons

Stop the app, delete `data/sv-granges.db`, and restart — 300 fresh codes are seeded automatically.
