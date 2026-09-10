"""Send coupon messages via embedded WhatsApp bridge."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

BRIDGE_URL = os.environ.get("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3001").rstrip("/")
BRIDGE_TIMEOUT = 60
SHOP_PHONE = os.environ.get("SHOP_PHONE", "9591506548")
SHOP_HOURS = os.environ.get("SHOP_HOURS", "9 AM – 9 PM")
REVIEW_URL = os.environ.get(
    "GOOGLE_REVIEW_URL",
    "https://g.page/r/CaSto0sK11yGEAE/review",
)


def is_cloud_deployment() -> bool:
    return bool(os.environ.get("RAILWAY_ENVIRONMENT"))


def whatsapp_enabled() -> bool:
    return os.environ.get("WHATSAPP_ENABLED", "1") not in ("0", "false", "False", "no")


def bridge_is_running() -> bool:
    try:
        req = urllib.request.Request(f"{BRIDGE_URL}/health", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def _bridge_status_timeout() -> int:
    return 4


def _bridge_request(
    path: str,
    method: str = "GET",
    payload: dict | None = None,
    *,
    timeout: int | None = None,
) -> dict[str, Any]:
    data = None
    headers: dict[str, str] = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{BRIDGE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout or BRIDGE_TIMEOUT) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def get_bridge_status(*, auto_start: bool = False) -> dict[str, Any]:
    hosted = is_cloud_deployment()
    if not whatsapp_enabled():
        return {
            "available": False,
            "ready": False,
            "qr": None,
            "lastError": "WhatsApp is disabled on this server.",
            "hosted": hosted,
            "enabled": False,
        }

    if auto_start and not bridge_is_running():
        pass  # docker-entrypoint starts the bridge in production

    try:
        status = _bridge_request("/status", timeout=_bridge_status_timeout())
        return {
            "available": True,
            "ready": bool(status.get("ready")),
            "qr": status.get("qr"),
            "lastError": status.get("lastError"),
            "phase": status.get("phase"),
            "loadingPercent": status.get("loadingPercent"),
            "sessionLinked": bool(status.get("sessionLinked")),
            "sessionRestoring": bool(status.get("sessionRestoring")),
            "hosted": hosted,
            "enabled": True,
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        auth_dir = os.environ.get("WHATSAPP_AUTH_DIR", "")
        session_linked = bool(auth_dir and os.path.isfile(os.path.join(auth_dir, ".session-linked")))
        return {
            "available": False,
            "ready": False,
            "qr": None,
            "lastError": (
                "Restoring saved WhatsApp session — wait 1–3 minutes, then click Connect WhatsApp again."
                if hosted and session_linked
                else "Starting WhatsApp scanner — QR will appear shortly."
                if hosted
                else "WhatsApp bridge not running. Start the app with Docker or Start SV Grandur Offer.bat."
            ),
            "phase": "restoring" if session_linked else "starting",
            "sessionLinked": session_linked,
            "sessionRestoring": session_linked,
            "hosted": hosted,
            "enabled": True,
        }


def reset_bridge_session(*, force: bool = False) -> dict[str, Any]:
    try:
        return _bridge_request("/reset", method="POST", payload={"force": force})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            return {"ok": False, **json.loads(body)}
        except json.JSONDecodeError:
            return {"ok": False, "error": body or str(exc)}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": str(exc)}


def normalize_whatsapp_phone(phone: str) -> str:
    digits = "".join(c for c in str(phone or "") if c.isdigit())
    if len(digits) == 10:
        return "91" + digits
    if digits.startswith("0") and len(digits) == 11:
        return "91" + digits[1:]
    return digits


def build_coupon_message(coupon: dict[str, Any]) -> str:
    name = (coupon.get("customer_name") or "Customer").strip()
    code = coupon.get("code") or ""
    discount = coupon.get("discount_percent") or 0
    return (
        f"Hi {name},\n\n"
        f"Congratulations! 🎉\n\n"
        f"Your exclusive *SV Grandur* offer from *Rinse & Rise Laundryrite*:\n\n"
        f"*Coupon Code:* {code}\n"
        f"*Discount:* {discount}% OFF\n\n"
        f"Show this code when you place your laundry order.\n"
        f"Free Pickup & Delivery\n"
        f"Call: {SHOP_PHONE} | {SHOP_HOURS}\n\n"
        f"⭐ *Leave us a Google Review:*\n{REVIEW_URL}\n\n"
        f"Rinse · Rise · Repeat"
    )


def send_coupon_whatsapp(coupon: dict[str, Any]) -> dict[str, Any]:
    phone = normalize_whatsapp_phone(coupon.get("customer_phone", ""))
    if len(phone) < 12:
        raise ValueError("Valid 10-digit customer phone number is required.")

    message = build_coupon_message(coupon)
    status = get_bridge_status()
    if not status.get("ready"):
        return {
            "sent": False,
            "reason": "not_connected",
            "message": message,
            "bridgeAvailable": status.get("available", False),
        }

    try:
        result = _bridge_request(
            "/send-text",
            method="POST",
            payload={"phone": phone, "message": message},
        )
        return {
            "sent": bool(result.get("ok")),
            "reason": "sent" if result.get("ok") else "send_failed",
            "message": message,
        }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(body)
            error = err.get("error", body)
            needs_reconnect = bool(err.get("needsReconnect"))
        except json.JSONDecodeError:
            error = body or str(exc)
            needs_reconnect = False
        return {
            "sent": False,
            "reason": "send_failed",
            "error": error,
            "needsReconnect": needs_reconnect,
            "message": message,
        }
