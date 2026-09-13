"""SV Grandur coupon admin — Flask API."""

from __future__ import annotations

import hmac
import os
import secrets
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from db import database_backend_name, database_config_status
from database import (
    assign_coupon,
    export_all,
    get_coupon_by_code,
    get_storage_info,
    get_summary,
    init_db,
    list_coupons,
    list_history,
    write_backup,
)
from whatsapp_send import (
    get_bridge_status,
    reset_bridge_session,
    send_coupon_whatsapp,
)

ROOT = Path(__file__).resolve().parent.parent
ADMIN_PASSWORD = os.environ.get("SV_GRANDUR_ADMIN_PASSWORD", "SVGrandur@22")
SESSIONS: dict[str, str] = {}

app = Flask(__name__, static_folder=str(ROOT), static_url_path="")

init_db()


@app.get("/api/live")
def live():
    return jsonify({"ok": True})


@app.get("/api/health")
def health():
    db_status = database_config_status()
    db_ok = True
    try:
        get_summary()
    except Exception as exc:
        db_ok = False
        db_status["error"] = str(exc)
    return jsonify(
        {
            "ok": db_ok,
            "database": database_backend_name(),
            "dbOk": db_ok,
            **db_status,
            "persistence": get_storage_info(),
        }
    )


def _token_ok(token: str | None) -> bool:
    return bool(token and token in SESSIONS)


def require_admin(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
        if not _token_ok(token):
            return jsonify({"error": "Unauthorized"}), 401
        return view(*args, **kwargs)

    return wrapped


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password") or "")
    if not hmac.compare_digest(password, ADMIN_PASSWORD):
        return jsonify({"error": "Invalid password"}), 401
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = "admin"
    return jsonify({"token": token})


@app.post("/api/logout")
def logout():
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    SESSIONS.pop(token, None)
    return jsonify({"ok": True})


@app.get("/api/summary")
@require_admin
def summary():
    return jsonify(get_summary())


@app.get("/api/coupons")
@require_admin
def coupons():
    status = request.args.get("status")
    discount = request.args.get("discount")
    discount_int = int(discount) if discount and discount.isdigit() else None
    return jsonify(list_coupons(status=status or None, discount=discount_int))


@app.get("/api/coupons/<code>")
@require_admin
def coupon_detail(code: str):
    row = get_coupon_by_code(code)
    if not row:
        return jsonify({"error": "Not found"}), 404
    return jsonify(row)


@app.get("/api/history")
@require_admin
def history():
    return jsonify(list_history())


@app.get("/api/storage")
@require_admin
def storage_info():
    return jsonify(get_storage_info())


@app.get("/api/export")
@require_admin
def export_coupons():
    return jsonify(export_all())


@app.post("/api/backup")
@require_admin
def backup_now():
    path = write_backup()
    return jsonify({"ok": True, "backupFile": str(path), "storage": get_storage_info()})


@app.get("/api/whatsapp/status")
@require_admin
def whatsapp_status():
    auto_start = request.args.get("start", "").lower() in ("1", "true", "yes")
    return jsonify(get_bridge_status(auto_start=auto_start))


@app.post("/api/whatsapp/reset")
@require_admin
def whatsapp_reset():
    return jsonify(reset_bridge_session())


@app.post("/api/send")
@require_admin
def send_coupon():
    data = request.get_json(silent=True) or {}
    code = str(data.get("couponCode") or data.get("code") or "").strip()
    name = str(data.get("customerName") or data.get("name") or "").strip()
    phone = str(data.get("customerPhone") or data.get("phone") or "").strip()
    send_wa = bool(data.get("sendWhatsApp", True))

    try:
        coupon = assign_coupon(code, name, phone)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    wa_result = {"sent": False, "skipped": True}
    if send_wa:
        wa_result = send_coupon_whatsapp(coupon)
        wa_result.pop("skipped", None)

    return jsonify({"coupon": coupon, "whatsapp": wa_result})


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:path>")
def static_files(path: str):
    full = ROOT / path
    if full.is_file():
        return send_from_directory(ROOT, path)
    return send_from_directory(ROOT, "index.html")


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "5090"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
