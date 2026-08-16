// Companion — Emergency query detection (Fix_9)
//
// Queries where a 20-second grounding lock is actively dangerous. When this
// matches, the interstitial is skipped ENTIRELY — not "skippable", skipped.
//
// Rationale: a skip button assumes a calm user who reads UI. Someone searching
// "choking" is not that user. The app should not have interposed itself at all.
//
// Tuned to fire on ACUTE presentation, not research. "chest pain radiating to
// arm" bypasses; "chest pain causes" does not. "choking" bypasses; "choking
// hazard toys" does not. Research-mode queries should get the pause like any
// other health search — the whole point of the feature.
//
// Exposes: globalThis.Companion.isEmergencyQuery(text) -> boolean

(function () {
  "use strict";

  const EMERGENCY_PATTERNS = [
    // --- airway / breathing ---
    // "choking" alone, but not product-safety reading ("choking hazard").
    /\bchoking\b(?!\s+hazard)/i,
    /\b(?:can'?t|cannot|couldn'?t)\s+breathe\b/i,
    /\bstopped\s+breathing\b/i,
    /\bnot\s+breathing\b/i,
    /\bgasping\b/i,
    /\bstruggling\s+to\s+breathe\b/i,

    // --- cardiac / stroke ---
    // Chest pain only counts as acute when it carries a radiation descriptor;
    // bare "chest pain" is the single most common anxious research query.
    /\bchest\s+pain\b[^.]{0,40}\b(?:arm|jaw|radiat\w*|shoulder|neck)\b/i,
    /\b(?:arm|jaw|radiat\w*)\b[^.]{0,40}\bchest\s+pain\b/i,
    /\bheart\s+attack\b/i,
    /\bstroke\s+symptoms\b/i,
    /\bhaving\s+a\s+stroke\b/i,
    /\bface\s+drooping\b/i,
    /\bslurred\s+speech\b/i,

    // --- bleeding / trauma ---
    /\bbleeding\s+heavily\b/i,
    /\bheavy\s+bleeding\b/i,
    /\b(?:won'?t|wont|can'?t)\s+stop\s+bleeding\b/i,
    /\bdeep\s+cut\b/i,

    // --- allergic ---
    /\banaphyla\w*/i,
    /\bthroat\s+closing\b/i,
    /\bswollen\s+tongue\b/i,

    // --- poisoning / overdose ---
    /\boverdose[ds]?\b/i,
    /\bpoisoning\b/i,
    /\bswallowed\b/i,

    // --- self-harm ---
    // Present here ONLY to bypass the interstitial. Crisis resourcing is a
    // separate, unbuilt concern — do not graft it on here.
    /\bsuicidal\b/i,
    /\bkill\s+myself\b/i,
    /\bwant\s+to\s+die\b/i,
    /\bend\s+my\s+life\b/i,
    /\bhurt\s+myself\b/i,
  ];

  /**
   * @param {string} text - the confirmed health query.
   * @returns {boolean} true if the grounding pause must be skipped entirely.
   */
  function isEmergencyQuery(text) {
    if (!text || typeof text !== "string") return false;
    for (const pattern of EMERGENCY_PATTERNS) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  const ns = (globalThis.Companion = globalThis.Companion || {});
  ns.isEmergencyQuery = isEmergencyQuery;
  ns.EMERGENCY_PATTERNS = EMERGENCY_PATTERNS;
})();
