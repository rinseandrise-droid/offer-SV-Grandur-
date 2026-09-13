"""Database connection — PostgreSQL (Railway) or local SQLite."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote_plus, urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DB_PATH = DATA_DIR / "sv-grandur.db"

PG_ENV_KEYS = (
    "DATABASE_PUBLIC_URL",
    "DATABASE_PRIVATE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRESQL_URL",
)

PG_PARTS_KEYS = (
    ("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"),
    ("POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"),
)


def _normalize_postgres_url(url: str) -> str:
    url = url.strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    return url


def _build_url_from_parts(host: str, port: str, user: str, password: str, database: str) -> str:
    host, user, password, database = host.strip(), user.strip(), password.strip(), database.strip()
    port = (port or "5432").strip()
    if not all([host, user, password, database]):
        return ""
    return (
        f"postgresql://{quote_plus(user)}:{quote_plus(password)}"
        f"@{host}:{port}/{quote_plus(database)}"
    )


def _is_unresolved_reference(value: str) -> bool:
    return "${{" in value or value.startswith("${")


def _host_rank(url: str) -> int:
    if _is_unresolved_reference(url):
        return 99
    if is_railway() and "railway.internal" in url:
        return 2
    if "proxy.rlwy.net" in url or "rlwy.net" in url:
        return 0
    return 1


def _collect_postgres_urls() -> list[str]:
    priority = {
        "DATABASE_PUBLIC_URL": 0,
        "DATABASE_PRIVATE_URL": 1,
        "DATABASE_URL": 2,
        "POSTGRES_URL": 3,
        "POSTGRESQL_URL": 4,
    }
    ranked: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for key in PG_ENV_KEYS:
        value = os.environ.get(key, "").strip()
        if _is_unresolved_reference(value):
            continue
        if not value.startswith(("postgres://", "postgresql://")):
            continue
        normalized = _normalize_postgres_url(value)
        if normalized in seen:
            continue
        seen.add(normalized)
        ranked.append((priority.get(key, 9), _host_rank(normalized), normalized))

    for parts in PG_PARTS_KEYS:
        url = _build_url_from_parts(
            os.environ.get(parts[0], ""),
            os.environ.get(parts[1], ""),
            os.environ.get(parts[2], ""),
            os.environ.get(parts[3], ""),
            os.environ.get(parts[4], ""),
        )
        if url and url not in seen and not _is_unresolved_reference(url):
            seen.add(url)
            ranked.append((5, _host_rank(url), url))

    ranked.sort(key=lambda item: (item[1], item[0]))
    urls = [url for _, _, url in ranked]
    if is_railway():
        public = [u for u in urls if "proxy.rlwy.net" in u or ".rlwy.net" in u or ".railway.app" in u]
        if public:
            return public
    return urls


_pg_reachable: bool | None = None
_using_sqlite_fallback = False


def _invalidate_postgres_probe() -> None:
    global _pg_reachable
    _pg_reachable = None


def _postgres_probe(*, force: bool = False) -> bool:
    global _pg_reachable
    if not force and _pg_reachable is not None:
        return _pg_reachable
    urls = _collect_postgres_urls()
    if not urls:
        _pg_reachable = False
        return False
    try:
        import psycopg2
    except ImportError:
        _pg_reachable = False
        return False
    for url in urls:
        try:
            conn = psycopg2.connect(_postgres_connect_url(url), connect_timeout=5)
            conn.close()
            _pg_reachable = True
            return True
        except Exception:
            continue
    _pg_reachable = False
    return False


def _should_use_sqlite_fallback() -> bool:
    global _using_sqlite_fallback
    if not is_railway() or not _collect_postgres_urls():
        _using_sqlite_fallback = False
        return False
    if os.environ.get("DATABASE_FALLBACK_SQLITE", "1").lower() in ("0", "false", "no"):
        _using_sqlite_fallback = False
        return False
    if _postgres_probe():
        _using_sqlite_fallback = False
        return False
    _using_sqlite_fallback = True
    return True


def is_postgres() -> bool:
    if not _collect_postgres_urls():
        return False
    if _should_use_sqlite_fallback():
        return False
    return True


def is_railway() -> bool:
    return bool(os.environ.get("RAILWAY_ENVIRONMENT", "").strip())


def database_backend_name() -> str:
    return "postgresql" if is_postgres() else "sqlite"


def database_config_status() -> dict[str, Any]:
    has_pg = bool(_collect_postgres_urls())
    using_fallback = _should_use_sqlite_fallback() if has_pg else False
    backend = "sqlite" if using_fallback or not has_pg else "postgresql"
    status: dict[str, Any] = {
        "backend": backend,
        "railway": is_railway(),
        "postgresConfigured": has_pg,
        "postgresReachable": _postgres_probe() if has_pg else False,
        "sqliteFallback": using_fallback,
    }
    if has_pg and not _postgres_probe():
        status["warning"] = "PostgreSQL URL is set but connection failed."
        status["fixSteps"] = [
            "Railway → Postgres service → copy DATABASE_PUBLIC_URL",
            "Railway → offer-SV-Grandur service → Variables → set DATABASE_URL via Variable Reference",
            "Prefer DATABASE_PUBLIC_URL if postgres.railway.internal fails",
            "Redeploy",
        ]
    elif is_railway() and not has_pg:
        status["warning"] = "DATABASE_URL not set — coupon data will not persist in PostgreSQL."
    return status


class DbCursor:
    def __init__(self, cursor: Any, is_pg: bool) -> None:
        self._cursor = cursor
        self._is_pg = is_pg

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> list[Any]:
        return self._cursor.fetchall()


class DbConnection:
    def __init__(self, conn: Any, is_pg: bool) -> None:
        self._conn = conn
        self._is_pg = is_pg

    def _adapt_sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self._is_pg else sql

    def execute(self, sql: str, params: tuple | list = ()) -> DbCursor:
        cur = self._conn.cursor()
        cur.execute(self._adapt_sql(sql), params)
        return DbCursor(cur, self._is_pg)

    def commit(self) -> None:
        self._conn.commit()

    def executescript(self, script: str) -> None:
        if self._is_pg:
            for statement in [s.strip() for s in script.split(";") if s.strip()]:
                self._conn.cursor().execute(statement)
        else:
            self._conn.executescript(script)


def _postgres_connect_url(url: str) -> str:
    if "sslmode=" not in url and "railway.internal" not in url:
        url += "&sslmode=require" if "?" in url else "?sslmode=require"
    return url


@contextmanager
def get_connection() -> Iterator[DbConnection]:
    if is_postgres():
        import psycopg2
        from psycopg2.extras import RealDictCursor

        urls = [_postgres_connect_url(u) for u in _collect_postgres_urls()]
        last_error: Exception | None = None
        for url in urls:
            try:
                conn = psycopg2.connect(
                    url,
                    cursor_factory=RealDictCursor,
                    connect_timeout=10,
                )
                wrapper = DbConnection(conn, True)
                try:
                    yield wrapper
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()
                return
            except Exception as exc:
                last_error = exc
                continue
        _invalidate_postgres_probe()
        raise last_error or RuntimeError("PostgreSQL connection failed")
    else:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        raw = sqlite3.connect(DB_PATH)
        raw.row_factory = sqlite3.Row
        wrapper = DbConnection(raw, False)
        try:
            yield wrapper
            raw.commit()
        except Exception:
            raw.rollback()
            raise
        finally:
            raw.close()
