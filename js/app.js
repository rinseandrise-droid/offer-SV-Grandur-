const TOKEN_KEY = "sv_grandur_token";

const $ = (sel) => document.querySelector(sel);

const loginView = $("#loginView");
const appView = $("#appView");
const loginForm = $("#loginForm");
const loginError = $("#loginError");
const sendForm = $("#sendForm");
const sendError = $("#sendError");
const sendSuccess = $("#sendSuccess");
const couponSelect = $("#couponCode");
const couponPreview = $("#couponPreview");
const statsGrid = $("#statsGrid");
const historyBody = $("#historyBody");
const waStatusPill = $("#waStatusPill");
const sendBtn = $("#sendBtn");
const sendWhatsAppCheck = $("#sendWhatsApp");

let availableCoupons = [];

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken("");
    showLogin();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

function showLogin() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function renderStats(summary) {
  const overall = `
    <div class="stat-card">
      <strong>${summary.available}</strong>
      <span>Available codes</span>
    </div>
    <div class="stat-card">
      <strong>${summary.used}</strong>
      <span>Sent to customers</span>
    </div>
    <div class="stat-card">
      <strong>${summary.total}</strong>
      <span>Total codes</span>
    </div>
  `;
  const tiers = (summary.tiers || [])
    .map(
      (t) => `
    <div class="stat-card">
      <strong>${t.available}/${t.total}</strong>
      <span>${t.discountPercent}% off left</span>
    </div>`
    )
    .join("");
  statsGrid.innerHTML = overall + tiers;
}

function renderCouponOptions(coupons) {
  availableCoupons = coupons;
  const current = couponSelect.value;
  couponSelect.innerHTML =
    '<option value="">Select available code…</option>' +
    coupons
      .map(
        (c) =>
          `<option value="${c.code}">${c.code} — ${c.discount_percent}% off</option>`
      )
      .join("");
  if (current && coupons.some((c) => c.code === current)) {
    couponSelect.value = current;
  }
  updateCouponPreview();
}

function updateCouponPreview() {
  const code = couponSelect.value;
  const row = availableCoupons.find((c) => c.code === code);
  if (!row) {
    couponPreview.classList.add("hidden");
    couponPreview.textContent = "";
    return;
  }
  couponPreview.classList.remove("hidden");
  couponPreview.innerHTML = `Selected: <span class="discount-badge">${row.code}</span> — ${row.discount_percent}% discount`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHistory(rows) {
  if (!rows.length) {
    historyBody.innerHTML =
      '<tr><td colspan="6" class="empty">No coupons sent yet</td></tr>';
    return;
  }
  historyBody.innerHTML = rows
    .map(
      (r) => `
    <tr data-code="${escapeHtml(r.code)}">
      <td><strong>${escapeHtml(r.code)}</strong></td>
      <td><span class="discount-badge">${r.discount_percent}%</span></td>
      <td>${escapeHtml(r.customer_name || "—")}</td>
      <td>${escapeHtml(r.customer_phone || "—")}</td>
      <td>${formatDate(r.sent_at)}</td>
      <td class="actions-cell">
        <button type="button" class="btn btn-outline btn-sm" data-action="edit" data-code="${escapeHtml(r.code)}">Edit</button>
        <button type="button" class="btn btn-danger btn-sm" data-action="cancel" data-code="${escapeHtml(r.code)}">Cancel</button>
      </td>
    </tr>`
    )
    .join("");
}

let editingCouponCode = null;

function openEditModal(row) {
  editingCouponCode = row.code;
  $("#editCouponLabel").textContent = `${row.code} — ${row.discount_percent}% off`;
  $("#editCustomerName").value = row.customer_name || "";
  $("#editCustomerPhone").value = row.customer_phone || "";
  $("#editSendWhatsApp").checked = false;
  $("#editError").classList.add("hidden");
  $("#editModal")?.classList.remove("hidden");
}

function closeEditModal() {
  editingCouponCode = null;
  $("#editModal")?.classList.add("hidden");
}

async function cancelSentCoupon(code) {
  const label = code.trim().toUpperCase();
  if (
    !confirm(
      `Cancel ${label}? The coupon will become available again for another customer.`
    )
  ) {
    return;
  }
  await api(`/api/coupons/${encodeURIComponent(label)}/cancel`, { method: "POST" });
  await loadDashboard();
}

let waPollTimer = null;
let waBackgroundTimer = null;
let lastRenderedWhatsAppQr = null;

function isWhatsAppSessionRestoring(status) {
  if (!status) return false;
  if (status.sessionRestoring) return true;
  if (!status.sessionLinked || status.ready) return false;
  return ["starting", "restoring", "loading", "authenticating", "connecting", "reconnecting"].includes(
    status.phase
  );
}

function updateWhatsAppPill(status) {
  const connectBtn = $("#waConnectBtn");
  if (!status) {
    waStatusPill.textContent = "WhatsApp offline";
    waStatusPill.className = "status-pill offline";
    if (connectBtn) connectBtn.textContent = "Connect WhatsApp";
    return;
  }
  if (status.ready) {
    waStatusPill.textContent = "WhatsApp Ready";
    waStatusPill.className = "status-pill ready";
    if (connectBtn) {
      connectBtn.textContent = "WhatsApp connected";
      connectBtn.disabled = false;
    }
    return;
  }
  if (isWhatsAppSessionRestoring(status)) {
    waStatusPill.textContent = "Restoring session…";
    waStatusPill.className = "status-pill";
    if (connectBtn) connectBtn.textContent = "Restoring WhatsApp…";
    return;
  }
  if (status.qr || status.phase === "qr") {
    waStatusPill.textContent = "Scan QR to link";
    waStatusPill.className = "status-pill offline";
    if (connectBtn) connectBtn.textContent = "Scan WhatsApp QR";
    return;
  }
  if (status.available) {
    waStatusPill.textContent = "WhatsApp starting…";
    waStatusPill.className = "status-pill";
    if (connectBtn) connectBtn.textContent = "Connect WhatsApp";
    return;
  }
  waStatusPill.textContent = "WhatsApp offline";
  waStatusPill.className = "status-pill offline";
  if (connectBtn) connectBtn.textContent = "Connect WhatsApp";
}

async function refreshWhatsAppStatus(startBridge = false) {
  try {
    const q = startBridge ? "?start=1" : "";
    const status = await api(`/api/whatsapp/status${q}`);
    updateWhatsAppPill(status);
    scheduleWhatsAppBackgroundPoll(status);
    return status;
  } catch {
    updateWhatsAppPill(null);
    return null;
  }
}

function scheduleWhatsAppBackgroundPoll(status) {
  if (waBackgroundTimer) {
    clearInterval(waBackgroundTimer);
    waBackgroundTimer = null;
  }
  if (status?.ready) return;
  const intervalMs = isWhatsAppSessionRestoring(status) || status?.available ? 3000 : 8000;
  waBackgroundTimer = setInterval(() => {
    if (!appView.classList.contains("hidden") && !$("#waModal")?.classList.contains("hidden")) return;
    refreshWhatsAppStatus().catch(() => {});
  }, intervalMs);
}

function bindWhatsAppResetButton() {
  $("#waResetBtn")?.addEventListener("click", async () => {
    lastRenderedWhatsAppQr = null;
    await api("/api/whatsapp/reset", { method: "POST" });
    pollWhatsAppModal(true);
  });
}

function renderWhatsAppModal(status) {
  const body = $("#waModalBody");
  if (!body) return;
  if (!status) {
    body.innerHTML = "<p>Could not load WhatsApp status.</p>";
    return;
  }
  if (status.ready) {
    lastRenderedWhatsAppQr = null;
    body.innerHTML =
      "<p><strong>WhatsApp is connected!</strong></p><p>Session is saved on the server — you will not need to scan again after restarts.</p>";
    return;
  }

  const restoring = isWhatsAppSessionRestoring(status);
  if (restoring) {
    lastRenderedWhatsAppQr = null;
    const pct = Number(status.loadingPercent) || 0;
    const progress =
      pct > 0
        ? `Loading WhatsApp Web… ${pct}%`
        : status.phase === "authenticating"
          ? "Authenticated — finishing connection…"
          : "Restoring saved WhatsApp session…";
    body.innerHTML = `
      <p><strong>${progress}</strong></p>
      <p>You already linked WhatsApp — <strong>no scan needed</strong> unless a QR appears below. On Railway this can take 2–3 minutes after deploy.</p>
      <p class="hint">${status.lastError || "Keep this page open while the server finishes restoring the session."}</p>
      <p><button type="button" class="btn btn-outline btn-sm" id="waResetBtn">Reset connection</button></p>
    `;
    bindWhatsAppResetButton();
    return;
  }

  if (status.qr) {
    if (lastRenderedWhatsAppQr === status.qr && body.querySelector(".wa-qr-image")) return;
    lastRenderedWhatsAppQr = status.qr;
    body.innerHTML = `
      <p><strong>One-time setup:</strong> open WhatsApp on your phone → <strong>Linked Devices</strong> → <strong>Link a Device</strong>, then scan this QR.</p>
      <p class="hint">After the first scan, the session stays saved — you won't need to scan again.</p>
      <img class="wa-qr-image" src="${status.qr}" alt="WhatsApp QR code" width="280" height="280">
      <p><button type="button" class="btn btn-outline btn-sm" id="waResetBtn">Reset connection</button></p>
    `;
    bindWhatsAppResetButton();
    return;
  }

  lastRenderedWhatsAppQr = null;
  body.innerHTML = `
    <p>${status.lastError || "Waiting for WhatsApp…"}</p>
    <p class="hint">If this is your first time, a QR code will appear shortly.</p>
    <p><button type="button" class="btn btn-outline btn-sm" id="waResetBtn">Reset connection</button></p>
  `;
  bindWhatsAppResetButton();
}

function openWhatsAppModal() {
  $("#waModal")?.classList.remove("hidden");
  pollWhatsAppModal(true);
}

function closeWhatsAppModal() {
  $("#waModal")?.classList.add("hidden");
  if (waPollTimer) {
    clearInterval(waPollTimer);
    waPollTimer = null;
  }
}

async function pollWhatsAppModal(startBridge = false) {
  const status = await refreshWhatsAppStatus(startBridge);
  renderWhatsAppModal(status);
  if (status?.ready) {
    if (waPollTimer) clearInterval(waPollTimer);
    waPollTimer = null;
    setTimeout(closeWhatsAppModal, 1500);
    return;
  }
  if (!waPollTimer) {
    waPollTimer = setInterval(() => pollWhatsAppModal(false), 2000);
  }
}

$("#waConnectBtn")?.addEventListener("click", openWhatsAppModal);
$("#waModalClose")?.addEventListener("click", closeWhatsAppModal);
$("#waModalBackdrop")?.addEventListener("click", closeWhatsAppModal);

async function loadDashboard() {
  const [summary, coupons, history] = await Promise.all([
    api("/api/summary"),
    api("/api/coupons?status=available"),
    api("/api/history"),
  ]);
  renderStats(summary);
  renderCouponOptions(coupons);
  renderHistory(history);
  await refreshWhatsAppStatus();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  try {
    const password = $("#loginPassword").value;
    const { token } = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      return data;
    });
    setToken(token);
    showApp();
    await loadDashboard();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  setToken("");
  showLogin();
});

couponSelect.addEventListener("change", updateCouponPreview);

sendWhatsAppCheck.addEventListener("change", () => {
  sendBtn.textContent = sendWhatsAppCheck.checked
    ? "Send coupon on WhatsApp"
    : "Save coupon (no WhatsApp)";
});

sendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  sendError.classList.add("hidden");
  sendSuccess.classList.add("hidden");
  sendBtn.disabled = true;

  try {
    const payload = {
      customerName: $("#customerName").value.trim(),
      customerPhone: $("#customerPhone").value.trim(),
      couponCode: couponSelect.value,
      sendWhatsApp: sendWhatsAppCheck.checked,
    };
    const result = await api("/api/send", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    let msg = `Coupon ${result.coupon.code} (${result.coupon.discount_percent}% off) assigned to ${result.coupon.customer_name}.`;
    if (payload.sendWhatsApp) {
      if (result.whatsapp?.sent) {
        msg += " WhatsApp message sent!";
      } else {
        msg += ` WhatsApp not sent: ${result.whatsapp?.error || result.whatsapp?.reason || "bridge not ready"}. Coupon is still marked as used — you can share the code manually.`;
      }
    }
    sendSuccess.textContent = msg;
    sendSuccess.classList.remove("hidden");

    $("#customerName").value = "";
    $("#customerPhone").value = "";
    couponSelect.value = "";
    updateCouponPreview();
    await loadDashboard();
  } catch (err) {
    sendError.textContent = err.message;
    sendError.classList.remove("hidden");
  } finally {
    sendBtn.disabled = false;
  }
});

$("#refreshBtn").addEventListener("click", () => loadDashboard().catch(console.error));

async function downloadSentExcel() {
  const btn = $("#downloadExcelBtn");
  if (btn) btn.disabled = true;
  try {
    const token = getToken();
    const res = await fetch("/api/export/sent.xlsx", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      setToken("");
      showLogin();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Download failed");
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] || "sv-grandur-sent-coupons.csv";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$("#downloadExcelBtn")?.addEventListener("click", () => {
  downloadSentExcel().catch((err) => alert(err.message || "Could not download file."));
});

historyBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const code = btn.getAttribute("data-code");
  if (!code) return;

  if (btn.dataset.action === "edit") {
    try {
      const row = await api(`/api/coupons/${encodeURIComponent(code)}`);
      openEditModal(row);
    } catch (err) {
      alert(err.message || "Could not load coupon.");
    }
    return;
  }

  if (btn.dataset.action === "cancel") {
    btn.disabled = true;
    try {
      await cancelSentCoupon(code);
    } catch (err) {
      alert(err.message || "Could not cancel coupon.");
    } finally {
      btn.disabled = false;
    }
  }
});

$("#editForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editingCouponCode) return;
  const editError = $("#editError");
  editError.classList.add("hidden");
  const saveBtn = $("#editForm button[type='submit']");
  saveBtn.disabled = true;

  try {
    const result = await api(`/api/coupons/${encodeURIComponent(editingCouponCode)}`, {
      method: "PATCH",
      body: JSON.stringify({
        customerName: $("#editCustomerName").value.trim(),
        customerPhone: $("#editCustomerPhone").value.trim(),
        sendWhatsApp: $("#editSendWhatsApp").checked,
      }),
    });
    closeEditModal();
    await loadDashboard();
    if ($("#editSendWhatsApp").checked) {
      if (result.whatsapp?.sent) {
        sendSuccess.textContent = `Updated ${result.coupon.code} and sent on WhatsApp.`;
      } else {
        sendSuccess.textContent = `Updated ${result.coupon.code}. WhatsApp not sent: ${
          result.whatsapp?.error || result.whatsapp?.reason || "not connected"
        }.`;
      }
      sendSuccess.classList.remove("hidden");
      sendError.classList.add("hidden");
    }
  } catch (err) {
    editError.textContent = err.message;
    editError.classList.remove("hidden");
  } finally {
    saveBtn.disabled = false;
  }
});

$("#editModalClose")?.addEventListener("click", closeEditModal);
$("#editModalBackdrop")?.addEventListener("click", closeEditModal);
$("#editCancelBtn")?.addEventListener("click", closeEditModal);

(async function init() {
  if (getToken()) {
    try {
      showApp();
      await loadDashboard();
      return;
    } catch {
      setToken("");
    }
  }
  showLogin();
})();

