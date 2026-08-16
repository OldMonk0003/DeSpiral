// Companion — Tier 1.5 Weak-Signal Gate (Fix_6)
//
// Decides whether a query that MISSED the Tier-1 root list is worth asking the
// cloud about. This is the privacy boundary of the extension: the content
// script runs on chatgpt.com and gemini.google.com, where the "query" is the
// user's full prompt to another assistant. Text that fails this gate never
// leaves the browser.
//
// Deliberately weaker than Tier 1: these signals are too vague to open the
// drawer on their own ("my back", "is it normal") but strong enough to justify
// one cheap yes/no call. Keep it that way — widening this to "anything with a
// pronoun" would quietly turn the extension into a keylogger.
//
// Exposes: globalThis.Companion.hasWeakHealthSignal(text) -> boolean

(function () {
  "use strict";

  const MIN_LEN = 3;
  const MAX_LEN = 300; // don't upload a long ChatGPT prompt to classify it

  // Body parts too generic for Tier 1 (they appear in plenty of non-health
  // text) but meaningful when paired with the rest of the gate.
  const BODY_PARTS = [
    "arm", "arms", "leg", "legs", "back", "neck", "jaw", "hand", "hands",
    "foot", "feet", "knee", "knees", "hip", "hips", "shoulder", "shoulders",
    "belly", "tummy", "side", "finger", "toe", "toes", "wrist", "ankle",
    "elbow", "rib", "ribs", "tooth", "teeth", "gum", "gums", "tongue",
    "lip", "lips", "scalp", "temple", "groin", "calf", "thigh", "knuckle",
  ];

  // First-person markers + somatic verbs. Neither alone is a signal; the gate
  // fires only when both appear, so "my car feels weird" is the false positive
  // we accept and "the weather is normal today" is not a hit at all.
  const FIRST_PERSON = /\b(?:my|i|i'm|im|i've|ive|me|mine)\b/i;
  const SOMATIC = new RegExp(
    "\\b(?:feel|feels|feeling|felt|hurt|hurts|hurting|sore|ache|aching|" +
      "weird|strange|odd|wrong|worried|worry|scared|anxious|normal|" +
      "since|lately|recently|keep|keeps|constantly|suddenly)\\b",
    "i"
  );

  // Symptom-shaped question frames — these carry the signal on their own.
  const QUESTION_FRAMES = [
    /\bis (?:it|this|that) normal\b/i,
    /\bshould i (?:worry|be worried|see|call|go)\b/i,
    /\bwhat does (?:it|this|that) mean\b/i,
    /\bhow long does\b/i,
    /\bwhy do(?:es)? (?:i|my)\b/i,
    /\bcan (?:anxiety|stress) cause\b/i,
    /\bwhat causes\b/i,
    /\bis (?:it|this) serious\b/i,
    /\bam i (?:ok|okay|dying|fine)\b/i,
  ];

  // ---- Clinical modifiers (Fix_8) -----------------------------------------
  // How people search after a doctor's visit: a modifier plus a value or a bare
  // noun, with no pronoun and no body part — "elevated levels", "abnormal
  // reading", "sudden onset", "ldl 160". None of these words is medical on its
  // own; only the combination in context is, which is the judgement the cloud
  // tier makes well and a word list cannot.
  const CLINICAL_MODIFIERS =
    /\b(?:high|low|elevated|raised|normal|abnormal|levels?|readings?|counts?|results?|tests?|chronic|acute|severe|mild|sudden|persistent)\b/i;

  // "ldl 160", "a1c 6.2", "120 mg", "98 bpm" — a short token beside a number,
  // or a number with a clinical unit.
  const LAB_VALUE =
    /\b[a-z]{2,6}\s+\d+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*(?:mg|ml|mmol|mcg|bpm|%)\b/i;

  // Two guards bound how much ordinary text this new branch can send to the
  // cloud. They are privacy controls, NOT optimizations — see Fix_8 for the
  // measured cost of removing them (24% of everyday queries uploaded without
  // the veto; 36% without the token cap either).
  const MAX_MODIFIER_TOKENS = 3;

  // Domain give-aways: a modifier query mentioning any of these is about a
  // subject other than a body. A PRECISION DEVICE, NOT A BLOCKLIST — a missing
  // entry costs one wasted yes/no call, never a wrong drawer, because the
  // backend still has the final say. Do not treat it as authoritative.
  // NOTE: "temperature" is deliberately absent (fever), as is "pressure".
  const NON_MEDICAL_CONTEXT = new RegExp(
    "\\b(?:" +
      // education
      "schools?|college|university|exams?|degrees?|courses?|class(?:es)?|students?|tuition|grades?|textbooks?|psychology|" +
      // weather & nature
      "weather|tide|rain|storm|climate|forecast|humidity|" +
      // software & tech
      "database|sql|api|server|code|coding|latency|python|java|javascript|react|" +
      "node|git|docker|framework|compiler|algorithm|driven|development|deployment|" +
      "blender|render|cpu|gpu|ram|disk|bandwidth|throughput|query|cache|thread|" +
      "excel|formula|spreadsheet|software|app|website|browser|" +
      // finance
      "stocks?|market|price|salary|tax|loan|mortgage|interest|invest|crypto|budget|" +
      "income|revenue|profit|refund|" +
      // food & drink  (plural forms matter: "low fat recipes" must be vetoed)
      "recipes?|restaurants?|pizza|cooking|menus?|dish(?:es)?|coffee|" +
      // entertainment & sport
      // "episode" is deliberately NOT vetoed: paired with a clinical modifier
      // ("severe episode", "acute episode") it is medical far more often than
      // televisual, and a TV search rarely carries a modifier.
      "movies?|films?|songs?|albums?|games?|match(?:es)?|cups?|leagues?|seasons?|series|netflix|" +
      "tournament|score|player|team|" +
      // travel
      "hotels?|flights?|tickets?|visas?|resorts?|beach(?:es)?|trips?|bookings?|airports?|" +
      // products & shopping
      "laptops?|phones?|headphones?|cameras?|brands?|deals?|discounts?|warranty|" +
      // work
      "interviews?|resumes?|meetings?|projects?|deadlines?|managers?|clients?|design|marketing|jobs?|" +
      // maths & stats
      "distribution|angle|equation|matrix|probability|variance|function|integral" +
      ")\\b",
    "i"
  );

  const BODY_PATTERN = new RegExp("\\b(?:" + BODY_PARTS.join("|") + ")\\b", "i");

  // Text that is clearly not a health question — cheap structural rejects.
  const LOOKS_LIKE_URL = /^\s*https?:\/\//i;
  const LOOKS_LIKE_CODE = /[{}]|=>|;\s*$|\b(?:function|const|import|def|class|SELECT)\b/;

  /**
   * Structural rejects that apply on EVERY path, gated or not (Fix_13): too
   * short, too long to be a search, a URL, or code. These cost nothing and stop
   * junk being uploaded — they are the floor even where the weak-signal gate is
   * skipped.
   * @param {string} text
   * @returns {boolean} true if the text may be sent to the intent check at all.
   */
  function isSendableText(text) {
    if (!text || typeof text !== "string") return false;
    const t = text.trim();
    if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
    if (LOOKS_LIKE_URL.test(t) || LOOKS_LIKE_CODE.test(t)) return false;
    return true;
  }

  /**
   * Does this host send EVERY Tier-1 miss to the intent check (Fix_13)?
   *
   * Google search only. On ChatGPT and Gemini the intercepted text is the
   * user's full prompt to another assistant, not a short search query, so the
   * weak-signal gate still applies there.
   *
   * gemini.google.com is a SUBDOMAIN of google.com — it must be excluded before
   * the google.com test, or Gemini silently falls into the send-everything path,
   * which is exactly what this split exists to prevent.
   *
   * @param {string} hostname
   * @returns {boolean}
   */
  function sendsEveryMiss(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (/(^|\.)gemini\.google\.com$/.test(host)) return false;
    if (/(^|\.)chatgpt\.com$/.test(host)) return false;
    // Any Google search ccTLD — google.com, google.co.in, google.com.au, …
    // The manifest has to enumerate these (Chrome match patterns cannot
    // wildcard a TLD), but the routing predicate must accept all of them or a
    // judge outside the US silently gets the gated path.
    // The leading (^|\.) stops "notgoogle.com"; the trailing $ stops
    // "evilgoogle.com.attacker.net".
    return /(^|\.)google(\.[a-z]{2,3}){1,2}$/.test(host);
  }

  /**
   * @param {string} text - a query that already failed the Tier-1 root filter.
   * @returns {boolean} true if it's worth spending a cloud intent check on.
   */
  function hasWeakHealthSignal(text) {
    if (!isSendableText(text)) return false;
    const t = text.trim();

    // Cheapest checks first — this runs on every Tier-1 miss.
    for (const frame of QUESTION_FRAMES) {
      if (frame.test(t)) return true;
    }
    if (BODY_PATTERN.test(t)) return true;
    if (FIRST_PERSON.test(t) && SOMATIC.test(t)) return true;

    // Clinical-modifier branch last: it alone needs a token count and two extra
    // regexes, and it is the widest trigger, so it should only be reached once
    // every cheaper signal has declined.
    if (CLINICAL_MODIFIERS.test(t) || LAB_VALUE.test(t)) {
      if (t.split(/\s+/).length > MAX_MODIFIER_TOKENS) return false;
      if (NON_MEDICAL_CONTEXT.test(t)) return false;
      return true;
    }
    return false;
  }

  const ns = (globalThis.Companion = globalThis.Companion || {});
  ns.hasWeakHealthSignal = hasWeakHealthSignal;
  ns.isSendableText = isSendableText;
  ns.sendsEveryMiss = sendsEveryMiss;
  ns.WEAK_BODY_PARTS = BODY_PARTS;
})();
