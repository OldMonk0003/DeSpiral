// Companion — Tier 1 + weak-signal gate regression tests (Fix_6)
//
//   node extension/utils/__tests__/filters.test.js
//
// No framework: plain node, exits non-zero on any mismatch. The false-positive
// corpora are load-bearing — they guard the prefix traps that forced the
// HEALTH_WORDS split ("early" vs "ear", "illustration" vs "ill"), and the
// privacy boundary of the weak-signal gate.

globalThis.Companion = {};
require("../regex-filter.js");
require("../fuzzy-match.js"); // must load after regex-filter (reads HEALTH_ROOTS)
require("../weak-signals.js");

const {
  isPotentialHealthQuery,
  hasWeakHealthSignal,
  isFuzzyHealthQuery,
  isSendableText,
  sendsEveryMiss,
  classifyHealthQuery,
  matchedHealthTerms,
  AMBIGUOUS_TERMS,
  HEALTH_ROOTS,
  HEALTH_WORDS,
  HEALTH_TYPOS,
} = globalThis.Companion;

// Tier 1 + Tier 1b combined — what content.js actually opens the drawer on
// without any network call.
const opensLocally = (q) => isPotentialHealthQuery(q) || isFuzzyHealthQuery(q);

let failures = 0;
let checks = 0;
function expect(fn, input, want, label) {
  const got = fn(input);
  if (got !== want) {
    failures++;
    console.error(`  FAIL [${label}] ${JSON.stringify(input)} -> ${got}, want ${want}`);
  }
}

// ---- Tier 1: must HIT -------------------------------------------------------
const TIER1_HIT = [
  // the Fix_6 problem statement, verbatim
  "Breathing Trouble", "shortness of breath", "hard to breathe",
  "i cant breathe properly", "wheezing at night", "persistent cough",
  "coughing up phlegm", "my nose is runny", "trouble swallowing",
  "weird mole on my back", "itchy skin patches", "hair falling out",
  "blurry vision", "ringing in my ears", "always tired lately",
  "night sweats", "unexplained weight loss",
  // inflection fixes
  "feeling dizzy", "dizziness spells", "numb hands", "numbness in hands",
  "my leg tingles", "tingling leg",
  // pre-existing behavior must not regress
  "high blood pressure", "lump under armpit", "chest pain",
  "liver enzymes high", "sore throat", "biopsy results",
  "what does elevated ALT mean", "is a lump under the armpit lymphoma",
  "swollen lymph nodes", "blood clot in leg", "should i see a doctor",
  "i feel sick", "is this a disease", "sharp cramp",
];
for (const q of TIER1_HIT) expect(isPotentialHealthQuery, q, true, "tier1-hit");

// ---- Tier 1: must MISS (prefix traps + ordinary browsing) -------------------
const TIER1_MISS = [
  "birthday gift for mom", "best pizza near me", "flight to delhi",
  "python list comprehension", "how to rename a git branch",
  // prefix traps that motivated HEALTH_WORDS
  "early meeting tomorrow",        // ear
  "earn money online",             // ear
  "illustration software",         // ill
  "although it was raining",       // alt
  "molecular biology degree",      // mole
  "nodejs install guide",          // node
  "clothes shopping online",       // clot
  "phone number lookup",           // numb
  "paint colors for bedroom",      // pain
  "massage near me",               // mass
  "twitch streamers 2026",         // twitch
  "car exhaust replacement",       // exhaust
  "snorkeling in goa",             // snore
  "astronaut training",            // ast
  "alternative rock playlist",     // alt
];
for (const q of TIER1_MISS) expect(isPotentialHealthQuery, q, false, "tier1-miss");

// ---- Weak-signal gate: must OPEN (worth one cloud check) -------------------
const GATE_OPEN = [
  "is it normal to feel this way after eating",
  "why do i feel weird when i stand up",
  "should i worry about this",
  "what does it mean if it comes and goes",
  "my back has been bothering me",
  "can anxiety cause this",
  "am i dying",
  "i feel strange lately",
];
for (const q of GATE_OPEN) expect(hasWeakHealthSignal, q, true, "gate-open");

// ---- Weak-signal gate: must STAY SHUT (never leaves the browser) ----------
const GATE_SHUT = [
  "birthday gift for mom",
  "refactor this function for me",
  "best restaurants in mumbai",
  "write a cover letter for a marketing role",
  "https://example.com/some/page",
  "const x = () => { return 1; }",
  "SELECT * FROM users WHERE id = 1",
  "a".repeat(400),                       // over the 300-char upload cap
  "hi",                                  // under the min length
];
for (const q of GATE_SHUT) expect(hasWeakHealthSignal, q, false, "gate-shut");

// ---- Tier 1b: typos must open the drawer with NO network call --------------
const TYPO_HIT = [
  "brthing issue", "brthing issues", "breatless", "shortnes of breth",
  "hedache", "headche", "migrane", "naseau", "nausious",
  "palpitatons", "abdomnal pain", "ultrsound results", "infecton",
  "symtoms of flu", "kidny stones", "livr problem", "canser risk",
  "lymfoma symtoms", "fatiuge all the time", "excema on hands",
  "diarhea for days", "vertgo when standing", "tinitus in one ear",
];
for (const q of TYPO_HIT) expect(opensLocally, q, true, "typo-hit");

// ---- Tier 1b: measured false positives must STAY silent --------------------
// Every entry here was an observed fuzzy collision during tuning. Removing a
// stop-list entry or lowering MIN_ROOT_LEN must make this section fail.
const TYPO_MISS = [
  "i heard that song", "dancer costume ideas", "team meeting notes",
  "spelling bee words", "smelling salts wiki", "hosting a dinner party",
  "testing framework comparison", "paint colors for bedroom",
  "nodejs install guide", "phone number lookup", "clothes shopping online",
  "flight tickets delhi", "mother of the bride", "learned a new skill",
  "selling my old laptop", "telling a good story",
];
for (const q of TYPO_MISS) expect(opensLocally, q, false, "typo-miss");

// ---- These were never broken: they must resolve at Tier 1, not Tier 1b -----
// Guards against "fixing" cases the stem matcher already handles.
const ALREADY_EXACT = [
  "breathin problem", "coughin blood", "dizzness", "swolen glands",
  "chest tightnes", "hraet racing", "stomac pain", "stomache ache",
  "wheezng at night", "throath pain",
];
for (const q of ALREADY_EXACT) expect(isPotentialHealthQuery, q, true, "already-exact");

// ---- Clinical abbreviations (exact, whole-word) ----------------------------
const ABBREV_HIT = [
  "high bp", "bp high", "my bp is high", "afib symptoms", "high ldl",
  "bmi calculator", "uti", "gerd diet", "copd stages", "dvt risk",
];
for (const q of ABBREV_HIT) expect(isPotentialHealthQuery, q, true, "abbrev-hit");

// Ambiguous abbreviations deliberately left OUT of the exact list — they are
// the cloud tier's job. If someone adds "hr"/"sob"/"gi"/"ct"/"bun", this fails.
const ABBREV_MISS = [
  "hr business partner", "sob story meaning", "gi joe movie",
  "ct real estate", "bun recipe", "high school ranking", "high tide today",
];
for (const q of ABBREV_MISS) expect(opensLocally, q, false, "abbrev-miss");

// ---- Clinical modifiers: gate must OPEN (Fix_8) ----------------------------
// How people search after a doctor's visit: modifier + value, no pronoun, no
// body part. Some also hit Tier 1 exactly; either way they must not be dropped.
const MODIFIER_OPEN = [
  "elevated levels", "abnormal reading", "sudden onset", "persistent problem",
  "severe episode", "acute episode", "chronic condition", "low count",
  "high reading", "mild attack", "ldl 160", "a1c 6.2", "normal range",
];
// "not dropped" is the real contract: some of these resolve at Tier 1 exactly
// (e.g. "a1c 6.2" via the abbreviation list) and never need the gate at all.
const reachesCompanion = (q) => opensLocally(q) || hasWeakHealthSignal(q);
for (const q of MODIFIER_OPEN) expect(reachesCompanion, q, true, "modifier-open");

// ---- Clinical modifiers: gate must STAY SHUT -------------------------------
// The token cap and the non-medical veto are privacy controls. Deleting either
// must turn this section red — verified by mutation, see Fix_8 test plan.
const MODIFIER_SHUT = [
  "high school ranking", "high tide today", "low fat recipes",
  "test results excel formula", "normal distribution explained",
  "acute angle definition", "severe weather warning",
  "low latency database", "count distinct sql",
  "test driven development", "normal map blender", "result of world cup",
  "high level design interview", "latest episode recap", "new episode tonight",
  "high demand jobs 2026", "severe delays on the metro",
];
for (const q of MODIFIER_SHUT) expect(hasWeakHealthSignal, q, false, "modifier-shut");

// ---- Known leaks: pinned so they stay visible, not hidden -------------------
// The veto list is a precision device, not a blocklist — it will never cover
// every subject. These queries DO reach /intent today. The cost is one wasted
// yes/no call each (the backend answers "no" and no drawer opens), not a wrong
// drawer. Measured held-out leak rate at time of writing: 4/45 (9%).
// If you add veto terms that cover these, move them into MODIFIER_SHUT.
const KNOWN_LEAKS = [
  "chronic procrastination fix",
  "result declaration date",
  "elevated walkway singapore",
  "persistent cookies explained",
];
for (const q of KNOWN_LEAKS) expect(hasWeakHealthSignal, q, true, "known-leak");

// ---- Fix_13: lab vocabulary that was reaching the cloud or being dropped ----
const LAB_HIT = [
  "lipid profile test not normal", "lipid profile", "vitamin d deficiency",
  "hba1c 7.2 meaning", "triglycerides high", "insulin resistance",
  "low sodium symptoms", "potassium levels", "urine test cloudy",
  "hormone imbalance", "menstrual cramps", "ovarian cyst", "b12 deficiency",
];
for (const q of LAB_HIT) expect(isPotentialHealthQuery, q, true, "lab-hit");

// Measured collisions — these words are ambiguous as WHOLE WORDS, so the
// two-list split cannot save them and they are deliberately NOT in Tier 1.
// On Google they reach the intent check instead, where context is judged.
const LAB_MISS = [
  "calcium in plant soil", "deficiency judgment law", "fertile soil for plants",
  "soil fertility index", "bar stools for kitchen", "fertilizer for lawn",
  "t3 instance pricing aws", "d3 js bar chart",
];
for (const q of LAB_MISS) expect(isPotentialHealthQuery, q, false, "lab-miss");

// ---- Fix_13: host routing ---------------------------------------------------
// gemini.google.com is a SUBDOMAIN of google.com — if this ever returns true
// for it, every Gemini prompt starts going to the backend.
const SEND_ALL_HOSTS = [
  "www.google.com", "google.com", "news.google.com",
  // ccTLDs — the manifest enumerates these, so the predicate must accept them
  // or a judge outside the US silently falls back to the gated path.
  "www.google.co.in", "google.co.uk", "www.google.com.au", "google.de",
  "www.google.co.jp", "google.com.br", "www.google.ca",
];
for (const h of SEND_ALL_HOSTS) expect(sendsEveryMiss, h, true, "host-send-all");

const GATED_HOSTS = [
  "gemini.google.com", "chatgpt.com", "www.chatgpt.com",
  "notgoogle.com", "evilgoogle.com.attacker.net", "googleblog.com",
  "mygoogle.example.com", "",
];
for (const h of GATED_HOSTS) expect(sendsEveryMiss, h, false, "host-gated");

// ---- Fix_13: structural rejects apply on BOTH paths -------------------------
const SENDABLE = ["lipid profile test not normal", "why do i feel weird"];
for (const q of SENDABLE) expect(isSendableText, q, true, "sendable");
const NOT_SENDABLE = [
  "hi", "a".repeat(400), "https://example.com/page",
  "const x = () => { return 1; }", "SELECT * FROM users WHERE id = 1",
];
for (const q of NOT_SENDABLE) expect(isSendableText, q, false, "not-sendable");

// ---- manifest <-> routing predicate must not drift -------------------------
// Chrome cannot wildcard a TLD, so manifest.json enumerates every Google
// domain. If someone adds one there but the predicate does not accept it, the
// extension loads on that domain and silently uses the GATED path — a recall
// loss nobody would notice. Assert every injected Google host routes send-all.
{
  const manifest = require("../../manifest.json");
  const googleHosts = manifest.content_scripts[0].matches
    .map((p) => p.split("://")[1].split("/")[0])
    .filter((h) => h.includes("google.") && !h.includes("gemini"))
    .map((h) => h.replace(/^\*\./, "www."));
  for (const h of googleHosts) {
    checks++;
    if (!sendsEveryMiss(h)) {
      failures++;
      console.error(`  FAIL [manifest-drift] ${h} is injected but routes as gated`);
    }
  }
  // ...and the assistants must stay gated.
  for (const h of ["gemini.google.com", "chatgpt.com"]) {
    checks++;
    if (sendsEveryMiss(h)) {
      failures++;
      console.error(`  FAIL [manifest-drift] ${h} must stay gated`);
    }
  }
}

// ---- Fix_16: ambiguity split on the Tier-1 HIT path ------------------------
// A Tier-1 hit used to open the drawer with no verification. These corpora
// decide which hits still open instantly and which pay one cloud check.

// Must open INSTANTLY — a second, unambiguous term is present, so no network.
// This is what separates V2 ("verify only when EVERY term is ambiguous") from
// V1 ("verify when ANY is"); under V1 every one of these would pay a round trip.
const AMBIGUOUS_INSTANT = [
  "chest pain",            // chest is ambiguous, pain is not
  "liver enzymes high",    // liver / enzyme
  "blood clot in leg",     // blood / clot
  "swollen lymph nodes",   // swollen / lymph
  "biopsy results", "lymphoma symptoms", "hba1c 7.2 meaning",
  // Longest-match resolution: these contain an ambiguous prefix as a shorter
  // vocabulary term ("heart" in "heartburn", "blood" in "bloodtest"), and must
  // classify on the longer term they actually are.
  "heartburn remedies", "bloodtest results", "colonoscopy prep",
];
for (const q of AMBIGUOUS_INSTANT) expect(classifyHealthQuery, q, "instant", "ambig-instant");

// Must VERIFY — every matched term is ambiguous, so the drawer waits on Haiku.
// This is the measured latency cost of the fix, not a defect.
const AMBIGUOUS_VERIFY = [
  "my nose is runny", "weird mole on my back", "hair falling out",
  "sore throat", "i feel sick", "always tired lately", "high blood pressure",
  "should i see a doctor", "is this a disease", "sharp cramp",
];
for (const q of AMBIGUOUS_VERIFY) expect(classifyHealthQuery, q, "verify", "ambig-verify");

// No vocabulary term at all — these fall through to the existing miss path,
// which is untouched by this fix.
const AMBIGUOUS_NONE = [
  "birthday gift for mom", "best pizza near me", "flight to delhi",
  "how to rename a git branch",
];
for (const q of AMBIGUOUS_NONE) expect(classifyHealthQuery, q, "none", "ambig-none");

// ---- Fix_16: everyday queries that COLLIDE with the vocabulary -------------
// Each of these fires a Tier-1 term while carrying no health intent — the
// defect this fix exists to close. None may reach "instant"; "verify" is the
// correct outcome (the backend then answers no and no drawer opens).
const EVERYDAY_COLLIDING = [
  "eye of the tiger lyrics", "eye contact in interviews",
  "hair dryer best brand", "blood diamond movie review",
  "blood moon eclipse date", "heart of darkness summary",
  "heart shaped balloons", "minecraft skin editor",
  "bone china dinner set", "book spine label template",
  "wooden chest of drawers", "node js tutorial", "node red tutorial",
  "mass effect legendary edition", "mole sauce recipe",
  "sweat proof t shirts", "nose art on aircraft", "tired of waiting song",
  "doctor who season 14", "doctor strange movie",
  "hospital drama series netflix", "emergency exit sign dimensions",
  "sick beats playlist", "tree disease identification",
  "liverpool fc fixtures", "kidney beans recipe",
  "brain teaser puzzles for kids", "brain food snacks",
  "lung capacity of whales", "throat singing tuva", "nail salon near me",
  "wart hog facts", "pupil premium funding uk", "vision statement examples",
  "muscle car for sale", "joint bank account rules", "cramp twins cartoon",
  "sore loser meaning", "hurt locker cast", "swelling of the sea poem",
  "swell forecast surfing", "skin care routine", "iron levels in cast iron pans",
  // Plurals of the ambiguous whole-word terms. These leaked ("instant") until
  // the plural forms were added to AMBIGUOUS_TERMS — a root inherits its
  // classification by prefix, but a whole-word inflection does not.
  "kubernetes nodes tutorial", "graph nodes and edges",
  "masses of people gathered", "moles in the garden",
];
for (const q of EVERYDAY_COLLIDING) {
  checks++;
  if (classifyHealthQuery(q) === "instant") {
    failures++;
    console.error(`  FAIL [everyday-collide] ${JSON.stringify(q)} opens the drawer unverified`);
  }
}

// ---- Fix_16: the ambiguous list must not contain dead entries --------------
// Classification compares matched text against this set, so an entry that is
// spelled differently from the vocabulary (or absent from it) silently does
// nothing — the exact "dead alias" failure HEALTH_TYPOS warns about.
{
  const vocabulary = new Set([...HEALTH_ROOTS, ...HEALTH_WORDS, ...HEALTH_TYPOS]);
  for (const term of AMBIGUOUS_TERMS) {
    checks++;
    if (!vocabulary.has(term)) {
      failures++;
      console.error(`  FAIL [ambig-dead] ${JSON.stringify(term)} is in AMBIGUOUS_TERMS `
        + "but in no vocabulary list — it can never match");
    }
  }
}

// ---- Fix_16 mutation guards ------------------------------------------------
// A guard that can be deleted without a test failing is decorative (Fix_8).
// Both of these MUST fail the suite when their guard is removed.
{
  // 1. Emptying AMBIGUOUS_TERMS must let the everyday corpus through.
  checks++;
  const saved = [...AMBIGUOUS_TERMS];
  AMBIGUOUS_TERMS.clear();
  const leaked = EVERYDAY_COLLIDING.filter((q) => classifyHealthQuery(q) === "instant");
  saved.forEach((t) => AMBIGUOUS_TERMS.add(t));
  if (!leaked.length) {
    failures++;
    console.error("  FAIL [mutation] emptying AMBIGUOUS_TERMS did not break the "
      + "everyday corpus — the corpus is not actually exercising the guard");
  }
  // Restoration must be exact, or every later assertion runs on a mutated set.
  checks++;
  if (AMBIGUOUS_TERMS.size !== saved.length) {
    failures++;
    console.error("  FAIL [mutation] AMBIGUOUS_TERMS not restored after the guard");
  }

  // 2. The rejected V1 rule ("verify if ANY term is ambiguous") must break
  //    AMBIGUOUS_INSTANT. This is what pins the V2 choice in place.
  checks++;
  const classifyV1 = (text) => {
    const terms = matchedHealthTerms(text);
    if (!terms.length) return "none";
    return terms.some((t) => AMBIGUOUS_TERMS.has(t)) ? "verify" : "instant";
  };
  const v1Regressions = AMBIGUOUS_INSTANT.filter((q) => classifyV1(q) !== "instant");
  if (!v1Regressions.length) {
    failures++;
    console.error("  FAIL [mutation] the V1 rule still passes AMBIGUOUS_INSTANT — "
      + "the corpus does not distinguish V2 from V1");
  }
}

// ---- Fix_17: manual entry point (toolbar icon + shortcut) ------------------
// The node suite cannot click a toolbar, but it can pin the manifest contract
// and the scope lock, which is where this feature breaks silently.
{
  const fs = require("fs");
  const path = require("path");
  const manifest = require("../../manifest.json");
  const extDir = path.join(__dirname, "..", "..");

  const need = (cond, label) => {
    checks++;
    if (!cond) {
      failures++;
      console.error(`  FAIL [fix17] ${label}`);
    }
  };

  need(manifest.permissions.includes("activeTab"),
    "manifest.permissions must include activeTab (grants host access on click "
    + "without a new install warning)");
  need(manifest.permissions.includes("scripting"), "manifest.permissions must include scripting");
  need(!manifest.permissions.includes("tabs"),
    "manifest.permissions must NOT include tabs — tabs.sendMessage does not need "
    + "it and it would add an install-time warning for nothing");

  need(!!manifest.action, "manifest.action must exist or the toolbar icon is not clickable");
  // The single most likely way to break this feature silently: with a popup
  // declared, Chrome opens the popup and chrome.action.onClicked NEVER fires.
  need(manifest.action && !("default_popup" in manifest.action),
    "manifest.action must NOT declare default_popup — onClicked would never fire");
  need(!!(manifest.commands && manifest.commands._execute_action),
    "manifest.commands._execute_action must exist so the shortcut and the icon "
    + "share one code path");

  // The injected subset must stay a subset of the declared content scripts:
  // anything injected on demand has to be a file that was designed to load in
  // this context, and drawer.js is the only one with a re-injection guard.
  const declared = manifest.content_scripts[0].js;
  const bg = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
  const panelFiles = (bg.match(/const PANEL_FILES = \[([^\]]*)\]/) || [])[1];
  need(!!panelFiles, "background.js must define PANEL_FILES");
  if (panelFiles) {
    const files = panelFiles.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    for (const f of files) {
      need(declared.includes(f), `PANEL_FILES entry ${JSON.stringify(f)} is not a declared content script`);
    }
    // Injecting the interceptor into arbitrary pages is the thing this design
    // exists to avoid — it would install keystroke listeners and the URL poll
    // on every page the user opens the panel on.
    need(!files.includes("content.js"),
      "content.js must NEVER be in PANEL_FILES — the interception pipeline must "
      + "not be injected into arbitrary pages");
    need(files.every((f) => !f.startsWith("utils/")),
      "no utils/* file belongs in PANEL_FILES — the UI needs only report-panel + drawer");
  }

  // ---- The A3 mutation guard --------------------------------------------
  // Option A3 ("just widen matches to <all_urls>") was rejected: it injects the
  // interceptor onto the whole web for every user, permanently. Adding a
  // wildcard host here must turn this suite red.
  const WILDCARD = /^\*:\/\/\*\/\*$|<all_urls>|^\*:\/\/\*$/;
  for (const pattern of manifest.content_scripts[0].matches) {
    need(!WILDCARD.test(pattern),
      `content_scripts matches must not contain the wildcard ${JSON.stringify(pattern)} `
      + "— Fix_17 injects on demand instead (option A3, rejected)");
  }
  need(manifest.content_scripts[0].matches.length === 67,
    `content_scripts matches count is ${manifest.content_scripts[0].matches.length}, expected 67 `
    + "— Fix_17 must not change the declared interception surface");
  for (const host of manifest.host_permissions) {
    need(!WILDCARD.test(host), `host_permissions must not contain the wildcard ${JSON.stringify(host)}`);
  }
}

// ---- Performance: Tier 1b runs on every submit; it must not be felt --------
{
  const sample = "why does the thing keep happening every single morning lately ok";
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) isFuzzyHealthQuery(sample);
  const msPerRun = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
  if (msPerRun > 5) {
    failures++;
    console.error(`  FAIL [perf] fuzzy pass ${msPerRun.toFixed(2)}ms/run, want < 5ms`);
  } else {
    console.log(`  perf: fuzzy pass ${msPerRun.toFixed(3)}ms/run (budget 5ms)`);
  }
}

// classifyHealthQuery runs on every Tier-1 HIT, and unlike the boolean test it
// cannot early-exit — it collects every match to decide. Keep it unfelt.
{
  checks++;
  const sample = "high blood pressure and chest pain since yesterday morning";
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) classifyHealthQuery(sample);
  const msPerRun = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
  if (msPerRun > 5) {
    failures++;
    console.error(`  FAIL [perf] classify pass ${msPerRun.toFixed(2)}ms/run, want < 5ms`);
  } else {
    console.log(`  perf: classify pass ${msPerRun.toFixed(3)}ms/run (budget 5ms)`);
  }
}

const total = checks +
  TIER1_HIT.length + TIER1_MISS.length + GATE_OPEN.length + GATE_SHUT.length +
  TYPO_HIT.length + TYPO_MISS.length + ALREADY_EXACT.length +
  ABBREV_HIT.length + ABBREV_MISS.length +
  MODIFIER_OPEN.length + MODIFIER_SHUT.length + KNOWN_LEAKS.length +
  LAB_HIT.length + LAB_MISS.length + SEND_ALL_HOSTS.length +
  GATED_HOSTS.length + SENDABLE.length + NOT_SENDABLE.length + 1 +
  AMBIGUOUS_INSTANT.length + AMBIGUOUS_VERIFY.length + AMBIGUOUS_NONE.length;
if (failures) {
  console.error(`\n${failures}/${total} assertions failed`);
  process.exit(1);
}
console.log(`all ${total} assertions passed`);
