const TOKEN_KEY = "sv_granges_token";

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

function renderHistory(rows) {
  if (!rows.length) {
    historyBody.innerHTML =
      '<tr><td colspan="5" class="empty">No coupons sent yet</td></tr>';
    return;
  }
  historyBody.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td><strong>${r.code}</strong></td>
      <td><span class="discount-badge">${r.discount_percent}%</span></td>
      <td>${r.customer_name || "—"}</td>
      <td>${r.customer_phone || "—"}</td>
      <td>${formatDate(r.sent_at)}</td>
    </tr>`
    )
    .join("");
}

async function refreshWhatsAppStatus() {
  try {
    const status = await api("/api/whatsapp/status");
    if (status.ready) {
      waStatusPill.textContent = "WhatsApp Ready";
      waStatusPill.className = "status-pill ready";
    } else if (status.available) {
      waStatusPill.textContent = "WhatsApp connecting…";
      waStatusPill.className = "status-pill";
    } else {
      waStatusPill.textContent = "WhatsApp offline — start billing app";
      waStatusPill.className = "status-pill offline";
    }
  } catch {
    waStatusPill.textContent = "WhatsApp status unknown";
    waStatusPill.className = "status-pill offline";
  }
}

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

setInterval(() => {
  if (!appView.classList.contains("hidden")) {
    refreshWhatsAppStatus().catch(() => {});
  }
}, 15000);
