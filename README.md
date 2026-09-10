# SV Granges — Coupon Campaign Admin

Admin tool to send **300 exclusive discount coupons** to SV Granges residents on WhatsApp.

**No separate PostgreSQL database.** All coupon data lives in this same app using a small SQLite file on a Railway volume (~300 rows).

## Coupon pool (300 total)

| Discount | Count | Code range |
|----------|------:|------------|
| 50% off | 3 | SVGR-001 … SVGR-003 |
| 40% off | 7 | SVGR-004 … SVGR-010 |
| 30% off | 50 | SVGR-011 … SVGR-060 |
| 10% off | 140 | SVGR-061 … SVGR-200 |
| 20% off | 100 | SVGR-201 … SVGR-300 |

## How data is stored

| File | In GitHub | Purpose |
|------|-----------|---------|
| `data/coupons-seed.json` | Yes | All 300 coupon codes (source of truth) |
| `data/sv-granges.db` | No | Live SQLite DB (who used which coupon) |
| `data/coupons-backup.json` | No | Auto JSON backup after each send |

On first deploy, the app reads `coupons-seed.json` from the repo and creates the SQLite database. Every time a coupon is sent, a JSON backup is written to the volume so data is safe even though it is small.

## Run locally

Double-click **`Start SV Granges Offer.bat`** or:

```bash
cd server
pip install -r ../requirements.txt
python app.py
```

Open **http://localhost:5090** — password: **`SVGranges@22`**

## Docker (local test)

```bash
docker build -t sv-granges-offer .
docker run --rm -p 8080:8080 -v sv-granges-data:/app/data sv-granges-offer
```

Open **http://localhost:8080**

## Deploy on Railway (no Postgres)

1. Connect repo: [rinseandrise-droid/offer-SV-Grandur-](https://github.com/rinseandrise-droid/offer-SV-Grandur-)
2. Railway auto-detects **`Dockerfile`** via `railway.toml`
3. **Do not add PostgreSQL** — you only need this app service.
4. Add a **Volume** mounted at **`/app/data`** (keeps SQLite DB + JSON backup + WhatsApp session)
5. Set environment variables:

| Variable | Required | Example |
|----------|----------|---------|
| `SV_GRANGES_ADMIN_PASSWORD` | Yes | Your secure admin password |
| `WHATSAPP_ENABLED` | No | `1` (default) |
| `PORT` | Auto | Railway sets this |

6. Deploy → open your Railway URL → sign in
7. Click **Connect WhatsApp** → scan QR once (session persists on the volume)

Health check: `GET /api/live`

### Admin API (backup)

| Endpoint | Description |
|----------|-------------|
| `GET /api/storage` | Where data is saved |
| `GET /api/export` | Download full coupon JSON |
| `POST /api/backup` | Force JSON backup now |

## Admin workflow

1. **Connect WhatsApp** (one-time QR scan)
2. Enter customer **name** and **phone**
3. Pick an **available coupon code**
4. Click **Send coupon on WhatsApp**

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SV_GRANGES_ADMIN_PASSWORD` | `SVGranges@22` | Admin login |
| `DATA_DIR` | `/app/data` | SQLite + backup + WhatsApp auth |
| `WHATSAPP_BRIDGE_URL` | `http://127.0.0.1:3001` | Internal bridge |
| `PORT` | `8080` (Docker) / `5090` (local) | Web port |

## Reset all coupons

Delete `data/sv-granges.db` and `data/coupons-backup.json` on the volume (or wipe the Railway volume) and restart — 300 fresh codes are seeded from `data/coupons-seed.json` in GitHub.
