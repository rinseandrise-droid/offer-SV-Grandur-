"""SQLite storage for SV Granges coupon campaign."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "sv-granges.db"

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
            _seed_coupons(conn)
        conn.commit()


def _seed_coupons(conn: sqlite3.Connection) -> None:
    now = datetime.now(timezone.utc).isoformat()
    seq = 1
    rows: list[tuple[str, int, str]] = []
    for discount, qty in COUPON_TIERS:
        for _ in range(qty):
            code = f"SVGR-{seq:03d}"
            rows.append((code, discount, now))
            seq += 1
    conn.executemany(
        "INSERT INTO coupons (code, discount_percent, created_at) VALUES (?, ?, ?)",
        rows,
    )


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

    now = datetime.now(timezone.utc).isoformat()
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
        return _row_dict(updated)


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
