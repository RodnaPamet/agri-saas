/**
 * Server-authored user-facing copy — the class no i18n guard could see.
 *
 * `no-hardcoded-ui-strings` walks `src/app` and `src/components`. Every
 * message thrown from a usecase lives in `src/app-layer/` or `src/lib/`,
 * so the count could reach 530 without a single test going red — while
 * the repo carried EIGHT green i18n guard files and a key-parity report
 * of `missing 0, drift 0, untranslated 0`.
 *
 * That is the whole reason this file exists: a translation is airtight
 * when adding untranslated text FAILS A TEST, not when the current text
 * happens to be translated. See `docs/i18n-airtight-roadmap.md`.
 *
 * ── What counts ──
 *
 * A message argument to `badRequest` / `notFound` / `forbidden` /
 * `conflict` / `unprocessable` that reads like prose: two or more latin
 * words, and not an ALL-CAPS identifier (`BAD_REQUEST` is a code, not
 * copy). These reach a client — `ApiClientError` preserves `message`,
 * and the iOS app renders the raw envelope, English and all.
 *
 * ── What does NOT count, and why that is the point ──
 *
 * A throw that carries a machine-readable CODE is exempt. A code is what
 * a client can translate; the English beside it becomes the fallback for
 * a code the client does not recognise — exactly the shape
 * `explainRefusal` already ships for the calculator's refusals, and the
 * shape `CLAUDE.md` already mandates for email ("a value shown to a
 * recipient must not be a pre-rendered sentence").
 *
 * **No call site is exempt today** — the helpers take no code parameter
 * yet, which is precisely why all 152 `badRequest` messages share one
 * category code and none of them can be keyed on. The exemption is
 * implemented ahead of that change so the ratchet REWARDS the migration
 * the moment it starts: every throw that gains a code drops out of the
 * count, and the baseline falls with it. Its mechanism is proven below
 * against a synthetic fixture rather than against zero real matches,
 * because an exemption nothing exercises is an exemption nobody can
 * trust.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['src/app-layer', 'src/lib'];

/**
 * The helpers whose first argument is shown to a person.
 * `unauthorized` is absent on purpose: its message is never rendered —
 * an unauthenticated client is redirected, not shown prose.
 */
/**
 * Matches the helper and its FIRST string literal directly.
 *
 * An earlier version captured an argument window with `\(([^;]*?)\)` and
 * pulled the message out of it. That window stops at the first `)` — which
 * for `'Only the assigned reviewer (or a tenant admin) may submit…'` lands
 * INSIDE the string, truncating it before its closing quote so the match was
 * dropped entirely. It hid 33 messages, every one of them for the sole
 * reason that it contained a parenthesis.
 *
 * That is the same defect this guard exists to catch, one level up: a scan
 * covering almost the right population reads exactly like one covering all
 * of it. Anchoring on the literal itself has no window to get wrong.
 */
const THROWERS =
    /\b(badRequest|notFound|forbidden|conflict|unprocessable)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
/**
 * The same helpers called with something that is NOT a string literal (#1737).
 *
 * `THROWERS` above requires the first argument to BE a quote, so a refusal
 * whose prose is computed has no literal there and was never counted. Two
 * confirmed instances, both found because coding a batch moved the number by
 * less than the number of sites fixed:
 *
 *   - `badRequest(cond ? 'A…' : 'B…')`               — 21 coded, moved 20
 *   - `badRequest(formatContractTransitionError(err))` — 16 coded, moved 15
 *
 * Neither was a mistake in the fix; the detector could not see them. One is a
 * conditional expression and one is a call, and the common factor is that
 * neither argument IS a string.
 *
 * ## It counts rather than reads, deliberately
 *
 * This marks a computed message as ONE unreadable site. It does not try to
 * follow a ternary's branches or resolve a formatter, because that always has
 * a tail it cannot follow — and a guard that GUESSES whether computed prose is
 * English would be worse than one that honestly counts it. `looksLikeUserCopy`
 * is therefore not applied here: there is nothing to apply it to.
 *
 * The regression hole is the reason this matters more than the undercount.
 * Someone adding `throw badRequest(formatSomething(err))` today introduces
 * server-authored English and the ratchet does not move — which is the one
 * thing this guard exists to prevent.
 *
 * The negative lookaheads exclude the two shapes that are not this defect: a
 * literal first argument (already counted above) and a call with no arguments
 * at all, which carries no prose.
 *
 * ## The whitespace lives INSIDE the lookahead, and that is load-bearing
 *
 * My first version was `\(\s*(?!['"`]|\))` — consuming the whitespace, then
 * looking ahead. Regex backtracking defeats it: the engine tries the longest
 * `\s*`, the lookahead sees the quote and fails, so it BACKTRACKS to a shorter
 * `\s*` — zero characters — where the next character is a newline rather than
 * a quote, and the negative lookahead then succeeds.
 *
 * So every multi-line call whose literal sits on the following line matched as
 * "computed". Measured: it reported 38 sites where there are 3, and would have
 * raised this baseline by ~35 phantom entries — making a shrink-only ratchet
 * permanently slack by exactly the amount nobody could account for.
 *
 * With `\((?!\s*['"`])` there is nothing consumed to backtrack over: the
 * lookahead itself spans the whitespace, so if a quote follows it at any
 * alignment the whole match is rejected.
 */
const THROWERS_COMPUTED =
    /\b(badRequest|notFound|forbidden|conflict|unprocessable)\((?!\s*['"`])(?!\s*\))/g;

/** An ALL-CAPS string literal among the call's OWN arguments = a code. */
const CARRIES_CODE = /(['"`])[A-Z][A-Z0-9_]{3,}\1/;
/** Hard stop, so a malformed file cannot make this scan run away. */
const MAX_ARG_SCAN = 400;


/**
 * The remainder of a call's argument list, from `start` to its matching
 * close paren.
 *
 * This is a balanced scan and not a fixed window, because a fixed window
 * was WRONG in a way worth recording: at 200 characters it ran past the
 * call into the following statements, so any neighbouring quoted ALL-CAPS
 * literal — `code: 'STALE_DATA'`, an enum comparison — exempted a throw
 * that carried no code at all. It silently exempted 66 of them.
 *
 * The comment justifying that window claimed a too-generous one "can only
 * ever EXEMPT a throw that is already coded". That was the error: the
 * exemption keys on a neighbour, so generosity leaks in exactly the
 * direction that hides work. The synthetic fixture at the bottom of this
 * file is what caught it.
 */
function argsAfter(src: string, start: number): string {
    let depth = 1;
    const end = Math.min(src.length, start + MAX_ARG_SCAN);
    for (let i = start; i < end; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return src.slice(start, i);
        }
    }
    return src.slice(start, end);
}

/**
 * Prose, not an identifier. Two latin words is the floor — it keeps
 * `'Not Found'` in and `'BAD_REQUEST'` out without a word list.
 */
export function looksLikeUserCopy(raw: string): boolean {
    const t = raw.trim();
    if (!t) return false;
    if (/^[A-Z0-9_]+$/.test(t)) return false;
    return (t.match(/[A-Za-z]{2,}/g) ?? []).length >= 2;
}

export interface CopyHit {
    file: string;
    message: string;
}

/**
 * Every user-facing English message thrown under `dirs`, minus coded ones.
 *
 * The file walk is `collectSourceFiles`, not a hand-rolled one. A guard's
 * unit of work is a SELECTION, and an empty selection passes every
 * assertion built on it — a sweep of this repo found 47 of 58 auditable
 * guards dead that way, 37 of them the same gutted `walk`. That helper
 * refuses to return an empty list, which is a stronger guarantee than the
 * positive control below and is why the repo forbids a new hand-rolled
 * collector (`file-collection-is-not-silently-empty`). I wrote one
 * anyway; CI caught it.
 *
 * `floor` is 200 against a real population of 667, so an `exclude`
 * predicate that ate most of the tree fails here rather than reporting a
 * clean repo.
 */
export function collectServerAuthoredCopy(root: string, dirs: string[] = ROOTS): CopyHit[] {
    const files = collectSourceFiles({
        roots: dirs.map((d) => path.join(root, d)),
        extensions: ['.ts'],
        exclude: (rel) => /\.(test|spec)\.ts$/.test(rel),
        floor: root === REPO_ROOT ? 200 : 1,
    });

    const hits: CopyHit[] = [];
    for (const full of files) {
        // Comments blanked, positions intact (#1387). STRINGS ARE KEPT:
        // the message text is this guard's entire subject, so blanking
        // string literals would blind it rather than sharpen it.
        const src = blankNonCode(fs.readFileSync(full, 'utf8'));
        for (const call of src.matchAll(THROWERS)) {
            const message = call[3];
            if (!looksLikeUserCopy(message)) continue;
            const afterMessage = (call.index ?? 0) + call[0].length;
            if (CARRIES_CODE.test(argsAfter(src, afterMessage))) continue; // coded — exempt
            hits.push({ file: path.relative(root, full), message });
        }
        // Computed prose (#1737). Same helpers, same code exemption, no
        // attempt to read the message — the two patterns are mutually
        // exclusive by construction, because this one requires the first
        // argument NOT to be a literal.
        for (const call of src.matchAll(THROWERS_COMPUTED)) {
            const afterOpen = (call.index ?? 0) + call[0].length;
            if (CARRIES_CODE.test(argsAfter(src, afterOpen))) continue; // coded — exempt
            hits.push({ file: path.relative(root, full), message: '<computed message>' });
        }
    }
    return hits;
}

/**
 * Measured 2026-09-22. MAY ONLY FALL.
 *
 * Lower it in the same diff that drains it — the drift sentinel below
 * forbids leaving slack, so this tracks reality rather than headroom.
 *
 * Note this is 530 where `docs/i18n-airtight-roadmap.md` first said 382:
 * that earlier figure came from a narrower grep requiring a capital
 * first letter and 15+ characters. Both were honest for their own
 * definition; this one is the definition that is now ENFORCED, so it is
 * the number that means something.
 *
 * 530 → 502: batch two coded the journal (the legally-filed register) and
 * field-operation (the spray recording that fills it). 29 call sites gained
 * a code and the count fell by 28 — the 29th is a ternary message, which
 * `THROWERS` never matched, so it was drained without ever being counted.
 * That gap is worth knowing: the ratchet measures literal-message throws,
 * so a computed message is user-facing English it cannot see.
 *
 * 502 → 497: no message was drained. #1387 taught the scan to skip COMMENTS,
 * and five of the 502 were prose quoting a throw rather than a throw —
 * `permission-middleware` twice, `stock-ledger` once, and `ai/budget` twice.
 * Lowered here rather than left as slack precisely because it is not
 * progress: leaving it would buy five real messages' worth of headroom for
 * nothing, which is what the drift sentinel below exists to prevent.
 */
// 492 -> 470 (#1479). `usecases/issue.ts` and `policies/issue.policies.ts`
// carried server-authored refusal prose; retiring the /issues surface took
// 22 strings with it. Lowered to the measured live count, not merely to
// inside DRIFT_ALLOWANCE, so the slack does not bank for the next change.
//
// 470 -> 466 (#1677). Removing the five legacy `lower_snake:` prefixes took
// their trailing "Upgrade to …" sentences with them. Lowered to the measured
// live count for the same reason as above.
//
// ## This count now OVER-states the defect it describes, by five
//
// The message below says a thrown string "reaches a Bulgarian operator in
// English". Since #1677 that is no longer true for a code with a catalogue
// entry: the server translates `message` from `errors.<CODE>` in the reader's
// language, and the English string the scan counts is only the fallback for a
// code with no entry yet.
//
// FIVE codes have entries today — `PLAN_LIMIT_EXCEEDED` (by resource),
// `AI_BUDGET_EXCEEDED`, `AI_TIER_NOT_ALLOWED`, `MODULE_DISABLED` (by reason)
// and `BILLING_UNAVAILABLE`. So 466 counts five strings that no longer reach
// anyone in English through an API route.
//
// It read TWO for a few hours: agrent-ios found wire identifiers in three of
// the five, those went back to English pending an ICU renderer, and #1677
// stage 2 brought them back with plural agreement. This comment has now been
// wrong in both directions, which is the hazard it warns about one paragraph
// down — a count whose stated reason drifts from the catalogue.
//
// The five English strings are still in the SOURCE, so the number does not
// move. Deleting them is a separate change with its own blast radius:
// `assertModuleEnabled` is called from SIX server components, where the
// localiser never runs because it lives in `withApiErrorHandling`'s catch — so
// for that one the English is still what surfaces. The other four are
// API-only and their English is genuinely dead weight; removing it is what
// will finally drop this number, and it is tracked rather than done here.
//
// NOT corrected for, deliberately. The strings are still in the source, and a
// scan that tried to exclude "but this one is localised at runtime" would have
// to model the catalogue — a detector mirroring the runtime by name, which is
// how a number stops moving without anybody noticing. The honest statement is
// that this is an upper bound.
//
// ── 466 → 438, and the prediction above was wrong about HOW ──────────────
//
// The paragraph above expected the number to fall by "deleting the English
// fallback". Measured, that would have moved it by ZERO: this scan matches
// `\b(badRequest|notFound|forbidden|conflict|unprocessable)\(`, which cannot
// match `codedForbidden(`, so the four API-only throws it names were never
// counted here in the first place. Deleting their English would also have
// removed the only text left if the catalogue fails to load, and the owner
// confirmed they stay.
//
// What actually dropped it is the EXEMPTION this file has carried since #1564
// and that nothing had yet exercised: 29 `notFound('<entity> not found')`
// sites adopted codes that already existed elsewhere in the tree
// (`LOCATION_NOT_FOUND`, `TASK_NOT_FOUND`, `LISTING_NOT_FOUND`,
// `PARCEL_NOT_FOUND` — the same entity was coded in one function and uncoded
// in another). 28 of the 29 were counted here, and gaining a code removed
// them. Refs #1712.
//
// So the mechanism is the reverse of the prediction: a code ADDED, not prose
// deleted. Worth leaving both statements visible, because the wrong one was
// specific and plausible and stood here unchallenged.
//
// ── 438 → 426 ────────────────────────────────────────────────────────────
//
// 12 more sites coded, in the ДНЕВНИК path a farmer actually walks:
// `crop-planning` (7), `task` (3), `parcel-lease` (2). Seven new codes, each
// with catalogue copy. Refs #1712.
//
// The drift sentinel did NOT fire this time — 438 ≤ 426 + 15 — so the slack
// would have sat here unnoticed inside the allowance. The number is lowered
// because the allowance exists to let two concurrent PRs land, not to bank
// headroom a sweep just created. Taken from the guard's own report (set the
// baseline low, read "rose to N") rather than from a reimplementation of its
// scan: a hand-rolled approximation of the same shape said 436, and the
// balanced-argument exemption is the difference.
//
// 427, not 426 at the time: the twelfth site was reverted, because
// `removeTaskWatcher` threw `WATCHER_NOT_FOUND` and had NO caller anywhere.
// Coding it would have added a code no client can receive.
//
// RESOLVED: the owner ruled to delete it (#1717), so the string is gone
// rather than uncoded, and this baseline drops by one with it. The
// paragraph stays because the REASONING outlived the code: an unreachable
// English string belongs in this count, not in an exemption.
//
// ── 427 → 408 ────────────────────────────────────────────────────────────
//
// 19 more sites coded, across three surfaces that are entirely undocumented:
// `asset` (7), `asset-maintenance` (4), `knowledge` (8). Four new codes.
// Refs #1712 batch 3.
//
// ── 408 → 395 ────────────────────────────────────────────────────────────
//
// 16 more sites coded in the evidence family — `evidence` (9),
// `evidence-retention` (4), the access-review evidence route (3). Eight new
// codes. Refs #1712 batch 4.
//
// ── 395 → 377 ────────────────────────────────────────────────────────────
//
// 18 more sites coded across the grain and inventory surfaces a farmer
// actually touches — `cost-entry` (5), `inventory` (7), `grain-bin` (3),
// `yield-record` (3). Four new codes, and the FIRST batch whose codes are
// DOCUMENTED rather than baselined: `grain` has 15 paths in the spec and
// `inventory` 6, so there were operations to name them on. Refs #1712 batch 5.

//
// ── 377 → 376 ──────────────────────────────────────────────────────
//
// The dead watcher usecases deleted (#1717), taking
// `notFound('Watcher not found')` with them.
//
// ── 376 → 356 ──────────────────────────────────────────────────────
//
// The whole `access-review` usecase coded in one pass: 21 throw sites, 12
// codes. The sites collapse hard — `ACCESS_REVIEW_NOT_FOUND` covers 5 and
// `ACCESS_REVIEW_DECISION_NOT_FOUND` 4, so nine sites needed two codes.
//
// 20 rather than 21, and the one that did not move is worth naming: the
// eligibility refusal at `access-review.ts:141` picks its sentence with a
// ternary on `parsed.scope`, so the message is a conditional expression
// rather than a string literal and THROWERS never matched it. It is coded
// now regardless — this detector undercounts a refusal whose prose is
// computed, which is a blind spot in the measurement and not in the fix.
//
// Unlike batch 5 these codes are NOT documented in the spec, and cannot be:
// all five `/api/t/{tenantSlug}/access-reviews*` paths sit on
// `tests/guards/openapi-undocumented-baseline.json`, so there is no
// operation to hang a "Refusal code:" line on. Registering them is its own
// piece of work. Refs #1712 batch 6.
//
// Two naming notes. `ACCESS_REVIEW_DECISION_ALREADY_EXECUTED` is deliberately
// not `..._DECISION_EXECUTED`, which already exists in this file as an AUDIT
// EVENT for the success case — one string meaning "a decision was executed"
// in the log and "you cannot revoke it" on the phone is a trap for whoever
// greps next. And `ACCESS_REVIEW_DECISIONS_IMMUTABLE` (a closed campaign
// refuses a decision change) is kept distinct from
// `ACCESS_REVIEW_ALREADY_CLOSED` (you tried to close it twice) because the
// remedies differ; the old `/closed/i` assertion could not tell them apart.
//
// ── 356 → 340 ──────────────────────────────────────────────────────
//
// `cost-entry.ts` coded: 16 sites, 11 codes, all `badRequest`. The drop is
// exactly 16 here, unlike batch 6 where it was 20 of 21 — every message in
// this file is a string or template literal, so `THROWERS` matched all of
// them.
//
// Six of the sixteen share ONE code. The cross-tenant reference checks
// (`planting`, `season`, `location`, `parcel`, `lease`, `item`) are the same
// refusal with a different noun, so they are
// `REFERENCE_NOT_IN_TENANT` with the noun in `params.reference` (renamed from
// `COST_ENTRY_REFERENCE_NOT_IN_TENANT` in batch 9, when the owner ruled one
// code for the whole class).
// They answer 400 and not 404 deliberately — a 404 would confirm the row
// exists in SOME tenant, which is what a cross-tenant probe is for — and the
// reference TYPE is returned while the id is not.
//
// Unlike batch 6, these codes are DOCUMENTED rather than baselined: all six
// cost routes are already in the spec, so there were operations to name them
// on. All three write operations reach the same eleven, because
// `createCostEntry`, `createCostEntryBatch` (via `prepareCostEntry` per line)
// and `updateCostEntry` all pass through `prepareCostEntry` and
// `writeCostEntryOn`. Traced through the call graph rather than assumed, and
// documented once as `COST_WRITE_REFUSALS` in `grain.paths.ts` so three
// copies cannot drift. Refs #1712 batch 7.
//
// ── 340 → 325 ──────────────────────────────────────────────────────
//
// `contract.ts` coded: 16 sites, 11 codes. The drop is 15, not 16, and the
// site that did not move is the SECOND confirmed instance of this detector's
// computed-prose blind spot — the first was batch 6's ternary at
// `access-review.ts:141`.
//
// Here it is `throw badRequest(formatContractTransitionError(transitionErr))`:
// the message is built by a function, so there is no string literal for
// THROWERS to match and the site was never counted. Coding it therefore moves
// this number by zero while genuinely removing server-authored English from a
// refusal a client receives.
//
// Two instances is enough to say the shape rather than the case: a refusal
// whose prose is COMPUTED is invisible here, so this baseline undercounts.
// Filed separately rather than papered over.
//
// The three transition variants became three codes rather than one, because
// `unknown_from` (the STORED status is not in the table — nothing the caller
// sends can succeed), `unknown_to` (an unrecognised target) and `illegal`
// (a legal target from an illegal place, which is the only one that can carry
// a useful `params.allowed`) have different remedies. The code and params are
// derived in `contract-status.ts` beside the transition TABLE, so they cannot
// drift from it when a status is added. Refs #1712 batch 7.
//
// ── 325 → 314 ──────────────────────────────────────────────────────
//
// `yield-record.ts` coded: 11 sites, 3 new codes plus the shared reference
// one. The drop is exactly 11; the renames below move it by zero because
// those sites were already coded.
//
// **One code for the cross-tenant class, by owner ruling.** 33 sites across
// 8 usecases raise the identical refusal — "X not found or belongs to a
// different tenant" — over 10 entity types (Season ×6, Planting ×3, Parcel
// ×3, Location ×3, Variety ×2, Task, Lease, Item, File, Asset). Batches 7 and
// 8 had already shipped THREE names for it, which would have become ~10 by
// the end and forced a client to know all of them to handle one refusal.
//
// So `COST_ENTRY_REFERENCE_NOT_IN_TENANT` (6 sites),
// `COST_ENTRY_ALLOCATION_PARCELS_NOT_IN_TENANT` (1) and
// `CONTRACT_SEASON_NOT_IN_TENANT` (2) all became `REFERENCE_NOT_IN_TENANT`
// with the entity in `params.reference`. The parcel SET uses the plural
// `parcels`, which distinguishes it without a second code.
//
// Renaming was cheap only because nothing consumes the code set yet —
// agrent-ios confirmed the phone resolves display from the localised
// `message` and acts on specific codes only. It gets more expensive every
// batch, which is why it was worth stopping to ask rather than minting an
// 11th name. Refs #1712 batch 9.
// 314 → 314 (#1737), and the flat number is the interesting part.
//
// The detector now also counts a refusal whose prose is COMPUTED — a ternary,
// a formatter call, a bare variable — which it previously could not see at
// all. #1737 predicted this would have to RAISE the baseline "by however many
// computed sites exist today", and warned that needed saying so it did not
// look like a regression.
//
// It does not, because the arithmetic came out exactly even: there was ONE
// unit of pre-existing slack (313 live against a baseline of 314) and there is
// exactly ONE uncoded computed site in the tree —
// `src/lib/promotions/promotion-image.ts:116`, `throw badRequest(blocked)`,
// where `scanVerdictBlocks` returns "This image was rejected by the malware
// scanner." So the live count rose from 313 to 314 and the ratchet went from
// one unit slack to exactly tight, which is what the drift sentinel wants.
//
// Worth stating because the next person to drain a batch should know the
// composition changed even though the figure did not: 313 literal + 1
// computed, not 314 literal. And the site above is now VISIBLE to #1712
// rather than invisible to it, which was the point.
// 314 → 309 (#1712, this batch): five uncoded `notFound()` sites gained codes,
// and a coded throw is exempt — the exemption has existed since #1564 and this
// is the kind of thing it was built to reward.
//
// Three are the TENANT RESOLVER (`src/lib/tenant-context.ts`), which is the
// hottest path in the product: every `/api/t/**` request resolves through it,
// so "Tenant not found" in English was reachable from more screens than any
// other single site on this list. Two are the lease payment write and delete.
//
// Lowered in the same diff that drained it, as the note above requires.
// 309 → 304 (#1712, tenant-admin batch): the five membership lookups in
// `tenant-admin.ts` gained ONE code between them, not five.
//
// Worth recording the shape rather than just the number, because the obvious
// move was four codes: each site carries a different English sentence ("not
// active", "already active", "already removed"), but each is a single query
// with a status predicate, so an absent membership and one in the wrong state
// both come back null. A code per sentence would have advertised a
// distinction the server cannot make. `params.requiredStatus` carries the
// detail instead.
//
// 304 → 294 (#1712, crop-planning batch): ten uncoded `badRequest` calls in
// `usecases/crop-planning.ts` gained SEVEN codes, and the file now has zero
// uncoded refusals of any helper.
//
// Seven and not three, which was the harder call. Six of the ten were "X name
// is required" and three were "that date is invalid", so a generic
// `NAME_REQUIRED` + `INVALID_DATE` would have been two codes covering nine
// sites and two iOS translations instead of six. I went the other way because
// the existing vocabulary is already domain-prefixed — `CONTRACT_INVALID_DATE`
// and `COST_ENTRY_INVALID_DATE` coexist deliberately rather than sharing one
// code, and `FARM_NAME_REQUIRED` is the precedent for a per-entity name code.
// Introducing generics beside 64 domain-prefixed codes would make the existing
// ones read as mistakes, and that is a vocabulary decision for the whole repo
// rather than one a batch should take on the side.
//
// One pair IS collapsed, and for the #1800 reason: `CROP_PLAN_INVALID_DATE`
// covers create and update, because both are the same field failing the same
// parse. `SEASON_INVALID_DATE` carries `params.field` because its single check
// covers two inputs, so "a date is invalid" would leave the client guessing
// which one — and `SEASON_WINDOW_INVERTED` is deliberately separate from it:
// both dates parsed and the window runs backwards, which is a different
// refusal, not a variant.
// 294 -> 289 (#1861). The avatar path's five bare refusals are coded now —
// AVATAR_FILE_MISSING, AVATAR_EMPTY, AVATAR_TOO_LARGE, AVATAR_NOT_WEBP and
// the WebP magic-number one — and a coded throw is exempt from this count.
// (`AVATAR_NOT_WEBP` has since been retired for `AVATAR_FORMAT_NOT_ALLOWED`
// and `AVATAR_UNREADABLE` in #1903, which is two coded throws where there
// was one. The count above is unaffected: coded either way.)
//
// Lowered rather than left at 294 with the slack absorbed by
// DRIFT_ALLOWANCE: a downward ratchet that is not tightened when the gain is
// earned silently buys room for the next five uncoded strings, which is the
// opposite of what it is for.
// 289 -> 271 for #1712's farmer tranche, and the split is worth recording
// because the sentinel below is what demanded it rather than anyone noticing.
// Measured by reverting the eight converted source files and re-counting:
//
//   with the conversions   271
//   without them           279   <- main's live count
//   the baseline was       289
//
// So 8 of the 18-string gain is this branch's (nine call sites, eight strings
// — catalog.ts had two sites sharing one message) and 10 had ALREADY
// accumulated on main, sitting inside DRIFT_ALLOWANCE where the sentinel
// tolerates it. Mine tipped the total past 15, which is the only reason the
// slack became visible. Banking both.
const CURRENT_BASELINE = 271;

/** Slack tolerated before the sentinel demands the baseline be lowered. */
const DRIFT_ALLOWANCE = 15;

describe('server-authored user-facing copy stays on a downward ratchet', () => {
    const hits = collectServerAuthoredCopy(REPO_ROOT);

    it(`stays at or below ${CURRENT_BASELINE}`, () => {
        if (hits.length > CURRENT_BASELINE) {
            const sample = hits
                .slice(0, 15)
                .map((h) => `  ${h.file}  "${h.message}"`)
                .join('\n');
            throw new Error(
                `Server-authored user-facing copy rose to ${hits.length} ` +
                    `(baseline ${CURRENT_BASELINE}).\n\n${sample}\n\n` +
                    `A message thrown from src/app-layer or src/lib reaches a ` +
                    `Bulgarian operator in English — the web preserves it on ` +
                    `ApiClientError, and the iOS app renders the raw envelope.\n` +
                    `Give the throw a machine-readable CODE so a client can ` +
                    `translate it, keeping the English as the fallback. See ` +
                    `docs/i18n-airtight-roadmap.md.`,
            );
        }
        expect(hits.length).toBeLessThanOrEqual(CURRENT_BASELINE);
    });

    it('the baseline tracks reality — no accumulated slack', () => {
        // Without this, every drained message silently buys headroom for a
        // new one and the ratchet stops ratcheting.
        expect(CURRENT_BASELINE).toBeLessThanOrEqual(hits.length + DRIFT_ALLOWANCE);
    });

    it('the scan actually reaches the server layer (positive control)', () => {
        // An empty selection satisfies a ceiling. If the walk breaks, or
        // the roots move, this is what says so instead of a green zero.
        expect(hits.length).toBeGreaterThan(0);
        expect(new Set(hits.map((h) => h.file)).size).toBeGreaterThan(20);
    });
});

describe('the counting rule itself', () => {
    it('prose counts; an ALL-CAPS identifier does not', () => {
        expect(looksLikeUserCopy('Access review not found')).toBe(true);
        expect(looksLikeUserCopy('Not Found')).toBe(true);
        expect(looksLikeUserCopy('BAD_REQUEST')).toBe(false);
        expect(looksLikeUserCopy('NOT_FOUND')).toBe(false);
        expect(looksLikeUserCopy('')).toBe(false);
    });

    it('prose ABOUT a throw is not a throw (#1387)', () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-cmt-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `// Denials throw badRequest('A fertilizer dose is required.') so the`,
                    `// caller can translate it. Quoted here, not called.`,
                    `/**`,
                    ` * Also throws notFound('The parcel has no soil sample.') in prose.`,
                    ` */`,
                    `throw conflict('The lot is already closed.');`,
                ].join('\n'),
                'utf8',
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);
            // Exactly the one real throw. Before #1387 this was three.
            expect(found.map((h) => h.message)).toEqual(['The lot is already closed.']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a message CONTAINING `//` survives, and a `//` line holding `/*` eats nothing', () => {
        // Two traps the stripper has to miss, and both are cheap to get
        // wrong. Truncating at a `//` inside a string would blank real
        // arguments and UNDER-count — the direction that hides work. And a
        // line comment that happens to contain `/*` must not open a block
        // comment: blanking blocks before lines made exactly that mistake
        // elsewhere in this repo and silently swallowed ten declarations.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-str-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `throw badRequest('See https://agrent.bg/help for guidance.');`,
                    `// a path like deploy/rollback/*.down.sql must not open a comment`,
                    `throw forbidden('This farm is not yours to edit.');`,
                ].join('\n'),
                'utf8',
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);
            expect(found.map((h) => h.message)).toEqual([
                'See https://agrent.bg/help for guidance.',
                'This farm is not yours to edit.',
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a COMPUTED message is counted, and a multi-line literal is not (#1737)', () => {
        // The gap this closes, and the bug my own first pattern had, as one
        // fixture — because they are the same question asked from two sides.
        //
        // #1737's two confirmed instances were a ternary and a formatter
        // call. `THROWERS` requires the first argument to BE a quote, so
        // neither was ever counted: coding 21 sites moved the number by 20,
        // and coding 16 moved it by 15.
        //
        // The multi-line case is the trap in the other direction. My first
        // pattern consumed the whitespace before looking ahead, and
        // backtracking defeated it — the engine shortened `\s*` to zero,
        // found a newline rather than a quote, and matched. It reported 38
        // computed sites where there is 1, which would have padded a
        // shrink-only ratchet with ~35 phantom entries.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-comp-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    // COUNTED — a ternary of literals (#1737 instance 1).
                    `throw badRequest(late ? 'The window has closed.' : 'Too early to file.');`,
                    // COUNTED — a formatter call (#1737 instance 2).
                    `throw badRequest(formatTransitionError(err));`,
                    // COUNTED — a bare variable, which is the one real site
                    // in the tree today (`scanVerdictBlocks` returns prose).
                    `throw badRequest(blocked);`,
                    // NOT counted — a literal that merely sits on the next
                    // line. This is the backtracking case.
                    `throw forbidden(`,
                    `    'This farm is not yours to edit.',`,
                    `);`,
                    // NOT counted — computed but CODED, same exemption as a
                    // literal message carrying a code.
                    `throw badRequest(formatIt(err), { code: 'TRANSITION_INVALID' });`,
                    // NOT counted — no argument at all, so no prose.
                    `throw forbidden();`,
                ].join('\n'),
                'utf8',
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);

            // Three computed hits, and the multi-line literal counted ONCE as
            // a literal rather than twice or not at all.
            expect(found.filter((h) => h.message === '<computed message>')).toHaveLength(3);
            expect(found.map((h) => h.message)).toContain('This farm is not yours to edit.');
            expect(found).toHaveLength(4);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a CODED throw is exempt, an uncoded one is not', () => {
        // The exemption has no real call sites yet — the helpers take no
        // code parameter — so it is proven here or not at all. When the
        // parameter lands, this is the behaviour the migration relies on.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'i18n-copy-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `throw badRequest('A fertilizer dose is required.');`,
                    `throw badRequest('A fertilizer dose is required.', 'DOSE_REQUIRED');`,
                    `throw notFound('BAD_REQUEST');`,
                ].join('\n'),
            );
            const found = collectServerAuthoredCopy(dir, ['src/lib']);
            expect(found).toHaveLength(1);
            expect(found[0].message).toBe('A fertilizer dose is required.');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
