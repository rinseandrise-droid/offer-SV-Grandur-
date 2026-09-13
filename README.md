# SV Grandur — Coupon Campaign Admin

Admin tool to send **300 exclusive discount coupons** to SV Grandur residents on WhatsApp.

## Coupon pool (300 total)

| Discount | Count | Code range |
|----------|------:|------------|
| 50% off | 3 | SVGD-001 … SVGD-003 |
| 40% off | 7 | SVGD-004 … SVGD-010 |
| 30% off | 50 | SVGD-011 … SVGD-060 |
| 10% off | 140 | SVGD-061 … SVGD-200 |
| 20% off | 100 | SVGD-201 … SVGD-300 |

## How data is stored

When you submit the form (customer name, phone, coupon), the offer is **saved in the database** immediately.

| Environment | Storage |
|-------------|---------|
| **Railway (production)** | **PostgreSQL** via `DATABASE_URL` |
| **Local dev** | SQLite file `data/sv-grandur.db` (if no `DATABASE_URL`) |

WhatsApp session files still use the Railway volume at `/app/data/whatsapp-auth`.

## Run locally

```bash
cd server
pip install -r ../requirements.txt
python app.py
```

Open **http://localhost:5090** — password: **`SVGrandur@22`**

Or double-click **`Start SV Grandur Offer.bat`**

## Deploy on Railway

1. Connect repo: [rinseandrise-droid/offer-SV-Grandur-](https://github.com/rinseandrise-droid/offer-SV-Grandur-)
2. Add **PostgreSQL** service in the same Railway project
3. On the **web app service** → **Variables** → **Variable Reference**:
   - From Postgres → **`DATABASE_PRIVATE_URL`** → name it **`DATABASE_URL`**
   - Also add **`DATABASE_PUBLIC_URL`** from Postgres (fallback if internal DNS fails)
4. Add **Volume** at **`/app/data`** (for WhatsApp session only)
5. Set **`SV_GRANDUR_ADMIN_PASSWORD`**
6. Deploy

**Do not paste the database password in GitHub.** Set `DATABASE_URL` only in Railway Variables.

### Verify database

Open: `https://YOUR-APP.up.railway.app/api/health`

```json
{
  "ok": true,
  "database": "postgresql",
  "dbOk": true
}
```

## Configuration

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection (Railway) |
| `SV_GRANDUR_ADMIN_PASSWORD` | Admin login |
| `OFFER_VALID_UNTIL` | Shown in WhatsApp message (default `30/09/2026`) |
| `DATA_DIR` | WhatsApp auth on volume (`/app/data`) |

## Admin workflow

1. **Connect WhatsApp** (one-time QR scan)
2. Enter customer **name** and **phone**
3. Pick an **available coupon code**
4. Click **Send coupon on WhatsApp** — saved to PostgreSQL + WhatsApp sent
