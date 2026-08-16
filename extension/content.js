// Companion — DOM Search Interceptor (Task A2.1)
//
// Captures query submissions across Google, ChatGPT, and Gemini WITHOUT
// interfering with the host page. We are strictly a passive observer: we never
// call preventDefault()/stopPropagation(), so search behaviour is untouched.
//
// Three capture surfaces:
//   1. Enter keypress on <input>/<textarea>/contenteditable search fields.
//   2. <form> submit events.
//   3. URL ?q= mutations (covers Google results navigation + SPA route changes).
//
// Every extracted query flows through evaluateQuery(), which runs the tier
// pipeline loaded from utils/*.js: Tier 1 exact regex (ambiguous matches are
// verified with one cloud check, the rest open instantly) -> Tier 1b fuzzy ->
// weak-signal gate -> Tier 1.5 cloud intent check.

(function () {
  "use strict";

  const ns = (globalThis.Companion = globalThis.Companion || {});

  const MIN_QUERY_LEN = 3;
  let lastQuery = "";
  let lastAt = 0;
  const DEDUPE_WINDOW_MS = 1500;

  // ---- Safe text extraction ------------------------------------------------

  /** Pull the text a user typed out of an input/textarea/contenteditable node. */
  function extractText(el) {
    if (!el || typeof el !== "object") return "";
    try {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        return String(el.value || "");
      }
      if (el.isContentEditable) {
        return String(el.innerText || el.textContent || "");
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  /** Best-effort: find the primary text field inside a submitted form. */
  function extractFromForm(form) {
    if (!form) return "";
    try {
      // Google's search box is name="q"; otherwise take the first text field.
      const named = form.querySelector(
        'input[name="q"], textarea[name="q"]'
      );
      if (named) return extractText(named);
      const field = form.querySelector(
        'input[type="search"], input[type="text"], textarea, [contenteditable="true"]'
      );
      return extractText(field);
    } catch (_) {
      return "";
    }
  }

  // ---- Two-tier evaluation entrypoint -------------------------------------

  // Queries currently awaiting a cloud verdict. The 500ms URL poll and the
  // Enter handler both funnel through evaluateQuery(), so without this a single
  // search can fire two identical /intent calls.
  const intentInFlight = new Set();

  /**
   * Ask the service worker whether a query is health-related.
   *
   * Resolves a TRI-STATE (Fix_16) so the two callers can differ on failure:
   *   "yes"         the model confirmed it
   *   "no"          the model declined it
   *   "unavailable" we could not ask (messaging error, timeout, cap, non-200)
   *   "duplicate"   an identical query is already awaiting a verdict
   *
   * "duplicate" is separate from "unavailable" on purpose. Both callers must
   * DROP a duplicate — the in-flight call will open the drawer if it should —
   * whereas the hit path OPENS on "unavailable". Folding the two together would
   * make the 500ms URL poll and the Enter handler both open the drawer for one
   * search.
   *
   * @param {string} query
   * @returns {Promise<"yes"|"no"|"unavailable"|"duplicate">}
   */
  function checkCloudIntent(query) {
    if (intentInFlight.has(query)) return Promise.resolve("duplicate");
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      return Promise.resolve("unavailable");
    }
    intentInFlight.add(query);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "COMPANION_INTENT", payload: { query } },
          (resp) => {
            intentInFlight.delete(query);
            if (chrome.runtime.lastError) return resolve("unavailable");
            if (!resp || !resp.ok) return resolve("unavailable");
            // Tolerate a service worker that predates the tri-state: fall back
            // to the boolean, which reads as the old fail-closed behaviour.
            return resolve(resp.verdict || (resp.medical ? "yes" : "no"));
          }
        );
      } catch (_) {
        intentInFlight.delete(query);
        resolve("unavailable");
      }
    });
  }

  /**
   * Central funnel for every captured query. Dedupes rapid repeats, applies the
   * Tier 1 regex filter, then confirms via the Tier 2 on-device evaluator.
   * Tier-1 misses fall through to the weak-signal gate + cloud intent check.
   * @param {string} queryString
   */
  async function evaluateQuery(queryString) {
    const q = (queryString || "").trim();
    if (q.length < MIN_QUERY_LEN) return;

    const now = Date.now();
    if (q === lastQuery && now - lastAt < DEDUPE_WINDOW_MS) return;
    lastQuery = q;
    lastAt = now;

    // Tier 1: cheap regex root-word filter.
    if (typeof ns.isPotentialHealthQuery !== "function") return;
    if (!ns.isPotentialHealthQuery(q)) {
      // Tier 1b: no exact match — is it a misspelling of one? Runs on-device,
      // so a typo resolves without a network call (Fix_7).
      const near = typeof ns.fuzzyHealthMatch === "function" ? ns.fuzzyHealthMatch(q) : null;
      if (near) {
        console.debug(
          "[Companion] Tier 1b typo hit: " + near.token + " ~ " + near.root + ":", q
        );
        onHealthQueryConfirmed(q);
        return;
      }

      // Tier 1.5 — how much reaches the cloud depends on the host (Fix_13).
      //
      // On Google search the intercepted text is a short search query, and
      // recall matters more than the privacy of that query: every miss is sent.
      // On ChatGPT/Gemini it is the user's full prompt to another assistant, so
      // the weak-signal gate still applies. Structural rejects (length, URL,
      // code) hold on BOTH paths.
      if (typeof ns.isSendableText !== "function" || !ns.isSendableText(q)) {
        console.debug("[Companion] Tier 1 miss, not sendable (local drop):", q);
        return;
      }
      const sendAll =
        typeof ns.sendsEveryMiss === "function" && ns.sendsEveryMiss(location.hostname);
      if (!sendAll) {
        if (typeof ns.hasWeakHealthSignal !== "function" || !ns.hasWeakHealthSignal(q)) {
          console.debug("[Companion] Tier 1 miss, no weak signal (local drop):", q);
          return;
        }
      }
      console.debug(
        `[Companion] Tier 1.5 asking backend (${sendAll ? "search host: all misses" : "weak signal"}):`,
        q
      );
      const verdict = await checkCloudIntent(q);
      console.debug("[Companion] Tier 1.5 verdict:", verdict);
      // Fail CLOSED. A Tier-1 miss carries no evidence of its own, so anything
      // short of an explicit yes — including "we couldn't ask" — stays quiet.
      // Do NOT relax this to match the hit path below; the asymmetry is the
      // whole point (Fix_16).
      if (verdict !== "yes") return;
      onHealthQueryConfirmed(q);
      return;
    }

    // ---- Tier 1 hit ------------------------------------------------------
    // A hit used to open the drawer unconditionally, because the Tier-2
    // on-device evaluator fails open on every path and can never say no. So the
    // regex was the sole decider, and "heart of darkness summary" opened the
    // drawer. Only the ambiguous minority (~15% of the vocabulary) now pays a
    // cloud check; the other 85% opens instantly, with no network call.
    const strength =
      typeof ns.classifyHealthQuery === "function" ? ns.classifyHealthQuery(q) : "instant";

    if (strength !== "verify") {
      console.debug("[Companion] Tier 1 hit (instant):", q);
      onHealthQueryConfirmed(q);
      return;
    }

    console.debug("[Companion] Tier 1 hit, ambiguous — verifying:", q);
    const verdict = await checkCloudIntent(q);
    console.debug("[Companion] Tier 1 verify verdict:", verdict);
    // Fail OPEN: a Tier-1 hit already carries real evidence, so if Bedrock is
    // down, the hourly cap is spent, or the check times out, the drawer still
    // opens. Only an explicit "no" — or a duplicate already in flight, which
    // the other call will handle — drops the query.
    if (verdict === "no" || verdict === "duplicate") return;
    onHealthQueryConfirmed(q);
  }

  /**
   * Hook fired when a query is confirmed as health-anxiety related. The sliding
   * drawer UI is wired up in a later Epic; for now we log and dispatch an event
   * so downstream code can subscribe without editing this file.
   * @param {string} query
   */
  function onHealthQueryConfirmed(query) {
    console.log("[Companion] health-anxiety query confirmed:", query);
    try {
      window.dispatchEvent(
        new CustomEvent("companion:health-query", { detail: { query } })
      );
    } catch (_) {
      /* ignore */
    }
  }

  // ---- Capture surface 1: Enter keypress ----------------------------------

  document.addEventListener(
    "keydown",
    (event) => {
      // Plain Enter submits; Shift+Enter is a newline, so ignore it.
      if (event.key !== "Enter" || event.shiftKey) return;
      const el = event.target;
      if (!el) return;
      const tag = (el.tagName || "").toLowerCase();
      const editable =
        tag === "input" || tag === "textarea" || el.isContentEditable;
      if (!editable) return;
      evaluateQuery(extractText(el));
    },
    true // capture phase: observe before the page, never block it
  );

  // ---- Capture surface 2: form submit -------------------------------------

  document.addEventListener(
    "submit",
    (event) => {
      evaluateQuery(extractFromForm(event.target));
    },
    true
  );

  // ---- Capture surface 3: URL ?q= mutations -------------------------------

  /** Parse the `q` (or Google's legacy `query`) parameter from a URL string. */
  function queryFromUrl(url) {
    try {
      const params = new URL(url).searchParams;
      return params.get("q") || params.get("query") || "";
    } catch (_) {
      return "";
    }
  }

  let lastHref = location.href;

  function checkUrl() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const q = queryFromUrl(location.href);
    if (q) evaluateQuery(q);
  }

  // SPA route changes on Google/Gemini don't fire a full navigation. Poll the
  // URL cheaply and also react to history navigation events. (We poll because a
  // content script's isolated-world history object can't observe the page's
  // own pushState calls.)
  window.addEventListener("popstate", checkUrl);
  window.addEventListener("hashchange", checkUrl);
  setInterval(checkUrl, 500);

  // Evaluate the URL we landed on (e.g. deep-linked Google results page).
  const initialQuery = queryFromUrl(location.href);
  if (initialQuery) evaluateQuery(initialQuery);

  // Expose for manual testing from the isolated-world console.
  ns.evaluateQuery = evaluateQuery;

  console.log("[Companion] interceptor active on", location.hostname);
})();
