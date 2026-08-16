// Companion — Tier 1b Fuzzy Matcher (Fix_7)
//
// Catches misspellings of LONG health stems that the exact Tier-1 filter misses.
// Runs entirely on-device: no network call, no cost, no privacy surface.
//
// ---------------------------------------------------------------------------
// TUNING — measured against the real HEALTH_ROOTS. Do not loosen without
// re-running extension/utils/__tests__/filters.test.js:
//
//   min stem length | typos caught | false positives
//   ----------------|--------------|-----------------
//         6         |     6/8      | "dancer" ~ cancer
//         7         |     5/8      | none              <- chosen
//         8         |     5/8      | none
//
// At distance 1 the SHORT stems are catastrophic: "tingl" matches testing /
// hosting / meeting, "colon" matches colors, "heart" matches heard, "cancer"
// matches dancer. That is why the floor is 7 and the distance is 1. The typos
// this leaves behind (e.g. "brthing" -> "breath" costs 2 edits) are handled by
// the explicit HEALTH_TYPOS alias list in regex-filter.js instead.
//
// HEALTH_WORDS is never fuzzy-matched. Fix_6 put those terms in a whole-word
// list precisely because they collide with ordinary English as prefixes
// (ear/early, pain/painting, numb/number); fuzzy matching would reintroduce
// every one of those collisions by another door.
// ---------------------------------------------------------------------------
//
// Exposes: globalThis.Companion.fuzzyHealthMatch(text) -> {token, root} | null
//          globalThis.Companion.isFuzzyHealthQuery(text) -> boolean

(function () {
  "use strict";

  const ns = (globalThis.Companion = globalThis.Companion || {});

  const MIN_ROOT_LEN = 7;
  const MIN_TOKEN_LEN = 6;
  const MAX_DIST = 1;
  const MAX_CHARS = 120;
  const MAX_TOKENS = 12;

  // Common words that land within MAX_DIST of a real stem. Checked before any
  // distance is computed. Every entry is asserted in the test corpus — if you
  // remove one, the suite must go red.
  const FUZZY_STOPWORDS = new Set([
    "spelling", "smelling", "selling", "telling", "swimming", "dwelling",
    "shelling", "welling", "yelling",
  ]);

  // Long stems only; multi-word entries ("weight loss") are not tokenizable.
  const FUZZY_ROOTS = (ns.HEALTH_ROOTS || []).filter(
    (r) => r.length >= MIN_ROOT_LEN && r.indexOf(" ") === -1
  );

  /**
   * Prefix-anchored edit distance: the cost of turning some PREFIX of `token`
   * into `root`, leaving the token's trailing characters free. This mirrors
   * Tier 1's `\b(?:root)` prefix semantics — the stems are prefixes, so a plain
   * token-vs-stem Levenshtein would score "breathing" as far from "breath".
   *
   * Returns a value > max as soon as the bound is exceeded (early bail).
   * @returns {number}
   */
  function prefixDistance(root, token, max) {
    const m = root.length;
    const n = token.length;
    if (n < m - max) return max + 1;

    // Row 0: matching zero root characters costs nothing at any token offset,
    // which is what makes the token's leading offset free... but we anchor at
    // the token start, so only the TRAILING characters are free (via the final
    // row minimum below).
    let prev = new Array(n + 1).fill(0);
    let cur;
    for (let i = 1; i <= m; i++) {
      cur = new Array(n + 1);
      cur[0] = i;
      let best = i;
      for (let j = 1; j <= n; j++) {
        const cost = root[i - 1] === token[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1; // whole row over budget — give up
      prev = cur;
    }
    let min = prev[0];
    for (let j = 1; j <= n; j++) if (prev[j] < min) min = prev[j];
    return min;
  }

  /**
   * @param {string} text - a query that already failed the exact Tier-1 filter.
   * @returns {{token: string, root: string}|null} the first near-miss found.
   */
  function fuzzyHealthMatch(text) {
    if (!text || typeof text !== "string") return null;
    if (text.length > MAX_CHARS) return null;

    const tokens = text.toLowerCase().split(/[^a-z]+/);
    if (tokens.length > MAX_TOKENS) return null;

    for (const token of tokens) {
      if (token.length < MIN_TOKEN_LEN) continue;
      if (FUZZY_STOPWORDS.has(token)) continue;
      for (const root of FUZZY_ROOTS) {
        if (prefixDistance(root, token, MAX_DIST) <= MAX_DIST) {
          return { token, root };
        }
      }
    }
    return null;
  }

  function isFuzzyHealthQuery(text) {
    return !!fuzzyHealthMatch(text);
  }

  ns.fuzzyHealthMatch = fuzzyHealthMatch;
  ns.isFuzzyHealthQuery = isFuzzyHealthQuery;
  ns.FUZZY_STOPWORDS = FUZZY_STOPWORDS;
})();
