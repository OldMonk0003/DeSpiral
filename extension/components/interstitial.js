// Companion — Therapeutic Circuit Breaker (Fix_9)
//
// A full-screen grounding overlay shown for 20s when a health search is
// intercepted, so there is a physical pause before the user consumes medical
// information. Meanwhile the drawer — which opens on the SAME event — generates
// and types out its answer underneath, so at t=0 the response is already there.
//
// This file adds NOTHING to the network path. drawer.js already opens and
// streams on `companion:health-query`; we simply cover the screen while it does.
//
// ---------------------------------------------------------------------------
// STACKING — load-bearing, do not "tidy" this:
//   The drawer host is already at z-index 2147483647 (the maximum), so we
//   cannot outrank it numerically. We win on DOM order instead:
//     - drawer.js registers its listener at load, and MUST be listed before
//       this file in manifest.json, so its listener runs first;
//     - openDrawer() appends its host synchronously (ensure() -> build(),
//       before its first await);
//     - our host, appended after, therefore wins the equal-z-index tie.
//   Reordering the manifest entries makes the drawer render ON TOP of this
//   overlay.
//
// SYNCHRONOUS DECISION — also load-bearing:
//   chrome.storage.local is async, and drawer.js adds its .open class after one
//   await plus a rAF. If we waited on storage, the drawer's slide-in could paint
//   before we covered it. So state is cached in memory at load and refreshed via
//   chrome.storage.onChanged; the decision at event time is synchronous.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const ns = (globalThis.Companion = globalThis.Companion || {});

  const HOST_ID = "companion-grounding-host";
  const DURATION_S = 20;
  const COOLDOWN_MS = 30 * 60 * 1000;
  const FADE_MS = 300;
  // Independent of the step state machine: if anything goes wrong, the overlay
  // still comes down. It covers the user's browser — it must never get stuck.
  const HARD_TIMEOUT_MS = (DURATION_S + 5) * 1000;

  const K_ENABLED = "interstitial_enabled";
  const K_LAST = "interstitial_last_shown";
  const K_SNOOZE = "snooze_until"; // shared with drawer.js

  // Verbatim from the requirement doc; each technique sums to exactly 20s.
  const GROUNDING_TECHNIQUES = [
    {
      id: "breathing_4_6",
      title: "4–6 Extended Exhale",
      type: "pulse_circle",
      duration: 20,
      steps: [
        { text: "Inhale slowly through your nose...", duration: 4 },
        { text: "Exhale gently through your mouth...", duration: 6 },
        { text: "Inhale once more...", duration: 4 },
        { text: "Exhale and release tension...", duration: 6 },
      ],
    },
    {
      id: "muscle_unclench",
      title: "Somatic Tension Reset",
      type: "text_fade",
      duration: 20,
      steps: [
        { text: "Unclench your jaw. Drop your tongue from the roof of your mouth.", duration: 6 },
        { text: "Drop your shoulders down and away from your ears.", duration: 7 },
        { text: "Uncurl your fingers. Let your hands rest heavy.", duration: 7 },
      ],
    },
    {
      id: "sensory_3_2_1",
      title: "3–2–1 Sensory Grounding",
      type: "text_fade",
      duration: 20,
      steps: [
        { text: "Look away from the screen. Find 3 things that are blue.", duration: 7 },
        { text: "Notice 2 physical textures near you (desk, clothing).", duration: 7 },
        { text: "Listen for 1 quiet sound in your environment.", duration: 6 },
      ],
    },
  ];

  // ---- the decision (pure; unit-tested) ------------------------------------

  /**
   * @param {object} s
   * @param {boolean} [s.enabled]        toggle state (absent/undefined => on)
   * @param {number}  [s.lastShown]      epoch ms of the last mount
   * @param {number}  [s.snoozedUntil]   epoch ms from the drawer's snooze
   * @param {number}  s.now
   * @param {boolean} [s.isEmergency]
   * @param {boolean} [s.alreadyMounted]
   * @returns {boolean}
   */
  function shouldShowInterstitial(s) {
    s = s || {};
    if (s.alreadyMounted) return false;
    // Acute presentations bypass entirely — see utils/emergency-signals.js.
    if (s.isEmergency) return false;
    // Default ON: only an explicit false disables it.
    if (s.enabled === false) return false;
    if (s.snoozedUntil && s.now < s.snoozedUntil) return false;
    if (s.lastShown && s.now - s.lastShown < COOLDOWN_MS) return false;
    return true;
  }

  // ---- synchronous state cache ---------------------------------------------

  const state = { enabled: true, lastShown: 0, snoozeUntil: 0 };

  function loadState() {
    try {
      chrome.storage.local.get([K_ENABLED, K_LAST, K_SNOOZE], (v) => {
        if (chrome.runtime.lastError || !v) return;
        state.enabled = v[K_ENABLED] !== false; // absent => enabled
        state.lastShown = Number(v[K_LAST] || 0);
        state.snoozeUntil = Number(v[K_SNOOZE] || 0);
      });
    } catch (_) {
      /* storage unavailable — keep defaults, fail toward showing */
    }
  }

  function watchState() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes) return;
        if (changes[K_ENABLED]) state.enabled = changes[K_ENABLED].newValue !== false;
        if (changes[K_LAST]) state.lastShown = Number(changes[K_LAST].newValue || 0);
        if (changes[K_SNOOZE]) state.snoozeUntil = Number(changes[K_SNOOZE].newValue || 0);
      });
    } catch (_) {
      /* ignore */
    }
  }

  function markShown(now) {
    state.lastShown = now; // update the cache first — the write is async
    try {
      chrome.storage.local.set({ [K_LAST]: now });
    } catch (_) {
      /* ignore */
    }
  }

  // ---- overlay -------------------------------------------------------------

  let hostEl = null;
  let shadow = null;
  let tickTimer = null;
  let hardTimer = null;
  let fadeTimer = null;

  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function css() {
    return `
      :host { all: initial; }
      .veil {
        position: fixed; inset: 0;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 26px;
        background: rgba(9, 12, 20, 0.86);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #e7e9ee; text-align: center; padding: 24px;
        /* NO fade-in, deliberately. Anything that makes visibility depend on an
           animation or rAF callback running — a class toggled from rAF, or a
           keyframe from 0% — can leave this at opacity 0 while it still
           swallows every click: an invisible full-screen blocker. Verified in a
           non-painting context where animations never advance. It is also the
           better interruption: the pause should land immediately.
           The requirement doc asks for a fade-OUT only, which is below and is
           backed by a timer that tears down regardless. */
        opacity: 1;
      }
      .veil.out { opacity: 0; transition: opacity ${FADE_MS}ms ease; }

      /* Brand mark, top-left.
         ABSOLUTELY POSITIONED ON PURPOSE: .veil is a centred flex column, so a
         brand added as a flex CHILD would become a flex item and push the
         technique title, circle, countdown and Skip button down. Out of flow it
         cannot move them, and it adds no gap — absolutely positioned children
         do not participate in flex layout.
         NO animation and NO transition here, deliberately: see the visibility
         note on .veil above. It is also non-focusable and aria-hidden, so the
         Tab trap on the Skip button and the dialog's own label are untouched. */
      .brand {
        position: absolute; top: 20px; left: 22px;
        display: flex; align-items: center; gap: 10px;
        max-width: 260px; text-align: left;
      }
      .brand-logo {
        width: 28px; height: 28px; flex: 0 0 auto; border-radius: 50%;
        background-size: contain; background-repeat: no-repeat; background-position: center;
      }
      .brand-text { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
      .brand-name { font-size: 13px; font-weight: 700; color: #e7e9ee; letter-spacing: .2px; }
      .brand-tag { font-size: 10.5px; color: #8b95a5; }
      /* On a narrow or short screen the tagline wraps to two or three lines and
         can crowd the centred content. Drop it there; the mark and name still
         carry the branding. */
      @media (max-width: 420px), (max-height: 600px) {
        .brand-tag { display: none; }
      }

      .title { font-size: 13px; letter-spacing: .09em; text-transform: uppercase; color: #5eead4; font-weight: 600; }
      .stage { display: flex; align-items: center; justify-content: center; height: 190px; width: 190px; }
      .circle {
        width: 92px; height: 92px; border-radius: 50%;
        background: radial-gradient(circle at 50% 45%, rgba(94,234,212,.34), rgba(79,70,229,.30));
        border: 1px solid rgba(94,234,212,.45);
        transform: scale(.72); transition: transform linear;
      }
      .circle.expand { transform: scale(1.32); }
      .step { font-size: 19px; line-height: 1.55; max-width: 30ch; opacity: 0; transition: opacity 600ms ease; }
      .step.show { opacity: 1; }
      .count { font-size: 13px; color: #9aa4b2; font-variant-numeric: tabular-nums; }
      .skip {
        margin-top: 4px; cursor: pointer;
        background: rgba(255,255,255,.10); color: #e7e9ee;
        border: 1px solid rgba(255,255,255,.20); border-radius: 10px;
        padding: 9px 18px; font-size: 13px; font-family: inherit;
      }
      .skip:hover { background: rgba(255,255,255,.17); }
      .skip:focus-visible { outline: 2px solid #5eead4; outline-offset: 2px; }
      .note { font-size: 11.5px; color: #7c8698; max-width: 34ch; line-height: 1.5; }
      @media (prefers-reduced-motion: reduce) {
        .veil, .step { transition: none; }
        .circle { transition: none; transform: scale(1); }
      }
    `;
  }

  function teardown() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
    shadow = null;
  }

  /** Fade out, then remove. Safe to call repeatedly. */
  function dismiss() {
    if (!hostEl) return;
    try {
      const veil = shadow && shadow.querySelector(".veil");
      if (veil) veil.classList.add("out");
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      fadeTimer = setTimeout(teardown, FADE_MS);
    } catch (_) {
      teardown();
    }
  }

  function mount(technique) {
    const reduce = reducedMotion();

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    // pointer-events:auto — unlike the drawer, this is deliberately blocking.
    hostEl.style.cssText =
      "position:fixed;inset:0;margin:0;padding:0;border:0;" +
      "pointer-events:auto;z-index:2147483647;";
    shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = css();

    const veil = document.createElement("div");
    veil.className = "veil";
    veil.setAttribute("role", "dialog");
    veil.setAttribute("aria-modal", "true");
    veil.setAttribute("aria-label", "Grounding pause: " + technique.title);

    // Brand. Read from ns at MOUNT time, not module scope: the node suite
    // requires this file without drawer.js, so a module-scope read would be
    // undefined there. Degrades to name-only if the mark is unavailable.
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.setAttribute("aria-hidden", "true");
    const mark = ns.LOGO_DATA_URI;
    if (mark) {
      const brandLogo = document.createElement("span");
      brandLogo.className = "brand-logo";
      brandLogo.style.backgroundImage = 'url("' + mark + '")';
      brand.appendChild(brandLogo);
    }
    const brandText = document.createElement("div");
    brandText.className = "brand-text";
    const brandName = document.createElement("div");
    brandName.className = "brand-name";
    brandName.textContent = "DeSpiral";
    const brandTag = document.createElement("div");
    brandTag.className = "brand-tag";
    brandTag.textContent = "The AI Circuit Breaker for Health Anxiety";
    brandText.append(brandName, brandTag);
    brand.appendChild(brandText);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = technique.title;

    const stage = document.createElement("div");
    stage.className = "stage";
    let circle = null;
    if (technique.type === "pulse_circle") {
      circle = document.createElement("div");
      circle.className = "circle";
      stage.appendChild(circle);
    }

    const step = document.createElement("div");
    step.className = "step";
    step.setAttribute("aria-live", "polite");

    const count = document.createElement("div");
    count.className = "count";

    const skip = document.createElement("button");
    skip.className = "skip";
    skip.type = "button";
    // No justification required. Making someone declare an emergency to skip
    // adds friction and guilt at the worst possible moment.
    skip.textContent = "Skip";

    const note = document.createElement("div");
    note.className = "note";
    note.textContent =
      "If this is a medical emergency, skip and call your local emergency number.";

    veil.append(brand, title, stage, step, count, skip, note);
    shadow.append(style, veil);
    document.body.appendChild(hostEl);

    // ---- interaction
    skip.addEventListener("click", dismiss);
    veil.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      } else if (e.key === "Tab") {
        // Only one focusable element — keep focus on it.
        e.preventDefault();
        skip.focus();
      }
    });
    try { skip.focus(); } catch (_) { /* ignore */ }

    // ---- step engine: one interval, everything derived from elapsed time, so
    // a missed tick self-corrects instead of drifting.
    const startedAt = Date.now();
    let shownIndex = -1;

    const render = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(DURATION_S - elapsed));
      count.textContent = remaining + "s";

      let acc = 0;
      let index = technique.steps.length - 1;
      for (let i = 0; i < technique.steps.length; i++) {
        acc += technique.steps[i].duration;
        if (elapsed < acc) { index = i; break; }
      }

      if (index !== shownIndex) {
        shownIndex = index;
        const s = technique.steps[index];
        step.classList.remove("show");
        const paint = () => {
          step.textContent = s.text;
          step.classList.add("show");
          if (circle) {
            // Expand on inhale, contract otherwise; the transition runs for the
            // step's own duration so the circle paces the breath.
            circle.style.transitionDuration = reduce ? "0ms" : s.duration + "s";
            circle.classList.toggle("expand", /inhale/i.test(s.text));
          }
        };
        if (reduce) paint();
        else setTimeout(paint, 220); // let the fade-out land first
      }

      if (elapsed >= DURATION_S) dismiss();
    };

    render();
    tickTimer = setInterval(render, 250);
    hardTimer = setTimeout(teardown, HARD_TIMEOUT_MS);
    // No reveal step needed: .veil is opaque by default and animates itself in.
  }

  // ---- entry point ---------------------------------------------------------

  function onHealthQuery(event) {
    try {
      const query = (event && event.detail && event.detail.query) || "";
      const isEmergency =
        typeof ns.isEmergencyQuery === "function" ? ns.isEmergencyQuery(query) : false;

      const show = shouldShowInterstitial({
        enabled: state.enabled,
        lastShown: state.lastShown,
        snoozedUntil: state.snoozeUntil,
        now: Date.now(),
        isEmergency: isEmergency,
        alreadyMounted: !!hostEl,
      });

      if (!show) {
        console.debug(
          "[Companion] grounding pause skipped" + (isEmergency ? " (emergency query)" : "")
        );
        return;
      }

      // Count the cooldown from MOUNT, not completion — otherwise skipping means
      // being re-prompted on the very next search.
      markShown(Date.now());
      mount(GROUNDING_TECHNIQUES[Math.floor(Math.random() * GROUNDING_TECHNIQUES.length)]);
    } catch (err) {
      console.warn("[Companion] grounding overlay failed:", err);
      teardown(); // never leave the page covered
    }
  }

  loadState();
  watchState();
  window.addEventListener("companion:health-query", onHealthQuery);
  window.addEventListener("pagehide", teardown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") teardown();
  });

  ns.shouldShowInterstitial = shouldShowInterstitial;
  ns.GROUNDING_TECHNIQUES = GROUNDING_TECHNIQUES;
  ns.dismissGroundingOverlay = dismiss; // manual escape hatch from the console
})();
