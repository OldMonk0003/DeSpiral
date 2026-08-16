// Companion — grounding interstitial: emergency bypass + show/hide decision (Fix_9)
//
//   node extension/utils/__tests__/interstitial.test.js
//
// The overlay itself needs a DOM and is verified manually (Fix_9 Task 7). What
// IS testable is the logic that decides whether someone gets locked out of
// their screen for 20 seconds — so that is what is pinned here.
//
// interstitial.js is loaded with stubs for the browser globals it touches at
// import time (chrome.storage, window, document); we only exercise its pure
// exports.

globalThis.Companion = {};

const noop = () => {};
globalThis.chrome = {
  storage: {
    local: { get: (_k, cb) => cb && cb({}), set: noop },
    onChanged: { addListener: noop },
  },
  runtime: {},
};
globalThis.window = { addEventListener: noop, matchMedia: () => ({ matches: false }) };
globalThis.document = { addEventListener: noop, visibilityState: "visible" };

require("../emergency-signals.js");
require("../../components/interstitial.js");

const { isEmergencyQuery, shouldShowInterstitial, GROUNDING_TECHNIQUES } =
  globalThis.Companion;

let failures = 0;
function expect(got, want, label) {
  if (got !== want) {
    failures++;
    console.error(`  FAIL [${label}] -> ${got}, want ${want}`);
  }
}
let checks = 0;
function check(fn, input, want, label) {
  checks++;
  const got = fn(input);
  if (got !== want) {
    failures++;
    console.error(`  FAIL [${label}] ${JSON.stringify(input)} -> ${got}, want ${want}`);
  }
}

// ---- Emergency bypass: must SKIP the pause entirely -------------------------
const EMERGENCY_HIT = [
  "choking",
  "i cant breathe",
  "can't breathe help",
  "chest pain radiating to arm",
  "chest pain and jaw pain",
  "throat closing up",
  "bleeding heavily won't stop",
  "overdose symptoms",
  "want to die",
  "kill myself",
  "anaphylaxis",
  "face drooping",
  "slurred speech sudden",
  "swallowed a battery",
  "heart attack",
];
for (const q of EMERGENCY_HIT) check(isEmergencyQuery, q, true, "emergency-hit");

// ---- Research-mode queries: these get the pause like anything else ----------
// Firing the bypass here would quietly disable the feature for ordinary
// health-anxiety searches, which is exactly what it exists to intercept.
const EMERGENCY_MISS = [
  "chest pain causes",
  "chest pain when breathing",
  "breathing exercises for anxiety",
  "choking hazard toys age",
  "stroke risk factors",
  "bleeding gums treatment",
  "suicide rate statistics",
  "high blood pressure",
  "is a lump under the armpit lymphoma",
  "how to stop overthinking",
];
for (const q of EMERGENCY_MISS) check(isEmergencyQuery, q, false, "emergency-miss");

// ---- The show/hide decision ------------------------------------------------
const NOW = 1_700_000_000_000;
const HALF_HOUR = 30 * 60 * 1000;
const base = {
  enabled: true, lastShown: 0, snoozedUntil: 0,
  now: NOW, isEmergency: false, alreadyMounted: false,
};
const withState = (o) => Object.assign({}, base, o);

checks++; expect(shouldShowInterstitial(base), true, "decision: default shows");
checks++; expect(shouldShowInterstitial(withState({ enabled: undefined })), true,
  "decision: absent toggle means enabled");
checks++; expect(shouldShowInterstitial(withState({ enabled: false })), false,
  "decision: toggle off suppresses");
checks++; expect(shouldShowInterstitial(withState({ isEmergency: true })), false,
  "decision: emergency bypasses");
checks++; expect(shouldShowInterstitial(withState({ alreadyMounted: true })), false,
  "decision: never mounts twice");
checks++; expect(shouldShowInterstitial(withState({ snoozedUntil: NOW + 1000 })), false,
  "decision: snoozed suppresses");
checks++; expect(shouldShowInterstitial(withState({ snoozedUntil: NOW - 1000 })), true,
  "decision: expired snooze does not suppress");
checks++; expect(shouldShowInterstitial(withState({ lastShown: NOW - 1000 })), false,
  "decision: within cooldown suppresses");
checks++; expect(shouldShowInterstitial(withState({ lastShown: NOW - HALF_HOUR - 1 })), true,
  "decision: past cooldown shows");
checks++; expect(shouldShowInterstitial(withState({ lastShown: NOW - HALF_HOUR + 1000 })), false,
  "decision: just inside cooldown suppresses");
// Emergency must win over every other condition.
checks++; expect(
  shouldShowInterstitial(withState({ isEmergency: true, enabled: true, lastShown: 0 })),
  false, "decision: emergency beats an otherwise-showing state");

// ---- Technique data integrity ----------------------------------------------
// The overlay's countdown assumes each technique fills exactly its duration; a
// mismatch would leave dead air or cut a step off.
for (const t of GROUNDING_TECHNIQUES) {
  checks++;
  const sum = t.steps.reduce((a, s) => a + s.duration, 0);
  expect(sum, t.duration, `technique ${t.id} steps sum to ${t.duration}s`);
}
checks++; expect(GROUNDING_TECHNIQUES.length, 3, "three techniques present");

if (failures) {
  console.error(`\n${failures}/${checks} assertions failed`);
  process.exit(1);
}
console.log(`all ${checks} assertions passed`);
