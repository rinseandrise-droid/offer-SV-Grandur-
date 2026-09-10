"""Send coupon messages via the billing app's WhatsApp bridge."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

BRIDGE_URL = os.environ.get("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3001").rstrip("/")
SHOP_PHONE = os.environ.get("SHOP_PHONE", "9591506548")
SHOP_HOURS = os.environ.get("SHOP_HOURS", "9 AM – 9 PM")
REVIEW_URL = os.environ.get(
    "GOOGLE_REVIEW_URL",
    "https://g.page/r/CaSto0sK11yGEAE/review",
)


def normalize_whatsapp_phone(phone: str) -> str:
    digits = "".join(c for c in str(phone or "") if c.isdigit())
    if len(digits) == 10:
        return "91" + digits
    if len(digits) == 11 and digits.startswith("0"):
        return "91" + digits[1:]
    if len(digits) == 12 and digits.startswith("91"):
        return digits
    return digits


def build_coupon_message(coupon: dict[str, Any]) -> str:
    name = (coupon.get("customer_name") or "Customer").strip()
    code = coupon.get("code") or ""
    discount = coupon.get("discount_percent") or 0
    return (
        f"Hi {name},\n\n"
        f"Congratulations! 🎉\n\n"
        f"Your exclusive *SV Granges* offer from *Rinse & Rise Laundryrite*:\n\n"
        f"*Coupon Code:* {code}\n"
        f"*Discount:* {discount}% OFF\n\n"
        f"Show this code when you place your laundry order.\n"
        f"Free Pickup & Delivery\n"
        f"Call: {SHOP_PHONE} | {SHOP_HOURS}\n\n"
        f"⭐ *Leave us a Google Review:*\n{REVIEW_URL}\n\n"
        f"Rinse · Rise · Repeat"
    )


def _bridge_request(path: str, *, method: str = "GET", payload: dict | None = None) -> dict[str, Any]:
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BRIDGE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def get_bridge_status() -> dict[str, Any]:
    try:
        status = _bridge_request("/status")
        return {
            "available": True,
            "ready": bool(status.get("ready")),
            "phase": status.get("phase"),
            "sessionLinked": status.get("sessionLinked"),
            "qr": status.get("qr"),
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return {"available": False, "ready": False, "phase": "offline"}


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
