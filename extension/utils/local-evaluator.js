// Companion — Tier 2 On-Device Intent Evaluator (Task A2.3)
//
// Confirms health-anxiety intent for queries that passed the Tier 1 regex
// filter, using Chrome's built-in Prompt API (Gemini Nano, on-device) when it
// is available and ready. If the built-in model is missing, disabled, still
// downloading, or errors for any reason, we FAIL OPEN (return true) so the
// companion still surfaces — we would rather occasionally over-trigger than
// silently miss someone in a spiral.
//
// Exposes: globalThis.Companion.evaluateHealthIntent(query) -> Promise<boolean>

(function () {
  "use strict";

  // Cap prompt latency so we never hang the interception pipeline.
  const EVAL_TIMEOUT_MS = 4000;

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("evaluator timeout")), ms)
      ),
    ]);
  }

  /**
   * Resolve a usable on-device model session across API generations, or null
   * if the model is not READY right now (unavailable / downloadable /
   * downloading all count as "not ready" — we fall back rather than wait).
   * @returns {Promise<object|null>}
   */
  async function acquireSession() {
    // Current API (Chrome 138+): global `LanguageModel`.
    try {
      if (typeof LanguageModel !== "undefined" && LanguageModel.create) {
        if (typeof LanguageModel.availability === "function") {
          const state = await LanguageModel.availability();
          if (state !== "available") return null; // downloadable/downloading/unavailable
        }
        return await LanguageModel.create();
      }
    } catch (_) {
      /* fall through */
    }

    // Legacy API: `window.ai.languageModel` with capabilities().
    const ai =
      (typeof self !== "undefined" && self.ai) ||
      (typeof window !== "undefined" && window.ai) ||
      null;
    try {
      if (ai && ai.languageModel && ai.languageModel.create) {
        if (typeof ai.languageModel.capabilities === "function") {
          const caps = await ai.languageModel.capabilities();
          if (caps && caps.available && caps.available !== "readily") return null;
        }
        return await ai.languageModel.create();
      }
    } catch (_) {
      /* fall through */
    }

    // Oldest API: canCreateTextSession() / createTextSession().
    try {
      if (ai && ai.canCreateTextSession && ai.createTextSession) {
        const status = await ai.canCreateTextSession();
        if (status !== "readily") return null;
        return await ai.createTextSession();
      }
    } catch (_) {
      /* fall through */
    }

    return null;
  }

  /**
   * @param {string} query - the user's search text.
   * @returns {Promise<boolean>} true if the query reads as medical-symptom /
   *   health-anxiety related, or if the on-device model is unavailable.
   */
  async function evaluateHealthIntent(query) {
    let session = null;
    try {
      session = await acquireSession();
      if (!session) return true; // fail open: no ready on-device model

      const prompt =
        "Is the following query related to a medical symptom or health " +
        "anxiety? Answer YES or NO: " +
        query;

      const output = String(await withTimeout(session.prompt(prompt), EVAL_TIMEOUT_MS));
      // Fail open: only suppress when the model gives a clear, unqualified NO.
      // An empty/hedged/verbose answer should still surface the companion.
      const saysNo = /\bno\b/i.test(output) && !/\byes\b/i.test(output);
      return !saysNo;
    } catch (_) {
      return true; // fail open on any error/timeout
    } finally {
      try {
        if (session && typeof session.destroy === "function") session.destroy();
      } catch (_) {
        /* ignore */
      }
    }
  }

  const ns = (globalThis.Companion = globalThis.Companion || {});
  ns.evaluateHealthIntent = evaluateHealthIntent;
})();
