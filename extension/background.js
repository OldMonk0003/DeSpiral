// Companion — Background Service Worker (Manifest V3)
//
// Responsibilities:
//  - Resolve the identity for this install: a user-supplied user_token if one
//    is set, otherwise the seeded demo persona (Fix_12). Never writes one.
//  - Expose getUserToken() so the token can be included in outbound requests.
//  - Proxy chat requests to the Lambda from the (CORS-exempt) service worker.

const USER_TOKEN_KEY = "user_token";
// Identity used when the user has not set one of their own (Fix_12). This is
// the seeded persona from backend/seed_history.py — judges get the full demo
// (3 months of history, populated insights) without any setup.
const DEMO_USER_TOKEN = "demo-hx-persona";

// Backend: the deployed AWS Lambda Function URL. Fetching from the service
// worker (extension origin, with host_permissions granted) is exempt from
// CORS — no preflight — unlike a content-script fetch under Manifest V3.
//
// PLACEHOLDER in the public repository. The real endpoint is unauthenticated,
// so it is not published here; the build distributed to reviewers has it baked
// in. To point this at your own deployment, replace the URL below AND the
// matching entry in manifest.json `host_permissions` — Chrome blocks the
// request if the manifest does not grant the host, even when this constant is
// correct. Keep the trailing slash: routes are appended directly to it.
const LAMBDA_ENDPOINT =
  "https://replace-with-your-lambda-url.lambda-url.us-east-1.on.aws/";
const REQUEST_TIMEOUT_MS = 60000; // streamed generation holds the connection

/** Post to a Port, swallowing errors if the other end already disconnected. */
function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch (_) {
    /* port closed */
  }
}

/**
 * Stream a chat turn from the Lambda and forward chunks over `port`.
 * Runs in the service worker, so it bypasses page CORS entirely (no preflight).
 * Emits { type: "chunk", text } per delta, then { type: "done" }, or
 * { type: "error", error } on failure. The backend persists the turn on its
 * side even if the client disconnects mid-stream.
 * @param {chrome.runtime.Port} port
 * @param {object} payload
 */
async function streamCompanionBackend(port, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onDisconnect = () => controller.abort();
  port.onDisconnect.addListener(onDisconnect);

  try {
    const res = await fetch(LAMBDA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 429) {
      // Backend spend cap (Fix_11). Distinct from a generic failure so the
      // drawer can say "rate limited" rather than "something broke".
      safePost(port, { type: "error", error: "quota" });
      return;
    }
    if (!res.ok) {
      safePost(port, { type: "error", error: "http_" + res.status });
      return;
    }
    if (!res.body || !res.body.getReader) {
      // No streamable body — fall back to a single buffered chunk.
      const text = await res.text();
      if (text) safePost(port, { type: "chunk", text });
      safePost(port, { type: "done" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) safePost(port, { type: "chunk", text });
    }
    const tail = decoder.decode();
    if (tail) safePost(port, { type: "chunk", text: tail });
    safePost(port, { type: "done" });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    safePost(port, {
      type: "error",
      error: aborted ? "timeout" : String((err && err.message) || err),
    });
  } finally {
    clearTimeout(timer);
    try {
      port.onDisconnect.removeListener(onDisconnect);
    } catch (_) {}
  }
}

/**
 * One-shot (non-streaming) fetch for the Patterns & Insights snapshot.
 * Separate from the chat Port; also CORS-exempt from the service worker.
 * @param {object} payload  { user_token }
 * @returns {Promise<object>}
 */
async function fetchInsights(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(LAMBDA_ENDPOINT + "insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("http_" + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---- Cloud intent check (Fix_6) ----------------------------------------
 * Last-resort tier for queries that miss the Tier-1 root list but carry a weak
 * health signal. Three guards sit in front of the network call, because this is
 * the only path where text the user didn't obviously mark as health-related
 * leaves the browser:
 *   1. a verdict cache, so a repeated search costs nothing,
 *   2. an hourly cap, so a runaway URL-poll loop can't hammer Bedrock,
 *   3. a short timeout, so interception never hangs on a slow response.
 * Every failure resolves false — the drawer stays shut.
 */

const INTENT_TIMEOUT_MS = 2500;
const INTENT_CACHE_KEY = "intent_cache";
const INTENT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INTENT_CACHE_MAX = 200;
const INTENT_RATE_KEY = "intent_rate";
const INTENT_MAX_PER_HOUR = 60;

/** Normalize so trivial spacing/case differences share one cache entry. */
function intentCacheKey(query) {
  return String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function readIntentCache(key) {
  const store = (await chrome.storage.local.get(INTENT_CACHE_KEY))[INTENT_CACHE_KEY] || {};
  const hit = store[key];
  if (!hit) return null;
  if (Date.now() - hit.ts > INTENT_CACHE_TTL_MS) return null;
  return hit.medical;
}

async function writeIntentCache(key, medical) {
  const store = (await chrome.storage.local.get(INTENT_CACHE_KEY))[INTENT_CACHE_KEY] || {};
  store[key] = { medical, ts: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > INTENT_CACHE_MAX) {
    // Evict oldest first; the cache is a cost optimization, not a source of truth.
    keys
      .sort((a, b) => store[a].ts - store[b].ts)
      .slice(0, keys.length - INTENT_CACHE_MAX)
      .forEach((k) => delete store[k]);
  }
  await chrome.storage.local.set({ [INTENT_CACHE_KEY]: store });
}

/** Rolling one-hour window. Returns false when the cap is already spent. */
async function claimIntentBudget() {
  const now = Date.now();
  const stamps = ((await chrome.storage.local.get(INTENT_RATE_KEY))[INTENT_RATE_KEY] || [])
    .filter((t) => now - t < 60 * 60 * 1000);
  if (stamps.length >= INTENT_MAX_PER_HOUR) {
    await chrome.storage.local.set({ [INTENT_RATE_KEY]: stamps });
    return false;
  }
  stamps.push(now);
  await chrome.storage.local.set({ [INTENT_RATE_KEY]: stamps });
  return true;
}

/**
 * Ask the backend whether `query` is about the user's own health.
 *
 * TRI-STATE, deliberately (Fix_16). This used to collapse "the model said no"
 * and "I could not reach the model" into one `false`, which is fine for the
 * Tier-1 MISS path — it fails closed, so an unreachable backend just means no
 * drawer — but wrong for the Tier-1 ambiguous-HIT path, which must fail OPEN:
 * a Tier-1 hit already carries real evidence, so when Bedrock is down, the
 * hourly cap is spent, or the request times out, the drawer should still open.
 * Degrading to slightly-noisy beats degrading to silent for 30 unattended days.
 *
 * Only a genuine {"medical": false} from the backend is "no". Everything else —
 * rate cap, timeout, non-200, thrown error — is "unavailable".
 *
 * @returns {Promise<"yes"|"no"|"unavailable">}
 */
async function checkIntent(query) {
  const key = intentCacheKey(query);
  if (!key) return "unavailable";

  const cached = await readIntentCache(key);
  if (cached !== null) return cached ? "yes" : "no";

  if (!(await claimIntentBudget())) {
    console.debug("[Companion] intent check skipped: hourly cap reached");
    return "unavailable";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);
  try {
    const res = await fetch(LAMBDA_ENDPOINT + "intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const medical = !!(await res.json()).medical;
    // Only a real verdict is cached. An "unavailable" must never be, or one
    // outage would pin a query to a stale answer for the full 7-day TTL.
    await writeIntentCache(key, medical);
    return medical ? "yes" : "no";
  } catch (err) {
    console.debug("[Companion] intent check failed:", String((err && err.message) || err));
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

// Streaming transport: the drawer opens a "companion-chat" Port and sends a
// { type: "start", payload } message; we stream response chunks back over it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "companion-chat") return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "start") {
      streamCompanionBackend(port, msg.payload);
    }
  });
});

/* ---- Health report analysis (FrontEnd_Reports Epic) ----------------------
 * A SECOND Port, deliberately not a generalisation of the chat one: the chat
 * path is the highest-risk code in this extension and this feature has no
 * reason to touch it. Two differences from streamCompanionBackend():
 *   - status codes are MAPPED before posting, so the panel can show the
 *     specific message the backend meant rather than a generic failure;
 *   - a longer timeout, because a multimodal read of a dense PDF takes longer
 *     than a chat turn.
 * Measured against the deployed backend: a 71 KB PDF took ~27s end to end and
 * a 360 KB photo ~24s, so 90s leaves real headroom.
 */
const REPORT_TIMEOUT_MS = 90000;

async function streamReportBackend(port, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  const onDisconnect = () => controller.abort();
  port.onDisconnect.addListener(onDisconnect);

  try {
    const res = await fetch(LAMBDA_ENDPOINT + "report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Each of these has its own copy in the panel; anything else is generic.
      const mapped =
        res.status === 429 ? "quota" :
        res.status === 413 ? "too_large" :
        res.status === 400 ? "bad_file" :
        "http_" + res.status;
      safePost(port, { type: "error", error: mapped });
      return;
    }
    if (!res.body || !res.body.getReader) {
      const text = await res.text();
      if (text) safePost(port, { type: "chunk", text });
      safePost(port, { type: "done" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) safePost(port, { type: "chunk", text });
    }
    const tail = decoder.decode();
    if (tail) safePost(port, { type: "chunk", text: tail });
    safePost(port, { type: "done" });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    safePost(port, {
      type: "error",
      error: aborted ? "timeout" : String((err && err.message) || err),
    });
  } finally {
    clearTimeout(timer);
    try {
      port.onDisconnect.removeListener(onDisconnect);
    } catch (_) {}
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "companion-report") return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "start") {
      streamReportBackend(port, msg.payload);
    }
  });
});

/* ---- Manual entry point: toolbar icon + keyboard shortcut (Fix_17) -------
 * A second, deliberate way in, beside the automatic interception path. The
 * drawer already supports it: openDrawer(null, {force:true}) opens the panel
 * without asking anything and without spending a Bedrock call.
 *
 * ONLY THE UI IS INJECTED. The interception utils and content.js are
 * deliberately absent from this list, so pressing the toolbar icon on an
 * arbitrary page does NOT install keystroke listeners or the 500ms URL poll
 * there. The interception surface stays exactly what the manifest declares.
 * Do not add files here for convenience.
 *
 * PROBE BEFORE INJECTING. An earlier version injected first and relied on
 * drawer.js's ns.__drawerInjected guard making re-injection a no-op. That holds
 * WITHIN a version and breaks across an extension reload, which is exactly when
 * it matters: reloading the extension invalidates an open tab's content script
 * context — its chrome.* calls are dead — but the tab's isolated world keeps
 * __drawerInjected = true. A fresh injection then early-returns, never
 * registers the message listener, and the click does nothing. Observed on a
 * Google tab that had been open across a reload, while an undeclared host
 * (wikipedia) worked, because there the injection was the first one.
 *
 * So: message first, and only recover when nothing answers.
 */
const PANEL_FILES = ["components/report-panel.js", "components/drawer.js"];

const OPEN_PANEL_MSG = { type: "COMPANION_OPEN_PANEL" };

let badgeTimer = null;

/** Briefly mark the icon. A dead button that does nothing reads as breakage. */
async function flashBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
  } catch (_) {
    /* badge is cosmetic; never let it throw into the click handler */
  }
}

/**
 * Runs IN the page's isolated world (serialized, so no closures — top-level
 * globals only). Clears a drawer left behind by a previous extension version so
 * a fresh copy can mount.
 *
 * Only ever called after nothing answered the probe, which means that drawer is
 * already dead: its context is invalidated, so it can neither respond nor talk
 * to storage. Nothing is lost by removing it. Do NOT call this
 * unconditionally — on a healthy tab it would destroy a live session
 * transcript.
 */
function resetStalePanel() {
  try {
    const host = document.getElementById("companion-drawer-host");
    if (host) host.remove();
    if (globalThis.Companion) delete globalThis.Companion.__drawerInjected;
  } catch (_) {
    /* best effort */
  }
}

/**
 * Open (or toggle) the panel in `tab`. Fired by BOTH the toolbar click and the
 * keyboard shortcut: `_execute_action` routes to chrome.action.onClicked when
 * the action has no default_popup, so there is one code path, not two.
 */
async function openPanelInTab(tab) {
  if (!tab || !tab.id) return;
  const tabId = tab.id;

  // 1. Probe. On a declared host with a healthy content script this succeeds
  //    and we inject nothing — activeTab is not even consumed.
  try {
    await chrome.tabs.sendMessage(tabId, OPEN_PANEL_MSG);
    return;
  } catch (_) {
    // Nothing answered: either the UI was never injected here (an undeclared
    // host), or a stale pre-reload content script is holding the guard.
  }

  // 2. Recover: clear anything dead, then inject a fresh copy.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: resetStalePanel });
    await chrome.scripting.executeScript({ target: { tabId }, files: PANEL_FILES });
  } catch (err) {
    // chrome://, the New Tab Page, the Web Store, other extensions' pages and
    // the PDF viewer cannot be injected, by Chrome's design — for every
    // extension, not just this one. Nothing to be done; say so and stop.
    console.warn("[Companion] Chrome does not allow the panel on this page:",
      String((err && err.message) || err));
    await flashBadge("—");
    return;
  }

  // 3. Retry against the fresh copy.
  try {
    await chrome.tabs.sendMessage(tabId, OPEN_PANEL_MSG);
  } catch (err) {
    console.warn("[Companion] panel injected but did not answer — reload this tab:",
      String((err && err.message) || err));
    await flashBadge("↻");
  }
}

chrome.action.onClicked.addListener(openPanelInTab);

/**
 * Resolve the identity for this install (Fix_12).
 *
 * A fresh install has NO token and falls back to the seeded demo persona, so a
 * new user sees three months of history, populated insights and working memory
 * recall with zero setup.
 *
 * Nothing here ever WRITES user_token. That is load-bearing: this used to
 * provision a UUID on install, which would leave storage always populated and
 * make the demo fallback dead code. `user_token` is now purely a user-supplied
 * override:
 *
 *   chrome.storage.local.set({ user_token: crypto.randomUUID() });  // clean slate
 *   chrome.storage.local.remove("user_token");                      // back to demo
 *
 * Storage is read fresh on every call, so an override takes effect on the next
 * request with nothing to invalidate.
 *
 * @returns {Promise<{token: string, isDemo: boolean}>}
 */
async function resolveUser() {
  const stored = await chrome.storage.local.get(USER_TOKEN_KEY);
  const custom = stored[USER_TOKEN_KEY];
  return { token: custom || DEMO_USER_TOKEN, isDemo: !custom };
}

/**
 * The token to send with API requests.
 * @returns {Promise<string>}
 */
async function getUserToken() {
  return (await resolveUser()).token;
}

// Bridge: content scripts / panel cannot call getUserToken() directly across
// the service-worker boundary, so expose it over runtime messaging.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "GET_USER_TOKEN") {
    // isDemo drives the drawer's "Demo persona" label — one storage read
    // answers both questions.
    resolveUser().then(({ token, isDemo }) => sendResponse({ token, isDemo }));
    return true; // keep the message channel open for the async response
  }
  // One-shot Patterns & Insights request (non-streaming).
  if (message && message.type === "COMPANION_INSIGHTS") {
    fetchInsights(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async response
  }
  // Cloud intent check (Fix_6, tri-state since Fix_16). Always resolves.
  //
  // `medical` is kept alongside `verdict` and stays strictly "was it an explicit
  // yes". That is not redundancy: any reader that still looks only at `medical`
  // — a stale content script, a future caller — keeps the old fail-CLOSED
  // behaviour rather than silently inheriting the fail-open one.
  if (message && message.type === "COMPANION_INTENT") {
    checkIntent(message.payload && message.payload.query)
      .then((verdict) => sendResponse({ ok: true, verdict, medical: verdict === "yes" }))
      .catch(() => sendResponse({ ok: true, verdict: "unavailable", medical: false }));
    return true; // async response
  }
  return false;
});

// Also expose on the worker's global scope for any same-context callers.
self.getUserToken = getUserToken;
