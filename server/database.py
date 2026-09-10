"""SQLite storage for SV Granges coupon campaign (same app — no separate DB)."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DB_PATH = DATA_DIR / "sv-granges.db"
SEED_PATH = ROOT / "data" / "coupons-seed.json"
BACKUP_PATH = DATA_DIR / "coupons-backup.json"

COUPON_TIERS = (
    (50, 3),
    (40, 7),
    (30, 50),
    (10, 140),
    (20, 100),
)


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_seed_file() -> list[dict[str, Any]] | None:
    if not SEED_PATH.is_file():
        return None
    try:
        payload = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    coupons = payload.get("coupons")
    if not isinstance(coupons, list) or not coupons:
        return None
    return coupons


def _seed_coupons(conn: sqlite3.Connection) -> None:
    now = _now_iso()
    seed_rows = _load_seed_file()
    if seed_rows:
        rows = [
            (
                str(item.get("code") or "").strip().upper(),
                int(item.get("discountPercent") or item.get("discount_percent") or 0),
                now,
            )
            for item in seed_rows
            if str(item.get("code") or "").strip()
        ]
    else:
        seq = 1
        rows = []
        for discount, qty in COUPON_TIERS:
            for _ in range(qty):
                rows.append((f"SVGR-{seq:03d}", discount, now))
                seq += 1

    conn.executemany(
        "INSERT INTO coupons (code, discount_percent, created_at) VALUES (?, ?, ?)",
        rows,
    )


def _restore_from_backup(conn: sqlite3.Connection) -> bool:
    if not BACKUP_PATH.is_file():
        return False
    try:
        payload = json.loads(BACKUP_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False

    coupons = payload.get("coupons")
    if not isinstance(coupons, list) or not coupons:
        return False

    for item in coupons:
        code = str(item.get("code") or "").strip().upper()
        if not code:
            continue
        conn.execute(
            """
            INSERT INTO coupons (
                code, discount_percent, status, customer_name, customer_phone, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                code,
                int(item.get("discount_percent") or item.get("discountPercent") or 0),
                str(item.get("status") or "available"),
                item.get("customer_name") or item.get("customerName"),
                item.get("customer_phone") or item.get("customerPhone"),
                item.get("sent_at") or item.get("sentAt"),
                item.get("created_at") or item.get("createdAt") or _now_iso(),
            ),
        )
    return True


def write_backup() -> Path:
    """Write a JSON snapshot of all coupons (small file, safe on Railway volume)."""
    payload = {
        "version": 1,
        "updatedAt": _now_iso(),
        "total": 0,
        "used": 0,
        "available": 0,
        "coupons": list_coupons(),
    }
    payload["total"] = len(payload["coupons"])
    payload["used"] = sum(1 for c in payload["coupons"] if c.get("status") == "used")
    payload["available"] = payload["total"] - payload["used"]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return BACKUP_PATH


def get_storage_info() -> dict[str, Any]:
    db_exists = DB_PATH.is_file()
    backup_exists = BACKUP_PATH.is_file()
    seed_exists = SEED_PATH.is_file()
    db_size = DB_PATH.stat().st_size if db_exists else 0
    backup_size = BACKUP_PATH.stat().st_size if backup_exists else 0
    return {
        "engine": "sqlite",
        "separateDatabase": False,
        "dataDir": str(DATA_DIR),
        "databaseFile": str(DB_PATH),
        "databaseExists": db_exists,
        "databaseBytes": db_size,
        "seedFile": str(SEED_PATH),
        "seedInRepo": seed_exists,
        "backupFile": str(BACKUP_PATH),
        "backupExists": backup_exists,
        "backupBytes": backup_size,
    }


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS coupons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                discount_percent INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'available',
                customer_name TEXT,
                customer_phone TEXT,
                sent_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);
            CREATE INDEX IF NOT EXISTS idx_coupons_discount ON coupons(discount_percent);
            """
        )
        count = conn.execute("SELECT COUNT(*) AS c FROM coupons").fetchone()["c"]
        if count == 0:
            if not _restore_from_backup(conn):
                _seed_coupons(conn)
            write_backup()
        conn.commit()


def get_summary() -> dict[str, Any]:
    with _connect() as conn:
        tiers = []
        for discount, total in COUPON_TIERS:
            used = conn.execute(
                "SELECT COUNT(*) AS c FROM coupons WHERE discount_percent = ? AND status = 'used'",
                (discount,),
            ).fetchone()["c"]
            tiers.append(
                {
                    "discountPercent": discount,
                    "total": total,
                    "used": used,
                    "available": total - used,
                }
            )
        total = conn.execute("SELECT COUNT(*) AS c FROM coupons").fetchone()["c"]
        used = conn.execute(
            "SELECT COUNT(*) AS c FROM coupons WHERE status = 'used'"
        ).fetchone()["c"]
        return {
            "total": total,
            "used": used,
            "available": total - used,
            "tiers": tiers,
        }


def list_coupons(*, status: str | None = None, discount: int | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM coupons WHERE 1=1"
    params: list[Any] = []
    if status:
        sql += " AND status = ?"
        params.append(status)
    if discount is not None:
        sql += " AND discount_percent = ?"
        params.append(discount)
    sql += " ORDER BY id"
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [_row_dict(r) for r in rows]


def get_coupon_by_code(code: str) -> dict[str, Any] | None:
    normalized = (code or "").strip().upper()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM coupons WHERE UPPER(code) = ?",
            (normalized,),
        ).fetchone()
        return _row_dict(row)


def assign_coupon(code: str, name: str, phone: str) -> dict[str, Any]:
    normalized = (code or "").strip().upper()
    name = (name or "").strip()
    phone = (phone or "").strip()
    if not normalized:
        raise ValueError("Coupon code is required.")
    if not name:
        raise ValueError("Customer name is required.")
    if not phone:
        raise ValueError("Customer phone is required.")

    now = _now_iso()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM coupons WHERE UPPER(code) = ?",
            (normalized,),
        ).fetchone()
        if not row:
            raise ValueError("Coupon code not found.")
        if row["status"] == "used":
            raise ValueError("This coupon has already been sent to a customer.")

        conn.execute(
            """
            UPDATE coupons
            SET status = 'used', customer_name = ?, customer_phone = ?, sent_at = ?
            WHERE id = ?
            """,
            (name, phone, now, row["id"]),
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM coupons WHERE id = ?",
            (row["id"],),
        ).fetchone()
        result = _row_dict(updated)

    write_backup()
    return result


def list_history(limit: int = 100) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM coupons
            WHERE status = 'used'
            ORDER BY sent_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [_row_dict(r) for r in rows]


def export_all() -> dict[str, Any]:
    summary = get_summary()
    return {
        "version": 1,
        "exportedAt": _now_iso(),
        "summary": summary,
        "storage": get_storage_info(),
        "coupons": list_coupons(),
    }
