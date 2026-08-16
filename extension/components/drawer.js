// Companion — Isolated Floating Drawer UI (Epic A3)
//
// A glassmorphic, right-anchored sidebar rendered entirely inside a Shadow DOM
// so no CSS leaks in either direction with the host page (Google/ChatGPT/
// Gemini). Opens in response to the `companion:health-query` event dispatched
// by content.js, or via the exposed Companion.openDrawer()/closeDrawer() API.
//
// Chat replies are fetched live from the deployed AWS Lambda Function URL
// (hybrid CockroachDB memory + Bedrock). See fetchCompanionReply() / runTurn().

(function () {
  "use strict";

  const ns = (globalThis.Companion = globalThis.Companion || {});
  if (ns.__drawerInjected) return; // one drawer per page
  ns.__drawerInjected = true;

  const HOST_ID = "companion-drawer-host";
  const STORAGE_SNOOZE = "snooze_until";
  // Shared with components/interstitial.js, which watches this key via
  // chrome.storage.onChanged. Absent means enabled.
  const STORAGE_GROUNDING = "interstitial_enabled";
  // Owned by background.js — watched here only to flip the "Demo persona" chip.
  const STORAGE_USER_TOKEN = "user_token";
  const SNOOZE_MS = 60 * 60 * 1000; // 1 hour

  // The actual backend call happens in the service worker (CORS-exempt);
  // the drawer only assembles the payload and messages it across.
  const PAGE_CONTEXT_MAX = 2000; // cap extracted page text sent to backend


  let hostEl = null;
  let shadow = null;
  let el = {}; // cached element refs
  let isOpen = false;
  // A health query that arrived but has NOT been answered yet. Set only when
  // interception lands while snoozed, and consumed by the Resume pill (Epic
  // A3.4: "re-opens the drawer with the pending query").
  //
  // Deliberately NOT "the last query the drawer saw". It used to be, and that
  // conflated two states: snoozing a turn that had ALREADY been answered and
  // then resuming re-sent the same query as a brand-new turn — a duplicate
  // exchange, a wasted Bedrock call, and a reply that opened with "you've
  // already seen the general info", because turn 1 was still in
  // sessionMessages and went up as history.
  let pendingQuery = null;
  let toastTimer = null;
  let reportPanel = null; // { open, close } from components/report-panel.js
  // Client-owned session transcript (source of truth for the live conversation,
  // sent to the backend as native messages[]). Kept for the drawer's lifetime.
  let sessionMessages = []; // [{ role: "user"|"assistant", text }]
  let sessionStartedAt = null;
  const HISTORY_SEND_CAP = 16; // prior turns sent per request (backend caps too)
  // Was this drawer opened deliberately (toolbar / shortcut) rather than by a
  // confirmed health query? A manual open can happen on ANY page, so
  // extractPageContext() would otherwise ship up to 2000 characters of whatever
  // the user was reading — webmail, a document, a bank statement — to the
  // backend on their first message, with no health signal involved. Suppressing
  // it is what keeps the product's "text with no health signal stays on your
  // device" promise true once there is a toolbar button (Fix_17).
  let manualSession = false;

  // ---- storage helpers (fail-safe if chrome.storage is unavailable) --------

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(keys, (v) => resolve(v || {}));
          return;
        }
      } catch (_) {}
      resolve({});
    });
  }

  function storageSet(obj) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj);
      }
    } catch (_) {}
  }

  function storageRemove(key) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(key);
      }
    } catch (_) {}
  }

  // The DeSpiral mark, inlined as a 32px data URI. drawer.js is a content
  // script: referencing a packaged file would need chrome.runtime.getURL()
  // plus a web_accessible_resources entry, which also exposes the asset to
  // every host page. Source: extension/icon/icon-32.png.
  const LOGO_DATA_URI =
    "data:image/png;base64,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";

  // ---- styles (scoped inside the shadow root) ------------------------------

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .drawer {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 384px; max-width: 94vw;
      display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e7e9ee;
      background: linear-gradient(160deg, rgba(20,22,31,0.86), rgba(14,15,22,0.9));
      backdrop-filter: blur(22px) saturate(140%);
      -webkit-backdrop-filter: blur(22px) saturate(140%);
      border-left: 1px solid rgba(255,255,255,0.09);
      box-shadow: -24px 0 60px rgba(0,0,0,0.45);
      transform: translateX(105%);
      transition: transform 340ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      z-index: 2147483647;
    }
    .drawer.open { transform: translateX(0); }

    /* Header ------------------------------------------------------------- */
    /* Two rows: identity (mark, name, demo chip) + Close above, the feature
       controls below. Close rides row 1 so it sits in the true top-right
       corner, so row 2 can align left with the mark, and so it is not adjacent
       to Snooze — a mis-click there silences interception for an hour. */
    .hdr {
      display: flex; flex-direction: column; gap: 10px;
      padding: 13px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .idrow { display: flex; align-items: center; gap: 10px; }
    /* flex:1 + min-width:0 => the identity block absorbs any squeeze rather
       than pushing Close off the row. */
    .brand { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .logo {
      width: 30px; height: 30px; flex: 0 0 auto;
      border-radius: 50%;
      background-image: url("${LOGO_DATA_URI}");
      background-size: contain; background-repeat: no-repeat; background-position: center;
      box-shadow: 0 3px 12px rgba(20,184,166,0.30);
    }
    .title { font-size: 15px; font-weight: 700; letter-spacing: 0.2px; }
    /* Status label, not a control — quiet enough not to compete with the name.
       Shown only while running on the seeded demo identity (Fix_12): it is what
       makes shared memory legible, so a judge reads a pre-existing search as
       the demo working rather than as a stranger's query. */
    .demotag {
      font-size: 10px; font-weight: 600; letter-spacing: .04em;
      color: #9aa4b2; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10); border-radius: 999px;
      padding: 2px 8px; white-space: nowrap; flex: 0 0 auto;
    }
    .demotag[hidden] { display: none; }

    /* Left-aligned (default flex-start), sharing the mark's left edge. These
       were right-aligned until Close moved up to row 1; with Close gone the
       three feature controls read as a cluster, and pushing them right again
       would leave the header with no shared alignment edge. Fix_14. */
    .controls { display: flex; align-items: center; gap: 6px; }

    .iconbtn {
      background: rgba(255,255,255,0.05); color: #cbd2dc;
      border: 1px solid rgba(255,255,255,0.09); border-radius: 8px;
      height: 30px; padding: 0 9px; font-size: 11.5px; cursor: pointer;
      display: inline-flex; align-items: center; gap: 4px;
      transition: background 140ms, color 140ms;
    }
    .iconbtn:hover { background: rgba(255,255,255,0.12); color: #fff; }
    .iconbtn.close { width: 30px; padding: 0; justify-content: center; font-size: 14px; }
    /* Icon-only at 30px like .close: the controls row already holds four items
       inside a 384px panel, and .brand absorbs the squeeze by shrinking. */
    .iconbtn.ground { width: 30px; padding: 0; justify-content: center; font-size: 14px; }
    .iconbtn.ground.off { opacity: .38; }

    /* Feed --------------------------------------------------------------- */
    .feed {
      flex: 1; overflow-y: auto; padding: 16px 14px;
      display: flex; flex-direction: column; gap: 12px;
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    .feed::-webkit-scrollbar { width: 8px; }
    .feed::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 8px; }

    .msg { max-width: 88%; padding: 10px 13px; border-radius: 14px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; animation: rise 260ms ease both; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .msg.user { align-self: flex-end; background: linear-gradient(135deg, #4f46e5, #6366f1); color: #fff; border-bottom-right-radius: 5px; }
    .msg.ai { align-self: flex-start; background: rgba(255,255,255,0.055); border: 1px solid rgba(255,255,255,0.07); border-bottom-left-radius: 5px; }
    .msg.error { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.32); color: #fecaca; }

    /* Rendered markdown inside AI bubbles */
    .msg.ai { white-space: normal; }
    .msg.ai h1, .msg.ai h2, .msg.ai h3, .msg.ai h4, .msg.ai h5, .msg.ai h6 { margin: 11px 0 6px; line-height: 1.3; font-weight: 700; color: #f0f2f6; }
    .msg.ai h1 { font-size: 15px; }
    .msg.ai h2 { font-size: 14px; }
    .msg.ai h3 { font-size: 13px; color: #cdd3dc; }
    .msg.ai h4, .msg.ai h5, .msg.ai h6 { font-size: 12.5px; color: #cdd3dc; }
    .msg.ai p { margin: 7px 0; }
    .msg.ai ul, .msg.ai ol { margin: 7px 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
    .msg.ai li { line-height: 1.45; }
    .msg.ai hr { border: none; border-top: 1px solid rgba(255,255,255,0.12); margin: 11px 0; }
    .msg.ai code { background: rgba(255,255,255,0.1); padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .msg.ai strong { font-weight: 700; color: #f0f2f6; }
    .msg.ai em { font-style: italic; }
    .msg.ai > :first-child { margin-top: 0; }
    .msg.ai > :last-child { margin-bottom: 0; }

    /* Loading state ------------------------------------------------------ */
    .loading { align-self: flex-start; display: flex; align-items: center; gap: 9px; font-size: 12px; color: #9aa4b2; padding: 8px 4px; }
    .dots { display: inline-flex; gap: 4px; }
    .dots span { width: 6px; height: 6px; border-radius: 50%; background: #6366f1; animation: blink 1.2s infinite ease-in-out; }
    .dots span:nth-child(2) { animation-delay: 0.18s; }
    .dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }

    /* Doctor questions card --------------------------------------------- */
    .qcard { align-self: stretch; background: rgba(20,184,166,0.08); border: 1px solid rgba(20,184,166,0.28); border-radius: 14px; padding: 13px 14px; animation: rise 260ms ease both; }
    .qcard h4 { margin: 0 0 9px; font-size: 12px; font-weight: 700; color: #5eead4; display: flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: 0.4px; }
    .qcard ol { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
    .qcard li { font-size: 12.5px; line-height: 1.45; color: #d7dde6; }
    .qcard .copy { margin-top: 11px; width: 100%; justify-content: center; background: rgba(20,184,166,0.16); border-color: rgba(20,184,166,0.4); color: #5eead4; height: 32px; }
    .qcard .copy:hover { background: rgba(20,184,166,0.28); color: #fff; }
    .qcard .copy.copied { background: rgba(52,211,153,0.28); color: #fff; }

    /* Composer ----------------------------------------------------------- */
    .composer { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid rgba(255,255,255,0.07); }
    .composer input {
      flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; padding: 10px 12px; color: #e7e9ee; font-size: 13px; outline: none;
    }
    .composer input::placeholder { color: #7c8593; }
    .composer input:focus { border-color: #6366f1; }
    .composer .send {
      flex: 0 0 auto; background: linear-gradient(135deg, #14b8a6, #6366f1); color: #fff;
      border: none; border-radius: 10px; padding: 0 14px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .composer .send:hover { filter: brightness(1.08); }

    /* Resume pill (shown instead of the panel while snoozed) ------------- */
    .pill {
      position: fixed; right: 0; bottom: 96px;
      display: flex; align-items: center; gap: 10px;
      padding: 10px 15px 10px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e7e9ee; text-align: left; cursor: pointer;
      background: linear-gradient(135deg, rgba(20,22,31,0.92), rgba(14,15,22,0.94));
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255,255,255,0.1); border-right: none;
      border-radius: 12px 0 0 12px;
      box-shadow: -10px 0 28px rgba(0,0,0,0.42);
      transform: translateX(105%);
      transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto; z-index: 2147483647;
    }
    .pill.visible { transform: translateX(0); }
    .pill:hover { filter: brightness(1.08); }
    .pill .plogo {
      width: 28px; height: 28px; flex: 0 0 auto; border-radius: 50%;
      background-image: url("${LOGO_DATA_URI}");
      background-size: contain; background-repeat: no-repeat; background-position: center;
      opacity: 0.95;
    }
    .pill .ptext { display: flex; flex-direction: column; line-height: 1.25; }
    .pill .ptitle { font-size: 12.5px; font-weight: 600; }
    .pill .psub { font-size: 10.5px; color: #9aa4b2; }
    .pill .presume { font-size: 11px; font-weight: 700; color: #5eead4; margin-top: 1px; }

    /* Toast (transient confirmation) ------------------------------------ */
    .toast {
      position: fixed; right: 16px; bottom: 20px;
      max-width: 300px; padding: 11px 14px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 12.5px; line-height: 1.4; color: #e7e9ee;
      background: rgba(20,22,31,0.95);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.45);
      opacity: 0; transform: translateY(8px);
      transition: opacity 220ms ease, transform 220ms ease;
      pointer-events: none; z-index: 2147483647;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    /* Patterns & Insights panel -------------------------------------------- */
    .insights-panel {
      position: absolute; inset: 0; z-index: 5;
      display: flex; flex-direction: column;
      background: linear-gradient(160deg, rgba(20,22,31,0.99), rgba(14,15,22,1));
      transform: translateX(100%);
      transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .insights-panel.open { transform: translateX(0); }
    .ins-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .ins-title { font-size: 14px; font-weight: 700; }
    .ins-back { height: 30px; }
    .ins-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 16px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
    .ins-empty { color: #9aa4b2; font-size: 13px; text-align: center; padding: 30px 12px; line-height: 1.5; }
    .ins-take { font-size: 13px; line-height: 1.5; color: #e7e9ee; background: rgba(20,184,166,0.08); border: 1px solid rgba(20,184,166,0.25); border-radius: 12px; padding: 11px 13px; }
    .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .tile { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 9px 6px; text-align: center; }
    .tile .tv { font-size: 16px; font-weight: 700; color: #f0f2f6; }
    .tile .tl { font-size: 9px; color: #9aa4b2; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
    .sec { display: flex; flex-direction: column; gap: 7px; }
    .sec-h { font-size: 11px; font-weight: 700; color: #9aa4b2; text-transform: uppercase; letter-spacing: 0.4px; }
    .row { display: grid; grid-template-columns: 96px 1fr 24px; align-items: center; gap: 8px; font-size: 12px; }
    .row .rl { color: #cbd2dc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .rb { background: rgba(255,255,255,0.06); border-radius: 6px; height: 10px; overflow: hidden; }
    .row .rf { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, #14b8a6, #6366f1); }
    .row .rc { text-align: right; color: #9aa4b2; font-size: 11px; }
    .rf.emotion-panic { background: #ef4444; }
    .rf.emotion-anxious { background: #f59e0b; }
    .rf.emotion-worried { background: #eab308; }
    .rf.emotion-uneasy { background: #14b8a6; }
    .rf.tod { background: linear-gradient(90deg, #6366f1, #a855f7); }
    .spark { width: 100%; height: 46px; }
    .spark polyline { fill: none; stroke: #5eead4; stroke-width: 2; vector-effect: non-scaling-stroke; }
    .spark circle { fill: #5eead4; }
  `;

  // ---- markup --------------------------------------------------------------

  const TEMPLATE = `
    <div class="drawer" role="complementary" aria-label="DeSpiral support drawer">
      <header class="hdr">
        <div class="idrow">
          <div class="brand">
            <span class="logo" aria-hidden="true"></span>
            <div class="title">DeSpiral</div>
            <span class="demotag" hidden>Demo persona</span>
          </div>
          <button class="iconbtn close" title="Close" aria-label="Close">✕</button>
        </div>
        <div class="controls">
          <button class="iconbtn ground" title="Grounding pause" aria-label="Grounding pause" aria-pressed="true">🧘</button>
          <button class="iconbtn insights" title="Patterns & Insights" aria-label="Patterns and Insights">📊</button>
          <button class="iconbtn snooze" title="Snooze for 1 hour">💤 1h</button>
          <button class="iconbtn report" title="Analyse a test report" aria-label="Analyse a test report">🧪</button>
        </div>
      </header>
      <div class="feed" role="log" aria-live="polite"></div>
      <form class="composer">
        <input type="text" autocomplete="off" placeholder="Ask a follow-up…" aria-label="Follow-up question" />
        <button type="submit" class="send">Send</button>
      </form>
      <div class="insights-panel" aria-hidden="true">
        <header class="ins-head">
          <button class="iconbtn ins-back" title="Back to chat" aria-label="Back to chat">← Back</button>
          <div class="ins-title">Patterns &amp; Insights</div>
        </header>
        <div class="ins-body"></div>
      </div>
    </div>
    <button class="pill" type="button" aria-label="Resume DeSpiral">
      <span class="plogo" aria-hidden="true"></span>
      <span class="ptext">
        <span class="ptitle">DeSpiral snoozed</span>
        <span class="psub">Tap to resume</span>
        <span class="presume">↻ Resume now</span>
      </span>
    </button>
    <div class="toast" role="status" aria-live="polite"></div>
  `;

  // ---- build ---------------------------------------------------------------

  function build() {
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    // Pin critical layout inline so no host-page rule can dislodge us.
    hostEl.style.cssText =
      "position:fixed;top:0;right:0;width:0;height:0;margin:0;padding:0;border:0;" +
      "pointer-events:none;z-index:2147483647;";

    shadow = hostEl.attachShadow({ mode: "open" });
    shadow.innerHTML = "<style>" + STYLES + "</style>" + TEMPLATE;
    document.body.appendChild(hostEl);

    el.drawer = shadow.querySelector(".drawer");
    el.feed = shadow.querySelector(".feed");
    el.form = shadow.querySelector(".composer");
    el.input = shadow.querySelector(".composer input");
    el.snooze = shadow.querySelector(".snooze");
    el.close = shadow.querySelector(".close");
    el.pill = shadow.querySelector(".pill");
    el.pillSub = shadow.querySelector(".pill .psub");
    el.toast = shadow.querySelector(".toast");
    el.groundBtn = shadow.querySelector("button.ground");
    el.insBtn = shadow.querySelector("button.insights");
    el.reportBtn = shadow.querySelector("button.report");
    el.insights = shadow.querySelector(".insights-panel");
    el.insBody = shadow.querySelector(".ins-body");
    el.insBack = shadow.querySelector(".ins-back");

    // Wire controls.
    el.close.addEventListener("click", closeDrawer);
    el.snooze.addEventListener("click", onSnooze);
    el.form.addEventListener("submit", onComposerSubmit);
    el.pill.addEventListener("click", onResume);
    el.insBtn.addEventListener("click", openInsights);
    el.insBack.addEventListener("click", closeInsights);
    el.groundBtn.addEventListener("click", onGroundToggle);

    // Report panel: a self-contained view mounted into this same shadow root.
    // It owns all of its own markup, styles and state — see report-panel.js.
    if (typeof ns.createReportPanel === "function") {
      reportPanel = ns.createReportPanel({ shadow, getUserToken, renderMarkdown });
      el.reportBtn.addEventListener("click", () => reportPanel.open());
    }

    // Restore the grounding-pause toggle (absent => on).
    storageGet([STORAGE_GROUNDING]).then((v) => {
      paintGroundToggle(v[STORAGE_GROUNDING] !== false);
    });

    // Show the "Demo persona" chip only while running on the seeded default.
    refreshDemoTag();
    watchDemoTag();
  }

  function ensure() {
    if (!hostEl) build();
  }

  // ---- feed rendering ------------------------------------------------------

  function scrollToEnd() {
    el.feed.scrollTop = el.feed.scrollHeight;
  }

  // ---- minimal, XSS-safe markdown renderer --------------------------------
  // The model returns markdown. We escape all HTML first, then emit only a
  // whitelisted set of tags we generate ourselves, so nothing user/model-
  // supplied can inject markup.

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderInline(text) {
    // Protect inline code spans from bold/italic processing.
    const codes = [];
    let out = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return " " + (codes.length - 1) + " ";
    });
    out = out
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, "<em>$1</em>");
    return out.replace(/ (\d+) /g, (_, i) => "<code>" + codes[Number(i)] + "</code>");
  }

  function renderMarkdown(md) {
    const lines = escapeHtml(md || "").split(/\r?\n/);
    const html = [];
    let listType = null; // 'ul' | 'ol'
    let para = [];

    const flushPara = () => {
      if (para.length) {
        html.push("<p>" + renderInline(para.join(" ")) + "</p>");
        para = [];
      }
    };
    const closeList = () => {
      if (listType) {
        html.push("</" + listType + ">");
        listType = null;
      }
    };

    for (const raw of lines) {
      const t = raw.trim();
      // A blank line ends a paragraph but must NOT close an open list: LLMs
      // emit "loose" lists with blank lines between items, and closing here
      // would split them into single-item lists (each <ol> restarting at 1).
      // The list is closed instead by the plain-text / heading / hr branches.
      if (t === "") { flushPara(); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); closeList(); html.push("<hr>"); continue; }

      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { flushPara(); closeList(); const l = h[1].length; html.push("<h" + l + ">" + renderInline(h[2]) + "</h" + l + ">"); continue; }

      const ul = /^[-*]\s+(.*)$/.exec(t);
      if (ul) { flushPara(); if (listType !== "ul") { closeList(); listType = "ul"; html.push("<ul>"); } html.push("<li>" + renderInline(ul[1]) + "</li>"); continue; }

      const ol = /^\d+\.\s+(.*)$/.exec(t);
      if (ol) { flushPara(); if (listType !== "ol") { closeList(); listType = "ol"; html.push("<ol>"); } html.push("<li>" + renderInline(ol[1]) + "</li>"); continue; }

      closeList();
      para.push(t);
    }
    flushPara();
    closeList();
    return html.join("");
  }

  function addMessage(text, who) {
    const div = document.createElement("div");
    div.className = "msg " + (who === "user" ? "user" : "ai");
    if (who === "user") {
      div.textContent = text; // user input rendered as plain text
    } else {
      div.innerHTML = renderMarkdown(text); // AI markdown -> safe HTML
    }
    el.feed.appendChild(div);
    scrollToEnd();
    return div;
  }

  function addErrorMessage(text) {
    const div = document.createElement("div");
    div.className = "msg ai error";
    div.textContent = text;
    el.feed.appendChild(div);
    scrollToEnd();
    return div;
  }

  function showLoading(label) {
    hideLoading();
    const wrap = document.createElement("div");
    wrap.className = "loading";
    wrap.dataset.loading = "1";
    wrap.innerHTML =
      '<span class="dots"><span></span><span></span><span></span></span>' +
      '<span class="ltext"></span>';
    wrap.querySelector(".ltext").textContent =
      label || "Retrieving baseline memory from CockroachDB…";
    el.feed.appendChild(wrap);
    scrollToEnd();
  }

  function hideLoading() {
    const existing = el.feed.querySelector('[data-loading="1"]');
    if (existing) existing.remove();
  }

  function addDoctorQuestions(questions) {
    const card = document.createElement("div");
    card.className = "qcard";

    const h4 = document.createElement("h4");
    h4.textContent = "🩺 Questions for Your Doctor";
    card.appendChild(h4);

    const ol = document.createElement("ol");
    questions.forEach((q) => {
      const li = document.createElement("li");
      li.textContent = q;
      ol.appendChild(li);
    });
    card.appendChild(ol);

    const copyBtn = document.createElement("button");
    copyBtn.className = "iconbtn copy";
    copyBtn.textContent = "📋 Copy to Clipboard";
    copyBtn.addEventListener("click", () => copyQuestions(questions, copyBtn));
    card.appendChild(copyBtn);

    el.feed.appendChild(card);
    scrollToEnd();
  }

  function copyQuestions(questions, btn) {
    const text = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    const done = () => {
      btn.classList.add("copied");
      btn.textContent = "✓ Copied";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = "📋 Copy to Clipboard";
      }, 1600);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    } catch (_) {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      shadow.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    } catch (_) {}
  }

  // ---- demo-persona label (Fix_12) ----------------------------------------

  /** Ask the service worker whether we're on the seeded demo identity and
   *  show/hide the chip accordingly. The SW owns the token rule; the drawer
   *  never decides this for itself. */
  function refreshDemoTag() {
    const tag = shadow && shadow.querySelector(".demotag");
    if (!tag) return;
    try {
      chrome.runtime.sendMessage({ type: "GET_USER_TOKEN" }, (resp) => {
        if (chrome.runtime.lastError) return;
        tag.hidden = !(resp && resp.isDemo);
      });
    } catch (_) {
      /* leave hidden */
    }
  }

  /** Setting or clearing user_token flips the chip without a page reload. */
  function watchDemoTag() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes && changes[STORAGE_USER_TOKEN]) {
          refreshDemoTag();
        }
      });
    } catch (_) {
      /* ignore */
    }
  }

  // ---- backend integration (AWS Lambda Function URL) ----------------------

  /** Fetch the persistent user_token from the background service worker. */
  function getUserToken() {
    return new Promise((resolve) => {
      try {
        if (
          typeof chrome === "undefined" ||
          !chrome.runtime ||
          !chrome.runtime.sendMessage
        ) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage({ type: "GET_USER_TOKEN" }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp && resp.token ? resp.token : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /** Extract a bounded snippet of the current page as context for the model. */
  function extractPageContext() {
    try {
      const title = document.title || "";
      const metaEl = document.querySelector('meta[name="description"]');
      const desc = metaEl ? metaEl.getAttribute("content") || "" : "";
      const bodyText = document.body ? document.body.innerText : "";
      return [title, desc, bodyText]
        .filter(Boolean)
        .join(" — ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PAGE_CONTEXT_MAX);
    } catch (_) {
      return "";
    }
  }

  // The persona switcher was removed from the UI: flipping it changed nothing
  // the model saw, because the system prompt has no persona placeholder and the
  // user_profiles upsert is ON CONFLICT DO NOTHING. These fixed values keep the
  // backend payload contract (and the user_profiles columns) unchanged.
  const PROFILE_DEFAULTS = { anxiety_tier: "severe", communication_style: "gentle_soft" };

  /** Assemble the request payload for a chat turn. */
  async function buildPayload(userPrompt, history) {
    const token = await getUserToken();
    const profile = PROFILE_DEFAULTS;
    return {
      user_token: token || "anonymous",
      user_prompt: userPrompt,
      // Empty on a manually-opened drawer — see manualSession. The backend
      // substitutes "No active page context." for an empty value, so this needs
      // no contract change.
      page_context: manualSession ? "" : extractPageContext(),
      anxiety_tier: profile.anxiety_tier,
      communication_style: profile.communication_style,
      history: history || [],
      session_started_at: sessionStartedAt,
    };
  }

  /**
   * Open a streaming Port to the background worker (which fetches the Lambda)
   * and drive the handler callbacks: onChunk(text), onDone(), onError(err).
   * Guarantees exactly one terminal callback (done OR error).
   */
  function streamCompanionReply(userPrompt, history, handlers) {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        if (fn) fn(arg);
      } catch (_) {}
    };

    buildPayload(userPrompt, history)
      .then((payload) => {
        let port;
        try {
          port = chrome.runtime.connect({ name: "companion-chat" });
        } catch (err) {
          finish(handlers.onError, err);
          return;
        }
        port.onMessage.addListener((msg) => {
          if (!msg || settled) return;
          if (msg.type === "chunk") {
            try {
              if (handlers.onChunk) handlers.onChunk(msg.text);
            } catch (_) {}
          } else if (msg.type === "done") {
            finish(handlers.onDone);
            try { port.disconnect(); } catch (_) {}
          } else if (msg.type === "error") {
            finish(handlers.onError, new Error(msg.error || "backend_error"));
            try { port.disconnect(); } catch (_) {}
          }
        });
        port.onDisconnect.addListener(() => {
          const le = chrome.runtime.lastError;
          finish(handlers.onError, new Error((le && le.message) || "disconnected"));
        });
        port.postMessage({ type: "start", payload });
      })
      .catch((err) => finish(handlers.onError, err));
  }

  /**
   * Run one chat turn: stream the reply into a live-updating AI bubble with a
   * paced typewriter reveal. Raw port chunks are pushed onto an in-memory
   * queue; a rAF render loop reveals a small adaptive batch at most once per
   * ~tick and re-parses markdown once per visual update — never once per raw
   * network event. On completion (or port close) the remainder is flushed and
   * a final markdown pass is performed.
   */
  function runTurn(userPrompt, loadingLabel) {
    showLoading(loadingLabel);

    // Session bookkeeping: snapshot prior turns as history (excludes the current
    // message), then record the current user turn in the transcript.
    if (!sessionStartedAt) sessionStartedAt = new Date().toISOString();
    const history = sessionMessages.slice(-HISTORY_SEND_CAP);
    sessionMessages.push({ role: "user", text: userPrompt });

    // One steady reveal speed for the whole turn — no acceleration when the
    // network finishes. Bedrock streams faster than this, so a backlog builds
    // and simply keeps draining at the same calm pace past completion.
    const TICK_MS = 18;        // min gap between visual updates
    const STEP_CAP = 2;        // max chars per paint (~110 cps ceiling)
    const DRAIN_DIVISOR = 16;  // gentle ramp at the very start/end...
    const MIN_STEP = 1;        // ...at least 1 char per paint

    let bubble = null;
    let pending = "";         // queued characters not yet shown
    let revealed = "";        // characters currently in the DOM
    let rafId = null;
    let lastPaint = 0;

    const ensureBubble = () => {
      if (bubble) return;
      hideLoading(); // first visible characters — drop the spinner
      bubble = document.createElement("div");
      bubble.className = "msg ai";
      el.feed.appendChild(bubble);
    };

    // Follow the stream only when the user is already near the bottom, so we
    // never yank them up while they scroll back to re-read earlier text.
    const autoScroll = () => {
      const feed = el.feed;
      if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) {
        feed.scrollTop = feed.scrollHeight;
      }
    };

    const paint = () => {
      ensureBubble();
      bubble.innerHTML = renderMarkdown(revealed);
      autoScroll();
    };

    const stopLoop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    // Reveal everything remaining at once + a final markdown render.
    const flushAll = () => {
      stopLoop();
      if (pending) {
        revealed += pending;
        pending = "";
      }
      if (revealed) paint();
    };

    const tick = (ts) => {
      rafId = null;
      if (pending && ts - lastPaint >= TICK_MS) {
        lastPaint = ts;
        // Steady, capped reveal so a large backlog never dumps in one paint and
        // the pace never changes mid-stream.
        const step = Math.min(STEP_CAP, Math.max(MIN_STEP, Math.ceil(pending.length / DRAIN_DIVISOR)));
        revealed += pending.slice(0, step);
        pending = pending.slice(step);
        paint();
      }
      // Keep ticking while there's a backlog; otherwise idle until the next
      // chunk restarts the loop (or completion flushes the queue).
      if (pending) rafId = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (rafId === null) rafId = requestAnimationFrame(tick);
    };

    streamCompanionReply(userPrompt, history, {
      onChunk: (text) => {
        if (!text) return;
        pending += text; // queue only — no DOM work on the raw network event
        startLoop();
      },
      onDone: () => {
        const fullText = revealed + pending;
        if (!fullText) {
          hideLoading();
          addErrorMessage(
            "I couldn't quite read a response just now. Let's try that again in a moment."
          );
          return;
        }
        // Record the assistant turn so the next request carries this exchange.
        sessionMessages.push({ role: "assistant", text: fullText });
        // Don't snap the remainder in — let the loop keep draining the queue at
        // the same steady pace so the reveal stays smooth to the end.
        startLoop();
      },
      onError: (err) => {
        console.warn("[Companion] stream failed:", err);
        if (revealed || pending) {
          flushAll(); // keep whatever streamed in before the error
          return;
        }
        stopLoop();
        hideLoading();
        const message = (err && err.message) || "";
        // Distinct from a connection failure: the backend is fine, its daily
        // spend cap is spent. Saying so plainly beats implying a fault.
        if (/quota/i.test(message)) {
          addErrorMessage("Daily cap on Bedrock usage hit.");
          return;
        }
        addErrorMessage(
          /timeout/i.test(message)
            ? "That's taking longer than usual. Take a slow breath — we can try again in a moment."
            : "I'm having trouble connecting right now. You're okay — let's try again shortly."
        );
      },
    });
  }

  // ---- control handlers ----------------------------------------------------


  /** Reflect the grounding-pause toggle in the button (no storage write). */
  function paintGroundToggle(on) {
    if (!el.groundBtn) return;
    el.groundBtn.classList.toggle("off", !on);
    el.groundBtn.setAttribute("aria-pressed", on ? "true" : "false");
    el.groundBtn.title = on
      ? "Grounding pause: on (20s before results)"
      : "Grounding pause: off";
  }

  /** Toggle the 20s grounding overlay. interstitial.js picks the change up
   *  through chrome.storage.onChanged — no direct coupling between them. */
  function onGroundToggle() {
    const on = el.groundBtn.getAttribute("aria-pressed") !== "true";
    paintGroundToggle(on);
    storageSet({ [STORAGE_GROUNDING]: on });
    showToast(on ? "Grounding pause on." : "Grounding pause off.");
  }

  function onSnooze() {
    const until = Date.now() + SNOOZE_MS;
    storageSet({ [STORAGE_SNOOZE]: until });
    showToast("Snoozed until " + fmtTime(until) + " — DeSpiral will stay quiet.");
    closeDrawer();
    showSnoozePill();
  }

  function onResume() {
    storageRemove(STORAGE_SNOOZE);
    hideSnoozePill();
    showToast("DeSpiral resumed.");
    // Only run a turn if a query was intercepted WHILE snoozed and is still
    // unanswered. Resuming a snooze taken mid-conversation just re-opens the
    // panel: the transcript is untouched, since closeDrawer only hides it.
    const q = pendingQuery;
    pendingQuery = null;
    openDrawer(q, { force: true });
  }

  // ---- snooze affordances (toast + resume pill) ----------------------------

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (_) {
      return "later";
    }
  }

  function showToast(msg) {
    ensure();
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2800);
  }

  async function showSnoozePill() {
    ensure();
    const v = await storageGet([STORAGE_SNOOZE]);
    const until = Number(v[STORAGE_SNOOZE] || 0);
    el.pillSub.textContent = until
      ? "Snoozed until " + fmtTime(until)
      : "Tap to resume";
    el.pill.classList.add("visible");
  }

  function hideSnoozePill() {
    if (el.pill) el.pill.classList.remove("visible");
  }

  // ---- Patterns & Insights panel ------------------------------------------

  /** Ask the background worker for the insights snapshot (one-shot). */
  function fetchInsights() {
    return new Promise((resolve, reject) => {
      getUserToken()
        .then((token) => {
          chrome.runtime.sendMessage(
            {
              type: "COMPANION_INSIGHTS",
              payload: {
                user_token: token || "anonymous",
                // Minutes EAST of UTC. getTimezoneOffset() returns minutes
                // BEHIND UTC (-330 for IST), which is the opposite sign from
                // what everyone expects — hence the negation. Read at request
                // time, not at load, so a session crossing a DST boundary
                // still reports correctly.
                tz_offset_minutes: -new Date().getTimezoneOffset(),
              },
            },
            (resp) => {
              if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
              if (!resp) { reject(new Error("no_response")); return; }
              if (resp.ok) resolve(resp.data);
              else reject(new Error(resp.error || "insights_error"));
            }
          );
        })
        .catch(reject);
    });
  }

  function openInsights() {
    ensure();
    el.insights.classList.add("open");
    el.insBody.innerHTML = '<div class="ins-empty">Loading your patterns…</div>';
    fetchInsights()
      .then(renderInsights)
      .catch((err) => {
        console.warn("[Companion] insights failed:", err);
        el.insBody.innerHTML =
          '<div class="ins-empty">Couldn\'t load your insights right now. Let\'s try again shortly.</div>';
      });
  }

  function closeInsights() {
    if (el.insights) el.insights.classList.remove("open");
  }

  function insCap(s) {
    s = String(s || "");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function insBarRow(label, count, max, cls) {
    const pct = max ? Math.round((count / max) * 100) : 0;
    return (
      '<div class="row"><span class="rl">' + escapeHtml(label) + "</span>" +
      '<span class="rb"><span class="rf ' + (cls || "") + '" style="width:' + pct + '%"></span></span>' +
      '<span class="rc">' + count + "</span></div>"
    );
  }

  function insSection(title, inner) {
    return '<div class="sec"><div class="sec-h">' + escapeHtml(title) + "</div>" + inner + "</div>";
  }

  function insSparkline(values, w, h) {
    w = w || 240; h = h || 46;
    if (!values.length) return "";
    const max = Math.max.apply(null, values.concat([1]));
    const n = values.length;
    const pts = values.map((v, i) => {
      const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
      const y = h - 5 - (v / max) * (h - 10);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    const last = pts[pts.length - 1].split(",");
    return (
      '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts.join(" ") + '" />' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.5" />' +
      "</svg>"
    );
  }

  // Neutral, fixed heading. Deliberately NOT a verdict on how the user is
  // doing: earlier this line judged the emotional trend ("you've been trending
  // calmer") off a coarse first-vs-last weekly average, which lands badly when
  // it disagrees with how the person actually feels. CBT self-monitoring works
  // the other way round — show the observations, let the user draw the
  // conclusion.
  const INSIGHTS_HEADING = "A track of your thoughts";

  function renderInsights(d) {
    if (!d || !d.total) {
      el.insBody.innerHTML =
        '<div class="ins-empty">Not enough history yet — check back after a few conversations. 💙</div>';
      return;
    }
    const tileData = [
      ["Searches", d.total],
      ["Active days", d.active_days],
      ["Days tracked", d.span_days],
      ["Calm streak", d.calm_streak_days == null ? "—" : d.calm_streak_days + "d"],
    ];
    const tiles = tileData
      .map((t) => '<div class="tile"><div class="tv">' + escapeHtml(String(t[1])) + '</div><div class="tl">' + escapeHtml(t[0]) + "</div></div>")
      .join("");

    const themes = d.themes || [];
    const tmax = Math.max.apply(null, themes.map((t) => t.count).concat([1]));
    const themesHtml = themes.map((t) => insBarRow(t.theme, t.count, tmax, "")).join("");

    const emo = d.emotions || [];
    const emax = Math.max.apply(null, emo.map((e) => e.count).concat([1]));
    const emoHtml = emo.map((e) => insBarRow(insCap(e.state), e.count, emax, "emotion-" + e.state)).join("");

    const tod = d.time_of_day || [];
    const todmax = Math.max.apply(null, tod.map((t) => t.count).concat([1]));
    const todHtml = tod.map((t) => insBarRow(t.bucket, t.count, todmax, "tod")).join("");

    const spark = insSparkline((d.weekly_volume || []).map((w) => w.count));

    el.insBody.innerHTML =
      '<div class="ins-take">' + escapeHtml(INSIGHTS_HEADING) + "</div>" +
      '<div class="tiles">' + tiles + "</div>" +
      insSection("Worry themes", themesHtml) +
      insSection("How you've been feeling", emoHtml) +
      insSection("When it tends to hit", todHtml) +
      insSection("Activity over time", spark);
  }

  function onComposerSubmit(event) {
    event.preventDefault(); // our own form; keep the host page untouched
    const text = (el.input.value || "").trim();
    if (!text) return;
    el.input.value = "";
    addMessage(text, "user");
    runTurn(text, "Thinking…");
  }

  // ---- public API ----------------------------------------------------------

  async function isSnoozed() {
    const v = await storageGet([STORAGE_SNOOZE]);
    const until = Number(v[STORAGE_SNOOZE] || 0);
    return Date.now() < until;
  }

  async function openDrawer(query, opts) {
    opts = opts || {};
    ensure();

    // While snoozed, don't pop the full panel — surface a dismissible Resume
    // pill instead, so the user always has a visible way back in. Hold the
    // query so Resume can answer it: this is the ONLY place pendingQuery is set.
    if (!opts.force && (await isSnoozed())) {
      console.log("[Companion] snoozed — showing Resume pill instead of the drawer.");
      if (query) pendingQuery = query;
      showSnoozePill();
      return;
    }
    hideSnoozePill();

    // rAF so the initial transform is applied before we add .open (animation).
    //
    // The `isOpen` guard is load-bearing, not defensive. closeDrawer() removes
    // .open SYNCHRONOUSLY, but this adds it two frames later — so an open
    // followed by a close within the same frame would let this callback
    // resurrect a drawer the user had just closed. Unreachable before Fix_17
    // (nobody can click ✕ before the first paint), but the toolbar shortcut has
    // key-repeat, which fires the toggle twice in one frame. Reproduced in the
    // harness, where the drawer came back visibly after a fast double-press.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (isOpen) el.drawer.classList.add("open");
      });
    });
    isOpen = true;

    if (query) {
      // Answered now, so no longer pending — otherwise a later snooze/resume
      // could replay a stale query.
      pendingQuery = null;
      addMessage(query, "user");
      runTurn(query, "Retrieving baseline memory from CockroachDB…");
    }
  }

  function closeDrawer() {
    if (el.drawer) el.drawer.classList.remove("open");
    closeInsights();
    isOpen = false;
  }

  ns.openDrawer = openDrawer;
  ns.closeDrawer = closeDrawer;
  // Shared with components/report-panel.js so there is exactly ONE markdown
  // renderer in the extension. Report text is model output derived from a
  // user-supplied file — the least trustworthy input in the product — so it
  // must go through the same escape-first renderer the chat feed uses.
  ns.renderMarkdown = renderMarkdown;
  // Shared with components/interstitial.js so the grounding overlay can carry
  // the same mark without a second copy of the asset, and without
  // chrome.runtime.getURL() + web_accessible_resources — which would expose the
  // icon to every host page (see the note on LOGO_DATA_URI above).
  ns.LOGO_DATA_URI = LOGO_DATA_URI;

  // ---- integration: open on confirmed health query ------------------------

  window.addEventListener("companion:health-query", (event) => {
    const q = event && event.detail ? event.detail.query : "";
    // An automatic open is on a search or assistant page the user just typed
    // into, so the surrounding page IS the context and is safe to send. Reset
    // the flag here so a manual open earlier in the tab cannot suppress it.
    manualSession = false;
    openDrawer(q);
  });

  // ---- integration: open on demand (toolbar icon / shortcut, Fix_17) -------
  // background.js injects this file on click and then sends this message. Only
  // one listener can ever register per page, because the whole module
  // early-returns on ns.__drawerInjected.

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "COMPANION_OPEN_PANEL") {
      if (isOpen) {
        closeDrawer();
      } else {
        manualSession = true;
        // force: true bypasses snooze deliberately — snooze silences
        // INTERCEPTION, and someone who just clicked the icon is asking for the
        // panel; answering with a Resume pill would be obtuse. It does not
        // clear snooze_until, so interception stays snoozed either way.
        openDrawer(null, { force: true });
      }
      sendResponse({ ok: true });
    }
    return false;
  });
})();
