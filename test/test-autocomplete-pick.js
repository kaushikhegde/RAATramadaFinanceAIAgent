/**
 * The MEL bug: a city autocomplete pick that WORKED was reported as a failure.
 *
 * `pickAutocomplete` decided a pick had "registered" by checking that the field
 * text no longer equalled what was typed. Airlines change ("QANTAS" → "QANTAS
 * AIRWAYS(QF)") so they passed; a city-CODE field does NOT — type "MEL", pick
 * Melbourne, the box still reads "MEL" — so every flight died at
 * `#departureCityCode: could not select "MEL" (no click registered)` and
 * `make-fixtures bpay` could not create a single booking.
 *
 * The decision now lives in the pure `autocompletePickResult(typed, value,
 * suggestionClicked)` so it can be tested here with no browser: an unchanged
 * value counts as a pick when a real dropdown row was clicked, and does NOT
 * count when nothing was clicked (raw text sitting in the box).
 */
const { autocompletePickResult } = require("../tramada-segments");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      got: ${detail}` : ""}`); }
}

console.log("\nautocompletePickResult — the MEL city-code bug");

// THE bug. Old code returned null here (value === typed) → "could not select
// MEL" on every flight. A real row was found and clicked, so it IS the pick.
ok('typed "MEL", box "MEL", a row WAS clicked → "MEL" (used to be null)',
  autocompletePickResult("MEL", "MEL", true) === "MEL",
  String(autocompletePickResult("MEL", "MEL", true)));

// The other side: same unchanged value but NO row clicked is just the raw text
// we typed sitting in the box — not a selection. Must stay null so a field that
// never opened a dropdown still fails loudly.
ok('typed "MEL", box "MEL", NO row clicked → null',
  autocompletePickResult("MEL", "MEL", false) === null,
  String(autocompletePickResult("MEL", "MEL", false)));

console.log("\nautocompletePickResult — a changed value always counts");

// Airline: value changed, so it registers whether or not a row was clicked.
ok('typed "QANTAS", box "QANTAS AIRWAYS(QF)" → returns the full value',
  autocompletePickResult("QANTAS", "QANTAS AIRWAYS(QF)", false) === "QANTAS AIRWAYS(QF)");

// If a city ever DOES resolve to a full name, that still works and doesn't even
// need the clicked flag.
ok('typed "MEL", box "(MEL) MELBOURNE" → returns the full value',
  autocompletePickResult("MEL", "(MEL) MELBOURNE", false) === "(MEL) MELBOURNE");

console.log("\nautocompletePickResult — empties and edges");

// Empty box = nothing selected, even if we think we clicked.
ok("empty box → null even with a click", autocompletePickResult("MEL", "", true) === null);
ok("null value → null", autocompletePickResult("MEL", null, true) === null);
ok("whitespace box → null", autocompletePickResult("MEL", "   ", true) === null);

// Trims before comparing, so a padded echo of the code is still "unchanged".
ok('box "  MEL  " with a click → trimmed "MEL"',
  autocompletePickResult("MEL", "  MEL  ", true) === "MEL",
  String(autocompletePickResult("MEL", "  MEL  ", true)));

// Case-insensitive: "mel" equals the "MEL" code, so it is the unchanged case
// and counts only because a row was clicked.
ok('box "mel" (case differs) with a click → "mel"',
  autocompletePickResult("MEL", "mel", true) === "mel");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
