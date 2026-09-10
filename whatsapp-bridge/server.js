/**
 * Local WhatsApp bridge — sends PDF invoices via your logged-in WhatsApp Web session.
 * Run once, scan QR code, then bills can be sent automatically from the billing app.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT || 3001);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(DATA_DIR, "whatsapp-auth");
const CACHE_DIR = process.env.WHATSAPP_CACHE_DIR || path.join(DATA_DIR, "whatsapp-cache");
const LEGACY_AUTH_DIR = path.join(__dirname, ".wwebjs_auth");
const IS_HOSTED = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.PUPPETEER_EXECUTABLE_PATH
);

/**
 * Pin a known WhatsApp Web HTML (kept under CACHE_DIR). The `ready` event
 * often never fires on multi-device WA Web — we treat CONNECTED state as ready.
 */
const WA_WEB_VERSION =
  process.env.WHATSAPP_WEB_VERSION || "2.3000.1046691727-alpha";

const AUTH_READY_TIMEOUT_MS = Number(
  process.env.WHATSAPP_AUTH_TIMEOUT_MS || (IS_HOSTED ? 360000 : 180000)
);

const state = {
  ready: false,
  qr: null,
  lastError: null,
  phase: "starting",
  loadingPercent: 0,
  authenticatingSince: null,
  waState: null,
  sessionLinked: false,
};

let authTimer = null;
let connectPollTimer = null;
let client = null;
let recovering = false;
let sendInProgress = false;

const LOCK_FILE = path.join(AUTH_DIR, ".bridge.lock");
const SESSION_LINKED_FILE = path.join(AUTH_DIR, ".session-linked");
let lastReconnectAt = 0;

function ensureAuthDirs() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** Move session from old whatsapp-bridge/.wwebjs_auth to data/whatsapp-auth once. */
function migrateLegacyAuthDir() {
  if (!LEGACY_AUTH_DIR || path.resolve(LEGACY_AUTH_DIR) === path.resolve(AUTH_DIR)) return;
  try {
    const legacySession = path.join(LEGACY_AUTH_DIR, "session-rinse-rise");
    const newSession = path.join(AUTH_DIR, "session-rinse-rise");
    if (fs.existsSync(legacySession) && !fs.existsSync(newSession)) {
      console.log("[WhatsApp] Migrating saved session to persistent data folder…");
      fs.cpSync(LEGACY_AUTH_DIR, AUTH_DIR, { recursive: true });
    } else if (fs.existsSync(path.join(LEGACY_AUTH_DIR, ".session-linked")) && !hasSessionLinked()) {
      fs.copyFileSync(
        path.join(LEGACY_AUTH_DIR, ".session-linked"),
        path.join(AUTH_DIR, ".session-linked")
      );
    }
  } catch (err) {
    console.warn("[WhatsApp] Legacy auth migration:", err.message);
  }
}

function markSessionLinked() {
  try {
    ensureAuthDirs();
    fs.writeFileSync(SESSION_LINKED_FILE, new Date().toISOString());
    state.sessionLinked = true;
  } catch {
    /* ignore */
  }
}

function clearSessionLinked() {
  try {
    if (fs.existsSync(SESSION_LINKED_FILE)) fs.unlinkSync(SESSION_LINKED_FILE);
  } catch {
    /* ignore */
  }
  state.sessionLinked = false;
}

function hasSessionLinked() {
  return fs.existsSync(SESSION_LINKED_FILE);
}

function processAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstanceLock() {
  ensureAuthDirs();
  if (fs.existsSync(LOCK_FILE)) {
    const existing = parseInt(String(fs.readFileSync(LOCK_FILE, "utf8")).trim(), 10);
    if (processAlive(existing) && existing !== process.pid) {
      console.error(`[WhatsApp] Bridge already running (pid ${existing}). Exiting duplicate.`);
      process.exit(0);
    }
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existing = parseInt(String(fs.readFileSync(LOCK_FILE, "utf8")).trim(), 10);
      if (existing === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

/** Prefer system Chrome/Edge on Windows — more reliable than bundled Chromium for WA Web. */
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return "";
}

const CHROME_PATH = resolveChromePath();

const app = express();
app.use(express.json({ limit: "2mb" }));

function clearConnectPoll() {
  if (connectPollTimer) {
    clearInterval(connectPollTimer);
    connectPollTimer = null;
  }
}

function markReady(source) {
  clearTimeout(authTimer);
  clearConnectPoll();
  state.qr = null;
  state.lastError = null;
  state.loadingPercent = 100;
  state.phase = "connecting";
  state.authenticatingSince = null;
  markSessionLinked();
  console.log(`[WhatsApp] CONNECTED (${source}) — waiting for chat store & comms…`);

  waitForFullyReady(90000)
    .then((ok) => {
      if (ok) {
        state.phase = "ready";
        state.ready = true;
        state.lastError = null;
        console.log(`[WhatsApp] Connected and ready (${source}).`);
        return;
      }
      state.phase = "loading";
      state.ready = false;
      state.lastError =
        "WhatsApp linked — still finishing setup. Wait about 1 minute, then try sending again.";
      startStoreReadyPoll();
    })
    .catch((err) => {
      console.warn("[WhatsApp] Store wait failed:", err.message);
      state.phase = "loading";
      state.ready = false;
      state.lastError = "WhatsApp linked — still starting up. Wait a minute and try again.";
      startStoreReadyPoll();
    });
}

function startConnectedPoll(waClient) {
  clearConnectPoll();
  let connectedTicks = 0;
  connectPollTimer = setInterval(async () => {
    if (state.ready || !waClient) {
      clearConnectPoll();
      return;
    }
    try {
      const waState = await waClient.getState();
      state.waState = waState || null;
      if (waState === "CONNECTED") {
        connectedTicks += 1;
        // Require CONNECTED twice in a row (~4s) — ready event often never fires
        // on newer WA Web builds, but state still settles to CONNECTED.
        if (connectedTicks >= 2) {
          markReady("state-poll");
        }
      } else {
        connectedTicks = 0;
      }
    } catch (err) {
      console.warn("[WhatsApp] State poll:", err.message);
    }
  }, 2000);
}

function scheduleAuthTimeout() {
  clearTimeout(authTimer);
  authTimer = setTimeout(async () => {
    if (state.ready) return;

    // Last chance: if WhatsApp already says CONNECTED, force ready.
    try {
      if (client) {
        const waState = await client.getState();
        state.waState = waState || null;
        if (waState === "CONNECTED") {
          markReady("auth-timeout-connected");
          return;
        }
      }
    } catch (err) {
      console.warn("[WhatsApp] Auth timeout getState:", err.message);
    }

    state.phase = "error";
    state.lastError =
      "Phone linked but WhatsApp Web did not finish loading. Click Reset & Scan Again, wait for a fresh QR, scan quickly, then keep this window open for up to 3 minutes.";
    console.error("[WhatsApp] Ready timed out after authentication.");
    clearConnectPoll();
  }, AUTH_READY_TIMEOUT_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCommsError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return (
    msg.includes("startcomms") ||
    msg.includes("sendiq") ||
    msg.includes("[comms]") ||
    msg.includes("not ready")
  );
}

function isLidError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("lid is missing") || msg.includes("no lid for user");
}

function isSessionError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return (
    isCommsError(err) ||
    isStoreError(err) ||
    msg.includes("detached frame") ||
    msg.includes("target closed") ||
    msg.includes("session closed") ||
    msg.includes("protocol error") ||
    msg.includes("execution context was destroyed") ||
    msg.includes("page has been closed") ||
    msg.includes("browser has disconnected")
  );
}

function isStoreError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return (
    err?.code === "STORE_NOT_READY" ||
    msg.includes("getchat") ||
    msg.includes("cannot read properties of undefined") ||
    msg.includes("chat store") ||
    msg.includes("still loading")
  );
}

async function isWhatsAppStoreReady() {
  if (!client?.pupPage) return false;
  try {
    return await client.pupPage.evaluate(() => {
      try {
        const collections = window.require?.("WAWebCollections");
        const chat = collections?.Chat;
        return Boolean(chat && typeof chat.get === "function");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function waitForStoreReady(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isWhatsAppStoreReady()) return true;
    await sleep(1000);
  }
  return false;
}

/** sendIq fails with startComms if the socket layer is not up yet. */
async function isCommsReady() {
  if (!client?.pupPage) return false;
  try {
    return await client.pupPage.evaluate(() => {
      try {
        const Conn = window.require?.("WAWebConnModel")?.Conn;
        if (Conn?.connected || Conn?.wid) return true;
        const me = window.require?.("WAWebUserPrefsMeUser")?.getMaybeMePnUser?.();
        if (me) return true;
        const stream = window.require?.("WAWebStreamModel")?.Stream;
        if (stream?.mode === "MAIN" || stream?.uiActive) return true;
        return false;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function waitForCommsReady(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isCommsReady()) return true;
    await sleep(1500);
  }
  return false;
}

async function waitForFullyReady(timeoutMs = 90000) {
  const storeOk = await waitForStoreReady(Math.min(timeoutMs, 60000));
  if (!storeOk) return false;
  const commsOk = await waitForCommsReady(Math.min(timeoutMs, 45000));
  if (!commsOk) {
    // Hosted Chrome often needs a short grace period after the chat store loads.
    await sleep(8000);
  } else {
    await sleep(2500);
  }
  return (await isWhatsAppStoreReady()) && (await isCommsReady());
}

function startStoreReadyPoll() {
  if (startStoreReadyPoll._timer) return;
  startStoreReadyPoll._timer = setInterval(async () => {
    if (state.ready || !client) {
      clearInterval(startStoreReadyPoll._timer);
      startStoreReadyPoll._timer = null;
      return;
    }
    try {
      if (await isWhatsAppStoreReady() && (await isCommsReady())) {
        state.phase = "ready";
        state.ready = true;
        state.lastError = null;
        console.log("[WhatsApp] Chat store & comms ready.");
        clearInterval(startStoreReadyPoll._timer);
        startStoreReadyPoll._timer = null;
      }
    } catch (err) {
      console.warn("[WhatsApp] Store poll:", err.message);
    }
  }, 2000);
}

function createClient() {
  const puppeteerConfig = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--mute-audio",
      "--disable-extensions",
      "--disable-background-networking",
    ],
  };
  if (CHROME_PATH) {
    puppeteerConfig.executablePath = CHROME_PATH;
  }

  // Always pin a known-good local WA Web HTML. Remote "latest" often authenticates
  // but never fires ready (breaks QR linking).
  const clientOptions = {
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR, clientId: "rinse-rise" }),
    puppeteer: puppeteerConfig,
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0,
    webVersion: WA_WEB_VERSION,
    webVersionCache: {
      type: "local",
      path: CACHE_DIR,
    },
  };

  return new Client(clientOptions);
}

function bindClientEvents(waClient) {
  waClient.on("qr", async (qr) => {
    state.ready = false;
    state.phase = hasSessionLinked() ? "reconnecting" : "qr";
    state.loadingPercent = 0;
    state.lastError = hasSessionLinked()
      ? "Session expired — scan QR once to link again, or wait while we retry restoring the saved session."
      : null;
    state.authenticatingSince = null;
    clearTimeout(authTimer);
    try {
      state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
    } catch (err) {
      state.lastError = "Could not render QR code.";
      console.error("[WhatsApp] QR render failed:", err.message);
    }
    if (hasSessionLinked()) {
      console.log("[WhatsApp] Saved session needs re-link — scan QR in the billing app.");
    } else {
      console.log("[WhatsApp] Scan QR code in the billing app to connect (one-time setup).");
    }
  });

  waClient.on("loading_screen", (percent, message) => {
    state.phase = "loading";
    state.loadingPercent = Number(percent) || 0;
    state.qr = null;
    if (message) console.log(`[WhatsApp] Loading ${percent}% — ${message}`);
    if (state.loadingPercent >= 90) {
      startConnectedPoll(waClient);
    }
  });

  waClient.on("authenticated", () => {
    state.phase = "authenticating";
    state.qr = null;
    state.lastError = null;
    state.authenticatingSince = Date.now();
    state.loadingPercent = Math.max(state.loadingPercent, 95);
    markSessionLinked();
    console.log("[WhatsApp] Authenticated — waiting for CONNECTED state…");
    scheduleAuthTimeout();
    startConnectedPoll(waClient);
  });

  waClient.on("change_state", (waState) => {
    state.waState = waState;
    console.log("[WhatsApp] State:", waState);
    if (waState === "CONNECTED") {
      markReady("change_state");
    }
  });

  waClient.on("ready", () => {
    markReady("ready-event");
  });

  waClient.on("auth_failure", (msg) => {
    clearTimeout(authTimer);
    state.ready = false;
    state.phase = "error";
    state.lastError = `Authentication failed: ${msg}. Click Reset Connection and scan again.`;
    console.error("[WhatsApp] Auth failure:", msg);
  });

  waClient.on("disconnected", (reason) => {
    clearTimeout(authTimer);
    state.ready = false;
    const reasonText = String(reason || "unknown");
    console.warn("[WhatsApp] Disconnected:", reasonText);

    if (reasonText === "LOGOUT" || reasonText === "UNPAIRED") {
      clearSessionLinked();
      state.phase = "error";
      state.lastError = "Logged out from phone. Click Reset Connection and scan QR again.";
      return;
    }

    state.phase = "disconnected";
    state.lastError = `Reconnecting (${reasonText})…`;
    scheduleReconnect(15000);
  });

  waClient.on("error", (err) => {
    console.error("[WhatsApp] Client error:", err?.message || err);
    if (!state.ready) return;
    if (isSessionError(err)) {
      state.ready = false;
      state.phase = "disconnected";
      state.lastError = "WhatsApp reconnecting…";
      scheduleReconnect(20000);
    }
  });
}

function scheduleReconnect(delayMs) {
  const now = Date.now();
  if (now - lastReconnectAt < 20000) {
    delayMs = Math.max(delayMs, 20000);
  }
  lastReconnectAt = now;
  clearTimeout(scheduleReconnect._timer);
  scheduleReconnect._timer = setTimeout(() => {
    softRecoverClient("disconnect").catch((err) => {
      state.phase = "error";
      state.lastError = err.message || "Could not reconnect WhatsApp.";
      console.error("[WhatsApp] Reconnect failed:", err.message);
    });
  }, delayMs);
}

async function destroyClient() {
  clearTimeout(authTimer);
  clearConnectPoll();
  if (!client) return;
  try {
    await client.destroy();
  } catch (err) {
    console.warn("[WhatsApp] Destroy:", err.message);
  }
  client = null;
}

async function initializeClient() {
  await destroyClient();
  client = createClient();
  bindClientEvents(client);
  const linked = hasSessionLinked();
  state.phase = linked ? "restoring" : "starting";
  state.lastError = linked
    ? "Restoring saved WhatsApp session — no scan needed if already linked on your phone."
    : null;
  state.ready = false;
  state.authenticatingSince = null;
  state.waState = null;
  state.sessionLinked = linked;
  if (linked) {
    console.log("[WhatsApp] Restoring saved session from disk…");
  }
  await client.initialize();
}

function waitForReady(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (state.ready && client) return resolve(true);
      if (state.phase === "qr" && state.qr) return resolve(false);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(check, 400);
    };
    check();
  });
}

async function softRecoverClient(reason) {
  if (recovering) {
    while (recovering) {
      await sleep(300);
    }
    return state.ready;
  }

  recovering = true;
  const linked = hasSessionLinked();
  state.lastError = linked
    ? "Reconnecting saved WhatsApp session…"
    : "Reconnecting WhatsApp session…";
  console.warn("[WhatsApp] Recovering session:", reason);

  try {
    if (client) {
      try {
        const waState = await client.getState();
        if (waState === "CONNECTED") {
          markReady("recover-check");
          return true;
        }
      } catch {
        /* fall through */
      }
    }

    state.ready = false;
    state.phase = linked ? "restoring" : "reconnecting";
    await destroyClient();
    await initializeClient();
    const ok = await waitForReady(90000);
    if (!ok && state.phase === "qr") {
      state.lastError = linked
        ? "Saved session expired — scan the QR code once to link again."
        : "Scan the QR code in the billing app to connect WhatsApp.";
    } else if (!ok) {
      state.lastError = linked
        ? "WhatsApp reconnect timed out. Keep the scanner running and try sending again."
        : "WhatsApp reconnect timed out. Click Reset Connection if needed.";
    }
    return ok;
  } finally {
    recovering = false;
  }
}

async function resetSession() {
  clearTimeout(scheduleReconnect._timer);
  recovering = false;
  state.ready = false;
  state.qr = null;
  state.lastError = null;
  state.phase = "starting";
  state.loadingPercent = 0;

  await destroyClient();

  clearSessionLinked();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  // Keep pinned HTML in cache; only wipe other cached versions
  if (fs.existsSync(CACHE_DIR)) {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!name.includes(WA_WEB_VERSION)) {
        try {
          fs.rmSync(path.join(CACHE_DIR, name), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  await initializeClient();
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (digits.startsWith("0") && digits.length === 11) digits = "91" + digits.slice(1);
  return digits;
}

function serializeWid(wid) {
  if (!wid) return null;
  if (typeof wid === "string") return wid;
  if (wid._serialized) return wid._serialized;
  if (wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return null;
}

async function ensureChatRegistered(chatId) {
  if (!client?.pupPage) return false;
  try {
    return await client.pupPage.evaluate(async (targetChatId) => {
      const widFactory = window.require("WAWebWidFactory");
      const chatWid = widFactory.createWid(targetChatId);
      const exists = await window.require("WAWebQueryExistsJob").queryWidExists(chatWid);
      const resolvedWid = exists?.wid || chatWid;
      const chat =
        window.require("WAWebCollections").Chat.get(resolvedWid) ||
        (await window.require("WAWebFindChatAction").findOrCreateLatestChat(resolvedWid))?.chat;
      return Boolean(chat);
    }, chatId);
  } catch (err) {
    console.warn("[WhatsApp] ensureChatRegistered:", err.message);
    return false;
  }
}

async function resolveSendTargets(digits) {
  const phoneChatId = `${digits}@c.us`;
  const registered = await client.getNumberId(digits);
  if (!registered) {
    const err = new Error("This phone number is not registered on WhatsApp.");
    err.code = "NOT_ON_WHATSAPP";
    throw err;
  }

  const registeredId = serializeWid(registered) || phoneChatId;
  const targets = new Set([registeredId, phoneChatId]);

  try {
    const mappings = await client.getContactLidAndPhone([phoneChatId, registeredId]);
    for (const entry of mappings || []) {
      if (entry?.pn) targets.add(entry.pn);
      if (entry?.lid) targets.add(entry.lid);
    }
  } catch (err) {
    console.warn("[WhatsApp] LID lookup:", err.message);
  }

  const ordered = [...targets];
  for (const chatId of ordered) {
    await ensureChatRegistered(chatId);
    try {
      if (await isWhatsAppStoreReady()) {
        await client.getChatById(chatId);
      }
    } catch {
      /* chat may still send on next step */
    }
  }

  return ordered;
}

async function assertSendReady() {
  if (!client) throw new Error("WhatsApp not connected.");
  const waState = await client.getState();
  if (waState !== "CONNECTED") {
    state.ready = false;
    throw new Error(`WhatsApp not fully connected (${waState || "unknown"}).`);
  }
  const storeReady = await isWhatsAppStoreReady();
  if (!storeReady) {
    state.ready = false;
    state.phase = "loading";
    state.lastError = "WhatsApp chat system is still loading. Wait 30 seconds and try again.";
    startStoreReadyPoll();
    const err = new Error(
      "WhatsApp is still loading. Wait about 30 seconds, then try Send on WhatsApp again."
    );
    err.code = "STORE_NOT_READY";
    throw err;
  }
  if (!(await isCommsReady())) {
    state.ready = false;
    state.phase = "loading";
    state.lastError = "WhatsApp is still connecting. Wait 30 seconds and try again.";
    const commsOk = await waitForCommsReady(30000);
    if (!commsOk) {
      const err = new Error(
        "WhatsApp is still starting its send layer. Wait about 30 seconds, then try again."
      );
      err.code = "COMMS_NOT_READY";
      throw err;
    }
    await sleep(2000);
  }
}

async function performSend(digits, message, filePath, filename) {
  await assertSendReady();

  const targets = await resolveSendTargets(digits);
  const media = MessageMedia.fromFilePath(filePath);
  media.filename = filename || path.basename(filePath);

  let lastErr = null;
  for (const chatId of targets) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await assertSendReady();
        await ensureChatRegistered(chatId);
        await client.sendMessage(chatId, media, {
          caption: message || "",
          sendMediaAsDocument: true,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (isLidError(err)) {
          console.warn(`[WhatsApp] LID error on ${chatId} — trying alternate chat id…`);
          break;
        }
        if (isCommsError(err) && attempt < 6) {
          console.warn(`[WhatsApp] Comms not ready (attempt ${attempt}/6) — retrying…`);
          await sleep(4000 * attempt);
          continue;
        }
        throw err;
      }
    }
  }

  throw lastErr || new Error("Failed to send on WhatsApp.");
}

async function performSendText(digits, message) {
  await assertSendReady();

  const targets = await resolveSendTargets(digits);
  const text = String(message || "").trim();
  if (!text) throw new Error("Message is required.");

  let lastErr = null;
  for (const chatId of targets) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await assertSendReady();
        await ensureChatRegistered(chatId);
        await client.sendMessage(chatId, text);
        return;
      } catch (err) {
        lastErr = err;
        if (isLidError(err)) {
          console.warn(`[WhatsApp] LID error on ${chatId} — trying alternate chat id…`);
          break;
        }
        if (isCommsError(err) && attempt < 6) {
          console.warn(`[WhatsApp] Comms not ready (attempt ${attempt}/6) — retrying…`);
          await sleep(4000 * attempt);
          continue;
        }
        throw err;
      }
    }
  }

  throw lastErr || new Error("Failed to send on WhatsApp.");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", (_req, res) => {
  const authSeconds = state.authenticatingSince
    ? Math.floor((Date.now() - state.authenticatingSince) / 1000)
    : 0;
  const linked = state.sessionLinked || hasSessionLinked();
  const restoring =
    linked &&
    !state.ready &&
    ["starting", "restoring", "loading", "authenticating", "connecting", "reconnecting"].includes(
      state.phase
    );
  res.json({
    ready: state.ready,
    qr: state.qr,
    lastError: state.lastError,
    phase: state.phase,
    loadingPercent: state.loadingPercent,
    recovering,
    waState: state.waState,
    authenticatingSeconds: authSeconds,
    sessionLinked: linked,
    sessionRestoring: restoring,
    hosted: IS_HOSTED,
  });
});

app.post("/reset", async (_req, res) => {
  try {
    await resetSession();
    res.json({ ok: true });
  } catch (err) {
    console.error("[WhatsApp] Reset failed:", err);
    res.status(500).json({ error: err.message || "Reset failed." });
  }
});

app.post("/send-text", async (req, res) => {
  if (sendInProgress) {
    return res.status(429).json({ error: "Another WhatsApp send is in progress. Please wait a moment." });
  }

  if (!state.ready || !client) {
    return res.status(503).json({
      error: "WhatsApp not connected. Scan QR code in billing app.",
      needsReconnect: true,
    });
  }

  const { phone, message } = req.body || {};
  const digits = normalizePhone(phone);
  if (digits.length < 11) {
    return res.status(400).json({ error: "Invalid phone number." });
  }
  if (!String(message || "").trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  sendInProgress = true;
  try {
    try {
      await performSendText(digits, message);
      return res.json({ ok: true });
    } catch (err) {
      if (err.code === "NOT_ON_WHATSAPP") {
        return res.status(400).json({ error: err.message });
      }

      if (isSessionError(err)) {
        console.error("[WhatsApp] Send-text session error:", err.message);
        const reconnected = await softRecoverClient(err.message);
        if (!reconnected) {
          return res.status(503).json({
            error: "WhatsApp send layer not ready. Open WhatsApp in the billing app, wait until Ready, then try again.",
            needsReconnect: true,
          });
        }
        await performSendText(digits, message);
        return res.json({ ok: true, recovered: true });
      }

      throw err;
    }
  } catch (err) {
    console.error("[WhatsApp] Send-text failed:", err);
    return res.status(500).json({ error: err.message || "Send failed." });
  } finally {
    sendInProgress = false;
  }
});

app.post("/send", async (req, res) => {
  if (sendInProgress) {
    return res.status(429).json({ error: "Another WhatsApp send is in progress. Please wait a moment." });
  }

  if (!state.ready || !client) {
    return res.status(503).json({
      error: "WhatsApp not connected. Scan QR code in billing app.",
      needsReconnect: true,
    });
  }

  const { phone, message, pdfPath, filename } = req.body || {};
  const digits = normalizePhone(phone);
  if (digits.length < 11) {
    return res.status(400).json({ error: "Invalid phone number." });
  }

  const filePath = path.resolve(String(pdfPath || ""));
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: "Invoice PDF file not found." });
  }

  sendInProgress = true;
  try {
    try {
      await performSend(digits, message, filePath, filename);
      return res.json({ ok: true });
    } catch (err) {
      if (err.code === "NOT_ON_WHATSAPP") {
        return res.status(400).json({ error: err.message });
      }

      if (isSessionError(err)) {
        console.error("[WhatsApp] Send session error:", err.message);
        const reconnected = await softRecoverClient(err.message);
        if (!reconnected) {
          const friendly = isCommsError(err)
            ? "WhatsApp is still starting on the server. Wait 1 minute, then tap Send on WhatsApp again."
            : isStoreError(err)
              ? "WhatsApp chat system is not ready yet. Wait 1 minute, open WhatsApp in the header, then try again."
              : "WhatsApp send layer not ready. Open WhatsApp in the header, wait until it shows Ready, then try again.";
          return res.status(503).json({
            error: friendly,
            needsReconnect: true,
          });
        }
        await performSend(digits, message, filePath, filename);
        return res.json({ ok: true, recovered: true });
      }

      if (isStoreError(err)) {
        return res.status(503).json({
          error:
            "WhatsApp is still loading its chat system. Wait about 1 minute, then try Send on WhatsApp again.",
          needsReconnect: true,
        });
      }

      if (isCommsError(err)) {
        return res.status(503).json({
          error:
            "WhatsApp is still connecting on the server. Wait about 1 minute, then try Send on WhatsApp again.",
          needsReconnect: true,
        });
      }

      if (isLidError(err)) {
        return res.status(500).json({
          error:
            "WhatsApp could not open a chat for this number. Click Reset Connection in WhatsApp settings, scan QR again, then retry.",
          needsReconnect: true,
        });
      }

      throw err;
    }
  } catch (err) {
    console.error("[WhatsApp] Send failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to send on WhatsApp.",
      needsReconnect: isSessionError(err),
    });
  } finally {
    sendInProgress = false;
  }
});

const server = app.listen(PORT, "127.0.0.1", () => {
  acquireSingleInstanceLock();
  process.on("SIGINT", () => {
    releaseSingleInstanceLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseSingleInstanceLock();
    process.exit(0);
  });
  process.on("exit", releaseSingleInstanceLock);

  ensureAuthDirs();
  migrateLegacyAuthDir();
  state.sessionLinked = hasSessionLinked();
  console.log(`[WhatsApp] Bridge running on http://127.0.0.1:${PORT}`);
  console.log(`[WhatsApp] Session data: ${AUTH_DIR}`);
  console.log(`[WhatsApp] WA Web version: ${WA_WEB_VERSION}`);
  if (CHROME_PATH) {
    console.log(`[WhatsApp] Using browser: ${CHROME_PATH}`);
  } else {
    console.warn("[WhatsApp] No system Chrome/Edge found — using Puppeteer Chromium.");
  }
  initializeClient().catch((err) => {
    state.phase = "error";
    state.lastError = err.message;
    console.error("[WhatsApp] Init failed:", err.message);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[WhatsApp] Port ${PORT} is already in use. Close the other WhatsApp Scanner window, or run Reset WhatsApp.bat`);
    process.exit(1);
  }
  throw err;
});
