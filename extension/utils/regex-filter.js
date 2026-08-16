// Companion — Tier 1 Regex & Root Word Filter (Task A2.2, expanded in Fix_6)
//
// Fast, zero-cost pre-filter. Runs on every captured query. Deliberately BROAD:
// false positives are cheap because the drawer is calm and dismissible, while a
// false negative means someone in a spiral never gets intercepted.
//
// Two lists, because prefix matching is unsafe for some terms:
//   HEALTH_ROOTS — matched as a PREFIX at a word start: "breath" also catches
//                  breathe / breathing / breathless.
//   HEALTH_WORDS — matched as a WHOLE WORD: "ear" must not fire on "early",
//                  "alt" must not fire on "although", "mole" not on "molecule".
// When adding a term, ask: does any common non-health word START with it? If so
// it belongs in HEALTH_WORDS (list each inflection you need).
//
// Exposes: globalThis.Companion.isPotentialHealthQuery(text) -> boolean
//          globalThis.Companion.HEALTH_ROOTS / HEALTH_WORDS (the term lists)

(function () {
  "use strict";

  // Prefix-matched roots — safe because no common word begins with them.
  const HEALTH_ROOTS = [
    // Anatomy & general symptoms
    "bloodwork", "blood", "lump", "ache", "swelling", "swollen", "swell",
    "chest", "stomach", "abdomen", "abdominal", "liver", "kidney", "heart",
    "cardiac", "lung", "brain", "throat", "breast", "lymph", "gland",
    "bowel", "colon", "bone", "nerve", "headache", "migraine", "joint",
    "muscle", "spine", "spinal",
    // Clinical tests, labs & imaging
    "ultrasound", "biopsy", "xray", "endoscopy", "colonoscopy", "mammogram",
    "enzyme", "hemoglobin", "platelet", "creatinine", "bilirubin", "glucose",
    "cholesterol", "bloodtest",
    // Conditions & fear-driven terms
    "tumor", "tumour", "cancer", "carcinoma", "nodule", "cyst", "lesion",
    "benign", "malignant", "metasta", "inflammation", "infection", "stroke",
    "seizure", "palpitation", "dizz", "tingl", "fatigu", "nausea", "fever",
    "rash", "bleed", "diagnosis", "symptom", "ulcer", "reflux", "heartburn",
    "diarrhea", "constipat", "vomit", "thyroid", "prostate", "gallbladder",
    "anemia", "anaemia",
    // Labs, panels and biochemistry (Fix_13) — these were reaching the cloud
    // intent check or being dropped entirely; they are plain vocabulary and
    // belong here, where matching is free.
    "lipid", "triglycerid", "vitamin", "hormone", "insulin", "sodium",
    "potassium", "urine", "urinar", "sperm", "menstrua", "ovar", "uter",
    "testic",
    // Respiratory  (new in Fix_6 — "breath" covers breathe/breathing/breathless)
    "breath", "wheez", "cough", "asthma", "inhaler", "suffocat", "chok",
    "phlegm", "mucus", "sputum", "pneumon", "bronch",
    // ENT  (new)
    "nose", "nasal", "sinus", "tonsil", "swallow", "hoarse", "vertigo",
    "tinnitus", "earache",
    // Skin & hair  (new)
    "skin", "itch", "hives", "eczema", "psoriasis", "acne", "bruis",
    "blister", "freckle", "pigment", "hair", "nail", "wart",
    // Eyes  (new)
    "vision", "eyesight", "eye", "blurry", "floaters", "pupil",
    // Constitutional  (new)
    "tired", "weakness", "sweat", "chills", "appetite", "insomnia",
    "sleepless", "weight loss", "tremor", "cramp", "spasm", "night sweat",
    // Lay phrasing  (new)
    "sick", "illness", "disease", "doctor", "hospital", "emergency",
    "urgent care", "sore", "hurt", "unwell",
  ];

  // Whole-word terms — each would produce false positives as a prefix.
  // The guarded word is noted so nobody "simplifies" these back into roots.
  const HEALTH_WORDS = [
    "alt", "alts",                  // although, alternative, alter
    "ast",                          // aster, astronaut, astute
    "wbc", "rbc", "cbc", "mri", "ecg", "ekg", "tsh", "psa", "crp", "esr", "a1c",
    "scan", "scans",                // (kept tight; "scanner" is not health)
    "pain", "pains", "painful",     // paint, painting, painter
    "mass", "masses",               // massage, massive
    "mole", "moles",                // molecule, molecular
    "node", "nodes",                // nodejs, nodemon
    "clot", "clots", "clotting",    // cloth, clothes, clothing
    "numb", "numbness", "numbing",  // number, numbers
    "ill",                          // illustration, illegal, illinois
    "exhausted", "exhaustion",      // exhaust (car part)
    "twitching", "twitches",        // Twitch (streaming)
    "snore", "snoring", "snores",   // snorkel
    "ear", "ears",                  // early, earn, earth, earlier
    "pulse",                        // (whole-word; avoids "pulses" as grain)
    "racing",                       // only meaningful as "heart racing"
    // Clinical abbreviations (Fix_7 follow-up). Fuzzy matching can never reach
    // these — it skips tokens under 6 chars, because a 2-char token sits within
    // edit distance 1 of almost every stem. Whole-word only, obviously.
    // Deliberately EXCLUDED as too ambiguous for an exact hit: "hr" (human
    // resources), "sob" (sob story), "gi" (GI Joe/bill), "ct" (Connecticut),
    // "bun" (bread). Those belong to the cloud tier, not this list.
    "bp", "afib", "gerd", "ibs", "copd", "dvt", "pcos", "uti", "utis",
    // Fix_13 lab shorthand. Deliberately EXCLUDED as too collision-prone:
    //   "t3"/"t4" (AWS instance types), "d3" (D3.js, Diablo), "stool" (bar or
    //   step stool), "fertil*" (fertilizer), and — measured, not assumed —
    //   "calcium", "deficiency", "fertile", "fertility", which collide as WHOLE
    //   WORDS ("calcium in plant soil", "deficiency judgment law", "fertile
    //   soil", "soil fertility index"), so the two-list split cannot save them.
    // Nothing is lost: the health phrasings are already carried by other terms
    // ("symptom", "vitamin", "levels"), and on Google every miss now reaches the
    // intent check anyway (Fix_13), where the model judges context far better
    // than a word list can.
    "hba1c", "pth", "b12",
    "ldl", "hdl", "bmi", "egfr", "inr", "ecg", "copd",
  ];

  // Misspellings the fuzzy matcher (Fix_7) cannot reach. It only handles stems
  // of length >= 7 at edit distance 1, so typos of SHORT stems land here:
  // "brthing" is two edits from the stem "breath", and allowing distance 2 on
  // short stems is what makes "dancer" match "cancer".
  //
  // Every entry below was verified to be missed by BOTH the exact patterns and
  // the fuzzy matcher — do not add an alias that is already covered, it implies
  // coverage the list isn't providing. None of these is a real English word, so
  // whole-word matching makes them zero-false-positive.
  const HEALTH_TYPOS = [
    "brthing", "brething", "breatless", "shortnes",   // breath
    "naseau", "nausious", "nauseus", "nausia",        // nausea
    "kidny", "livr", "tumer", "canser",               // kidney/liver/tumor/cancer
    "lymfoma", "fatiuge", "excema",                   // lymphoma/fatigue/eczema
  ];

  const ROOT_PATTERN = new RegExp("\\b(?:" + HEALTH_ROOTS.join("|") + ")", "i");
  const WORD_PATTERN = new RegExp(
    "\\b(?:" + HEALTH_WORDS.concat(HEALTH_TYPOS).join("|") + ")\\b", "i"
  );

  /**
   * @param {string} text - the raw query string.
   * @returns {boolean} true if any health root or whole-word term is present.
   */
  function isPotentialHealthQuery(text) {
    if (!text || typeof text !== "string") return false;
    return ROOT_PATTERN.test(text) || WORD_PATTERN.test(text);
  }

  // ---- Ambiguity split (Fix_16) --------------------------------------------
  //
  // A Tier-1 hit used to open the drawer with no verification, because Tier 2
  // (local-evaluator.js) is inert and fails open. Measured against a 60-query
  // everyday corpus, 42 of 60 opened the drawer: "liverpool fc fixtures"
  // (liver), "node js tutorial" (node), "doctor who season 14" (doctor).
  //
  // These 35 terms are the ones that fired on at least one everyday query.
  // DERIVED FROM MEASURED COLLISIONS, not intuition — a term belongs here only
  // once a corpus shows it firing on ordinary text. The cost of adding one is a
  // single Haiku call, never a wrong drawer, so err towards adding when a
  // held-out corpus shows a leak.
  //
  // Every entry must exist in one of the lists above, spelled identically; the
  // test suite asserts that, because a typo here is a silent no-op.
  const AMBIGUOUS_TERMS = new Set([
    "eye", "hair", "blood", "heart", "skin", "bone", "spine", "chest", "node",
    "mass", "mole", "sweat", "nose", "tired", "doctor", "hospital", "emergency",
    "sick", "disease", "liver", "kidney", "brain", "lung", "throat", "nail",
    "wart", "pupil", "vision", "muscle", "joint", "cramp", "sore", "hurt",
    "swelling", "swell",
    // Plurals of the three ambiguous HEALTH_WORDS entries. HEALTH_ROOTS needs
    // no such duplication — a root is prefix-matched, so "eyes" resolves to the
    // root "eye" and inherits its classification. Whole-word terms list each
    // inflection separately, so the plural must be marked separately too, or
    // "kubernetes nodes", "moles in the garden" and "masses of people" open the
    // drawer unverified while their singulars do not. Measured, not assumed.
    "masses", "moles", "nodes",
  ]);

  // Longest term first. Alternation is FIRST-alternative-wins, not
  // longest-wins, so with source order "blood" shadows "bloodtest" and "heart"
  // shadows "heartburn" — "heartburn remedies" would report the ambiguous
  // "heart" and pay a needless round trip. Sorting by descending length makes
  // each position resolve to the longest term that actually matches there, so a
  // term is always classified as itself.
  //
  // This ordering is for CLASSIFICATION only. isPotentialHealthQuery above is a
  // boolean test, where alternation order cannot change the answer, and its
  // patterns are deliberately left alone.
  const byLongest = (list) => list.slice().sort((a, b) => b.length - a.length);

  const CLASSIFY_ROOTS = new RegExp(
    "\\b(?:" + byLongest(HEALTH_ROOTS).join("|") + ")", "ig"
  );
  const CLASSIFY_WORDS = new RegExp(
    "\\b(?:" + byLongest(HEALTH_WORDS.concat(HEALTH_TYPOS)).join("|") + ")\\b", "ig"
  );

  /** Every vocabulary term present in `text`, lowercased. */
  function matchedHealthTerms(text) {
    const found = [];
    // matchAll() iterates an internal clone, so these shared /g patterns never
    // carry lastIndex state between calls.
    for (const match of text.matchAll(CLASSIFY_ROOTS)) found.push(match[0].toLowerCase());
    for (const match of text.matchAll(CLASSIFY_WORDS)) found.push(match[0].toLowerCase());
    return found;
  }

  /**
   * How much confidence does this Tier-1 match carry?
   *
   *   "none"    nothing matched — the caller falls through to the miss path.
   *   "instant" at least one matched term is unambiguous: open with no network.
   *   "verify"  every matched term is ambiguous: worth one yes/no cloud check.
   *
   * The rule is "verify only when EVERY term is ambiguous" (V2), not "when ANY
   * term is" (V1). Measured over 60 health queries and 43 colliding everyday
   * ones, both leak 0 everyday queries, but V2 keeps 50/60 health searches
   * instant against V1's 42/60 — because a second, unambiguous term is usually
   * already present ("chest pain": chest is ambiguous, pain is not).
   *
   * @param {string} text
   * @returns {"none"|"instant"|"verify"}
   */
  function classifyHealthQuery(text) {
    if (!text || typeof text !== "string") return "none";
    const terms = matchedHealthTerms(text);
    if (!terms.length) return "none";
    return terms.some((t) => !AMBIGUOUS_TERMS.has(t)) ? "instant" : "verify";
  }

  const ns = (globalThis.Companion = globalThis.Companion || {});
  ns.isPotentialHealthQuery = isPotentialHealthQuery;
  ns.classifyHealthQuery = classifyHealthQuery;
  ns.matchedHealthTerms = matchedHealthTerms;
  ns.AMBIGUOUS_TERMS = AMBIGUOUS_TERMS;
  ns.HEALTH_ROOTS = HEALTH_ROOTS;
  ns.HEALTH_WORDS = HEALTH_WORDS;
  ns.HEALTH_TYPOS = HEALTH_TYPOS;
})();
