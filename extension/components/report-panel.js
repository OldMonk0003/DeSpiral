// Companion — Health report upload panel (FrontEnd_Reports Epic)
//
// A slide-over panel inside the drawer's Shadow Root where the user uploads a
// lab report (PDF or photo) and reads a plain-language streamed analysis of it.
//
// ---------------------------------------------------------------------------
// A FACTORY, NOT A SELF-MOUNTING IIFE. drawer.js calls createReportPanel() once
// from build(), passing its own shadow root, token getter and markdown renderer.
//
// WHY IT MOUNTS INTO THE DRAWER'S SHADOW ROOT rather than creating a second
// host element: an independent host would have to replicate the drawer's fixed
// geometry (384px, max-width 94vw, top:0;bottom:0) and win a z-index tie by DOM
// order — the same fragile stacking problem documented at the top of
// interstitial.js. Mounting inside inherits the geometry for free.
//
// EVERY CLASS IS PREFIXED `rp-`. Not cosmetic: an unprefixed class collision
// inside this shared shadow root already broke the insights button once
// (commit b128af4). The only unprefixed classes used here are `iconbtn` and
// `msg ai`, both deliberately reused from drawer.js for styling.
//
// NOTHING ABOUT A REPORT IS EVER WRITTEN TO chrome.storage — not the file, not
// the text, not the filename. The panel's badge says never stored, and
// chrome.storage.local is storage. There is no storageSet in this file.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const ns = (globalThis.Companion = globalThis.Companion || {});

  // Mirrors the backend's MAX_REPORT_BYTES. The backend enforces this
  // authoritatively; we enforce it too so the user gets an instant, specific
  // message instead of a round trip.
  const MAX_BYTES = 3 * 1024 * 1024;

  // Task 5 downscale ladder. Resolution is preferred over quality when trading
  // off: the model has to read small printed numbers, and JPEG artefacts hurt
  // legibility less than downsampling does. So quality steps down fully at
  // 2000px before the long edge is reduced at all.
  const LONG_EDGE_STEPS = [2000, 1600];
  const QUALITY_STEPS = [0.9, 0.8, 0.7, 0.6];

  const BADGE_TEXT =
    "🔒 Encrypted in transit, analysed in memory. Never stored — and never added to your memory.";
  const LIMITS_TEXT = "PDF, PNG or JPEG · up to 3 MB";

  // Extension -> media type. We map explicitly and never pass file.type
  // through: browsers report "image/jpg" and empty strings in the wild, and
  // both are 400s at the backend, which accepts exactly three values.
  const EXT_TO_MEDIA = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };

  const MAGIC = {
    "application/pdf": [0x25, 0x50, 0x44, 0x46], // %PDF
    "image/png": [0x89, 0x50, 0x4e, 0x47], // \x89PNG
    "image/jpeg": [0xff, 0xd8, 0xff],
  };

  const ERROR_TEXT = {
    bad_file: "That file type isn't supported. Please upload a PDF, PNG or JPEG.",
    too_large: "That file is larger than 3 MB.",
    quota: "Daily cap on Bedrock usage hit.",
    timeout: "That's taking longer than usual. Take a slow breath — we can try again in a moment.",
    generic: "I couldn't read that report just now. Nothing was stored — let's try again shortly.",
  };

  const STYLES = `
    .rp-panel {
      position: absolute; inset: 0; z-index: 6;
      display: flex; flex-direction: column;
      background: linear-gradient(160deg, rgba(20,22,31,0.99), rgba(14,15,22,1));
      transform: translateX(100%);
      transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .rp-panel.rp-open { transform: translateX(0); }

    .rp-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .rp-title { font-size: 14px; font-weight: 700; }
    .rp-back { height: 30px; }

    .rp-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
    .rp-body::-webkit-scrollbar { width: 8px; }
    .rp-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 8px; }

    .rp-state { display: flex; flex-direction: column; gap: 14px; }
    .rp-state[hidden] { display: none; }

    /* Privacy badge — visible in idle and result. Wording is contractual: the
       backend writes no row, logs no content and generates no embedding. */
    .rp-badge {
      font-size: 11.5px; line-height: 1.5; color: #a7f3e4;
      background: rgba(20,184,166,0.10); border: 1px solid rgba(20,184,166,0.28);
      border-radius: 10px; padding: 9px 11px;
    }

    .rp-drop {
      border: 1px dashed rgba(255,255,255,0.22); border-radius: 14px;
      padding: 22px 16px; text-align: center; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; gap: 7px;
      background: rgba(255,255,255,0.03);
      transition: background 140ms, border-color 140ms;
    }
    .rp-drop:hover, .rp-drop.rp-over { background: rgba(20,184,166,0.09); border-color: rgba(20,184,166,0.5); }
    .rp-drop-icon { font-size: 26px; line-height: 1; }
    .rp-drop-main { font-size: 13px; font-weight: 600; color: #e7e9ee; }
    .rp-drop-sub { font-size: 11.5px; color: #9aa4b2; }
    .rp-pick {
      margin-top: 6px; background: linear-gradient(135deg, #14b8a6, #6366f1); color: #fff;
      border: none; border-radius: 10px; padding: 8px 14px; font-size: 12.5px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    .rp-pick:hover { filter: brightness(1.08); }

    /* The "invalid" state: idle plus this banner, so the picker stays available
       and the user can immediately choose a different file. */
    .rp-reject {
      font-size: 12.5px; line-height: 1.45; color: #fecaca;
      background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.32);
      border-radius: 10px; padding: 9px 11px;
    }
    .rp-reject[hidden] { display: none; }

    .rp-working { align-items: center; text-align: center; padding-top: 22px; gap: 12px; }
    .rp-fname { font-size: 12.5px; color: #cbd2dc; word-break: break-all; max-width: 100%; }
    .rp-working-label { font-size: 12.5px; color: #9aa4b2; }
    .rp-dots { display: inline-flex; gap: 4px; }
    .rp-dots span { width: 6px; height: 6px; border-radius: 50%; background: #14b8a6; animation: rp-blink 1.2s infinite ease-in-out; }
    .rp-dots span:nth-child(2) { animation-delay: 0.18s; }
    .rp-dots span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes rp-blink { 0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }

    /* Reuses drawer.js's .msg.ai markdown styles (headings, lists, code) so the
       report reads exactly like the chat feed. Only the feed-specific layout
       properties are overridden — hence the doubled-up selector for specificity. */
    .rp-out.msg.ai { align-self: stretch; max-width: 100%; animation: none; }
    .rp-out:empty { display: none; }

    .rp-clear {
      align-self: stretch; justify-content: center;
      background: rgba(255,255,255,0.05); color: #cbd2dc;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
      height: 34px; font-size: 12.5px; cursor: pointer; font-family: inherit;
    }
    .rp-clear:hover { background: rgba(255,255,255,0.12); color: #fff; }

    .rp-err {
      font-size: 13px; line-height: 1.5; color: #fecaca;
      background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.32);
      border-radius: 12px; padding: 11px 13px;
    }
    .rp-hint { font-size: 12px; color: #9aa4b2; line-height: 1.5; }
  `;

  const TEMPLATE = `
    <header class="rp-head">
      <button class="iconbtn rp-back" title="Back to chat" aria-label="Back to chat">← Back</button>
      <div class="rp-title">Analyse a test report</div>
    </header>
    <div class="rp-body">
      <div class="rp-state rp-idle">
        <div class="rp-badge"></div>
        <div class="rp-reject" role="alert" hidden></div>
        <div class="rp-drop" role="button" tabindex="0" aria-label="Choose a report to upload">
          <div class="rp-drop-icon" aria-hidden="true">🧪</div>
          <div class="rp-drop-main">Drop your report here</div>
          <div class="rp-drop-sub"></div>
          <button class="rp-pick" type="button">Choose a file</button>
        </div>
        <div class="rp-hint">
          Your report is read once and never kept. It isn't added to your memory
          and it won't appear in your patterns.
        </div>
      </div>

      <div class="rp-state rp-working" hidden>
        <div class="rp-fname"></div>
        <div class="rp-dots" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="rp-working-label">Reading your report…</div>
      </div>

      <div class="rp-state rp-result" hidden>
        <div class="rp-badge"></div>
        <div class="rp-out msg ai" role="log" aria-live="polite"></div>
        <button class="rp-clear" type="button">Clear &amp; Erase View</button>
      </div>

      <div class="rp-state rp-error" hidden>
        <div class="rp-err"></div>
        <button class="rp-pick rp-retry" type="button">Try another file</button>
      </div>
    </div>
    <input type="file" class="rp-file" hidden
           accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" />
  `;

  // ---- pure helpers (exported for the node test suite) ---------------------

  /** Extension -> the exactly-three accepted media types, or null. */
  function mediaTypeForName(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || "").trim());
    if (!m) return null;
    return EXT_TO_MEDIA[m[1].toLowerCase()] || null;
  }

  /** Do the leading bytes match the declared media type? */
  function magicBytesAgree(mediaType, bytes) {
    const want = MAGIC[mediaType];
    if (!want || !bytes || bytes.length < want.length) return false;
    for (let i = 0; i < want.length; i++) {
      if (bytes[i] !== want[i]) return false;
    }
    return true;
  }

  /** Map a Port error code to the copy the panel shows. */
  function errorTextFor(code) {
    const key = String(code || "");
    if (ERROR_TEXT[key]) return ERROR_TEXT[key];
    return ERROR_TEXT.generic;
  }

  ns.reportMediaTypeForName = mediaTypeForName;
  ns.reportMagicBytesAgree = magicBytesAgree;
  ns.reportErrorTextFor = errorTextFor;
  ns.REPORT_MAX_BYTES = MAX_BYTES;

  // ---- the factory ---------------------------------------------------------

  ns.createReportPanel = function createReportPanel(opts) {
    const shadow = opts && opts.shadow;
    const getUserToken = (opts && opts.getUserToken) || (() => Promise.resolve(null));
    const renderMarkdown = (opts && opts.renderMarkdown) || ((t) => String(t || ""));
    if (!shadow) return { open() {}, close() {} };

    // Mount inside .drawer so the panel inherits its fixed geometry, exactly
    // like .insights-panel does.
    const mountPoint = shadow.querySelector(".drawer") || shadow;

    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "rp-panel";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = TEMPLATE;
    mountPoint.appendChild(panel);

    const q = (sel) => panel.querySelector(sel);
    const el = {
      back: q(".rp-back"),
      body: q(".rp-body"),
      idle: q(".rp-idle"),
      reject: q(".rp-reject"),
      drop: q(".rp-drop"),
      dropSub: q(".rp-drop-sub"),
      pick: q(".rp-pick"),
      working: q(".rp-working"),
      fname: q(".rp-fname"),
      result: q(".rp-result"),
      out: q(".rp-out"),
      clear: q(".rp-clear"),
      error: q(".rp-error"),
      errText: q(".rp-err"),
      retry: q(".rp-retry"),
      file: q(".rp-file"),
    };

    panel.querySelectorAll(".rp-badge").forEach((n) => { n.textContent = BADGE_TEXT; });
    el.dropSub.textContent = LIMITS_TEXT;

    // ---- retained state. Everything here is nulled by erase(). --------------
    let currentFile = null;   // the File the user chose
    let currentBytes = null;  // ArrayBuffer of the (possibly re-encoded) upload
    let currentB64 = null;    // base64 payload
    let activePort = null;    // live streaming Port
    let streamed = "";        // accumulated markdown

    function setState(name, detail) {
      // Five states, one visible at a time. `invalid` is `idle` plus the
      // rejection banner, so the picker stays available (Task 2's table).
      const isIdle = name === "idle" || name === "invalid";
      el.idle.hidden = !isIdle;
      el.working.hidden = name !== "working";
      el.result.hidden = name !== "result";
      el.error.hidden = name !== "error";
      el.reject.hidden = name !== "invalid";
      if (name === "invalid") el.reject.textContent = detail || "";
      if (name === "error") el.errText.textContent = detail || ERROR_TEXT.generic;
      if (name === "working") el.fname.textContent = detail || "";
    }

    /** Genuinely drop the report from memory — not just blank the panel. */
    function erase() {
      if (activePort) {
        try { activePort.disconnect(); } catch (_) {}
        activePort = null;
      }
      currentFile = null;
      currentBytes = null;
      currentB64 = null;
      streamed = "";
      el.out.innerHTML = "";
      // Without this a re-pick of the SAME file never fires `change`.
      try { el.file.value = ""; } catch (_) {}
      setState("idle");
    }

    // ---- reading & encoding ------------------------------------------------

    function readSlice(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(new Uint8Array(fr.result));
        fr.onerror = () => reject(fr.error || new Error("read_failed"));
        fr.readAsArrayBuffer(blob);
      });
    }

    /**
     * Base64 for a Blob of any size.
     *
     * Deliberately NOT btoa(String.fromCharCode(...bytes)): spreading a
     * multi-megabyte array into a call exceeds the argument limit and throws.
     * readAsDataURL does the encoding natively, then we strip the
     * "data:<type>;base64," prefix and any newlines — the backend rejects both.
     */
    function toBase64(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || "");
          const comma = s.indexOf(",");
          resolve((comma === -1 ? s : s.slice(comma + 1)).replace(/[\r\n]+/g, ""));
        };
        fr.onerror = () => reject(fr.error || new Error("encode_failed"));
        fr.readAsDataURL(blob);
      });
    }

    function loadBitmap(blob) {
      if (typeof createImageBitmap === "function") return createImageBitmap(blob);
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode_failed")); };
        img.src = url;
      });
    }

    function encodeCanvas(canvas, quality) {
      return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }

    /**
     * Fit an image under the size cap, re-encoding only when necessary.
     *
     * An image already under 3 MB and under the long-edge cap passes through
     * UNTOUCHED with its original media type — re-encoding a crisp PNG
     * screenshot to JPEG would degrade exactly the small printed numbers the
     * model needs to read.
     *
     * @returns {Promise<{blob: Blob, mediaType: string}|null>} null if it can't be fit.
     */
    async function fitImage(file, mediaType) {
      let bmp = null;
      try {
        bmp = await loadBitmap(file);
      } catch (_) {
        return null;
      }
      const w = bmp.width || 0;
      const h = bmp.height || 0;
      const longEdge = Math.max(w, h);

      if (file.size <= MAX_BYTES && longEdge <= LONG_EDGE_STEPS[0]) {
        return { blob: file, mediaType: mediaType };
      }

      for (const cap of LONG_EDGE_STEPS) {
        const scale = longEdge > cap ? cap / longEdge : 1;
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        // White matte: a transparent PNG flattened onto black would make dark
        // text unreadable once encoded as JPEG.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(bmp, 0, 0, cw, ch);
        for (const quality of QUALITY_STEPS) {
          const blob = await encodeCanvas(canvas, quality);
          if (blob && blob.size <= MAX_BYTES) {
            return { blob: blob, mediaType: "image/jpeg" };
          }
        }
      }
      return null;
    }

    // ---- the pipeline ------------------------------------------------------

    async function handleFile(file) {
      if (!file) return;
      erase();
      currentFile = file;

      // 1. Extension. The <input accept> is set too, but never relied on — the
      //    drop zone bypasses it entirely.
      const declared = mediaTypeForName(file.name);
      if (!declared) {
        setState("invalid", ERROR_TEXT.bad_file);
        return;
      }

      // 2. Magic bytes, before anything is sent. A renamed .txt must not reach
      //    the backend.
      let head;
      try {
        head = await readSlice(file.slice(0, 8));
      } catch (_) {
        setState("invalid", ERROR_TEXT.bad_file);
        return;
      }
      if (!magicBytesAgree(declared, head)) {
        setState(
          "invalid",
          "That file doesn't look like a real " +
            (declared === "application/pdf" ? "PDF" : "image") +
            ". Please upload a PDF, PNG or JPEG."
        );
        return;
      }

      // 3. Size — after any downscaling.
      let mediaType = declared;
      let payload = file;
      if (declared === "application/pdf") {
        if (file.size > MAX_BYTES) {
          // PDFs cannot be downscaled client-side. Give the useful next step.
          setState(
            "invalid",
            "This PDF is over 3 MB. Try uploading a photo of the page with your results instead."
          );
          return;
        }
      } else {
        setState("working", file.name);
        const fitted = await fitImage(file, declared);
        if (!fitted) {
          setState(
            "invalid",
            "That image is too large to send, even after shrinking it. Try a tighter crop of the results."
          );
          return;
        }
        payload = fitted.blob;
        mediaType = fitted.mediaType;
      }

      setState("working", file.name);
      let b64;
      try {
        const buf = await readSlice(payload);
        currentBytes = buf;
        b64 = await toBase64(payload);
      } catch (_) {
        setState("error", ERROR_TEXT.generic);
        return;
      }
      currentB64 = b64;
      send(file.name, mediaType, b64);
    }

    async function send(name, mediaType, b64) {
      let token;
      try {
        token = await getUserToken();
      } catch (_) {
        token = null;
      }
      const payload = {
        user_token: token || "anonymous",
        file: { name: name, media_type: mediaType, data: b64 },
      };

      let port;
      try {
        port = chrome.runtime.connect({ name: "companion-report" });
      } catch (_) {
        setState("error", ERROR_TEXT.generic);
        return;
      }
      activePort = port;
      streamed = "";
      let settled = false;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        try { fn(); } catch (_) {}
        try { port.disconnect(); } catch (_) {}
        if (activePort === port) activePort = null;
      };

      port.onMessage.addListener((msg) => {
        if (!msg || settled) return;
        if (msg.type === "chunk") {
          if (!msg.text) return;
          // No typewriter here, deliberately: chat paces output to feel calm,
          // but someone waiting on their blood results wants the text as it
          // arrives. Append and re-render.
          streamed += msg.text;
          if (el.result.hidden) setState("result");
          el.out.innerHTML = renderMarkdown(streamed);
          el.body.scrollTop = el.body.scrollHeight;
        } else if (msg.type === "done") {
          finish(() => {
            if (streamed) {
              setState("result");
              el.out.innerHTML = renderMarkdown(streamed);
            } else {
              setState("error", ERROR_TEXT.generic);
            }
          });
        } else if (msg.type === "error") {
          finish(() => {
            if (streamed) {
              // Partial output already on screen — keep it rather than
              // replacing a half-read report with an error.
              setState("result");
              el.out.innerHTML = renderMarkdown(streamed);
              return;
            }
            setState("error", errorTextFor(msg.error));
          });
        }
      });

      port.onDisconnect.addListener(() => {
        finish(() => {
          if (streamed) return;
          setState("error", ERROR_TEXT.generic);
        });
      });

      port.postMessage({ type: "start", payload: payload });
    }

    // ---- wiring ------------------------------------------------------------

    el.pick.addEventListener("click", (e) => {
      e.stopPropagation();
      el.file.click();
    });
    el.retry.addEventListener("click", () => {
      erase();
      el.file.click();
    });
    el.drop.addEventListener("click", () => el.file.click());
    el.drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.file.click();
      }
    });
    el.file.addEventListener("change", () => {
      const f = el.file.files && el.file.files[0];
      if (f) handleFile(f);
    });

    ["dragenter", "dragover"].forEach((type) =>
      el.drop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.drop.classList.add("rp-over");
      })
    );
    ["dragleave", "dragend"].forEach((type) =>
      el.drop.addEventListener(type, () => el.drop.classList.remove("rp-over"))
    );
    el.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.drop.classList.remove("rp-over");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    el.clear.addEventListener("click", erase);
    el.back.addEventListener("click", () => api.close());

    const api = {
      open() {
        panel.classList.add("rp-open");
        panel.setAttribute("aria-hidden", "false");
      },
      close() {
        panel.classList.remove("rp-open");
        panel.setAttribute("aria-hidden", "true");
        // Clear on close too, so the report isn't still resident behind a ← Back.
        erase();
      },
    };

    // Dismissing the whole drawer must drop the report as well — otherwise a
    // closed drawer still holds the file, the base64 and the rendered text in
    // memory, which the privacy badge says it does not.
    //
    // Done by OBSERVING the drawer's `.open` class rather than by editing
    // closeDrawer(), which this Epic's scope lock puts off limits (it is the
    // same reason the panel mounts into the existing shadow root instead of
    // adding a host). Self-contained here; the drawer knows nothing about it.
    if (mountPoint !== shadow && typeof MutationObserver === "function") {
      let wasOpen = mountPoint.classList.contains("open");
      new MutationObserver(() => {
        const nowOpen = mountPoint.classList.contains("open");
        if (wasOpen && !nowOpen) api.close();
        wasOpen = nowOpen;
      }).observe(mountPoint, { attributes: true, attributeFilter: ["class"] });
    }

    return api;
  };
})();
