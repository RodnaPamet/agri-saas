/**
 * Contract: an error `code` the server can send is NAMED in the published spec
 * (#1391).
 *
 * ## What a client is asked to do, and cannot
 *
 * `ErrorResponse.error.code` is the field the spec tells clients to switch on,
 * and agrent-ios translates each code into a sentence for the operator. It has
 * no way to know the set. Measured when this landed: **83** codes reachable
 * through the `coded*()` helpers, **16** named anywhere in `openapi.json`, so
 * **67** arrive at a client that has never heard of them.
 *
 * The failure is quiet and lands on the operator: an unrecognised code falls
 * back to whatever generic string the client holds, so a refusal that had a
 * precise cause — `PESTICIDE_REGULATORY_FIELDS_REQUIRED`,
 * `WATER_RATE_UNIT_REQUIRED` — is shown as "something went wrong".
 *
 * `PAST_DUE_RESTRICTED` was the sharpest case and is **documented now** (#1490)
 * — the first entry deleted from the baseline rather than added to it. It sits
 * in the shared 403 description in `src/lib/openapi/paths/helpers.ts`, not on a
 * single operation, because it is confined to five capability families and one
 * of them (`upload`) is gated at a choke point many unrelated routes reach.
 *
 * Writing it down corrected the reasoning that made it urgent. The original
 * argument was that the code decides WHERE a client sends the user — billing
 * portal versus plan picker — which CLAUDE.md states in terms. That is true of
 * the WEB client only: App Store guideline 3.1.1 keeps the native client from
 * pointing anyone to pay outside the app, so on iOS both refusals are
 * statements with no routing. The codes still have to be distinct — "a payment
 * failed" and "you are out of quota" need different sentences — but the spec
 * describes what the code MEANS and prescribes no destination, because a
 * documented remedy only one client can perform is the same defect one level
 * up from a code only one client can read.
 *
 * ## Why a ratchet and not one PR that documents 67 codes
 *
 * Documenting them is per-route work with a judgement per code (which route
 * raises it, what a client should do). Done as one sweep it would be 67
 * unreviewable guesses. The baseline makes the gap VISIBLE and MONOTONE: a new
 * code must be documented or added to the baseline in the same diff, and an
 * entry may only ever be deleted. That is the `openapi-undocumented-baseline`
 * shape, for the same reason.
 *
 * ## The population is derived, and the denominator is printed
 *
 * Codes come from scanning `src/` for the four `coded*()` helpers rather than
 * from a list, so a code added tomorrow is in scope today. Two deliberate
 * choices:
 *
 * - **Comments are blanked** (`blankNonCode`), because a docblock EXPLAINING
 *   one of these helpers is not an emission site. `farm-creation.ts` carries
 *   exactly such a docblock and warns that drafting it inflated a sibling
 *   guard's count twice. Measured today the two readings agree at 83 — that
 *   author defused the hazard by not writing a call with a quote — so this is
 *   a statement about today, not a reason to drop the blanking.
 * - **"Documented" means the code STRING occurs anywhere in the published
 *   spec**, enum or prose. That is deliberately generous: #1391 asks for "a
 *   per-route enum of codes, or at least a list in the descriptions", and a
 *   code failing even this test is beyond argument undocumented.
 *
 * ## Not in scope
 *
 * `NO_MARKET_PRICE` looks like it belongs here and does not. It is a
 * `refusalCode` INSIDE a 200 body (`BreakEvenRefusalCode`), already an enum in
 * the spec — a successful response reporting it cannot compute, not an error.
 * #1391 lists it beside the error codes; that is a category confusion worth
 * naming, because a reader who "fixes" it will document a 200 field as a
 * failure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO = process.cwd();
const SPEC = join(REPO, 'src/generated/openapi.json');

/** `codedBadRequest('X', …)` and its three siblings — the repo's convention. */
/**
 * Every way the server names a code, and the code's position in each (#1636).
 *
 * This was ONE pattern over four helpers, and there are six plus two error
 * classes. `codedUnsupportedMediaType` and `codedClientError` arrived with
 * #1633 and `SpatialLimitError` / `CodedFailureError` carry codes too — so
 * for a while a code thrown through any of those four channels was never
 * required to be documented at all. #1447 added eleven of them.
 *
 * Three patterns rather than one because the code sits in a different place
 * in each shape, and a single loose pattern would be the wrong fix: matching
 * "any UPPER_SNAKE literal near a throw" would collect entity enums like
 * `'PARCEL'` and demand the spec name them.
 *
 *   coded*(CODE, …)                  — code first
 *   codedClientError(status, CODE, …) — code second, after a number
 *   new SpatialLimitError(msg, CODE, …) — code second, after a message that
 *   new CodedFailureError(msg, CODE, …)   is often a multi-line concatenation
 */
const EMISSIONS: readonly RegExp[] = [
    /coded(?:BadRequest|NotFound|Forbidden|Conflict|UnsupportedMediaType)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /codedClientError\(\s*[^,]+,\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];

/**
 * The two error CLASSES, scanned through their own argument list rather than
 * a character window.
 *
 * A `[\s\S]{0,600}?` window was the first attempt and it missed two live
 * codes — measured, by a test that asserted real tree codes rather than
 * fixtures. `assertUploadWithinSize` in `src/lib/spatial/limits.ts` puts a
 * six-line comment between the message and the code explaining why the code
 * is not named `SPATIAL_FILE_TOO_LARGE`; `blankNonCode` replaces comment
 * text with SPACES and preserves length, so the gap stayed ~560 characters
 * wide and `SPATIAL_UPLOAD_TOO_LARGE` sat outside the window. Raising the
 * constant would have fixed those two and left the next long comment to
 * break it again.
 *
 * So the bound comes from the source: the call's matching close paren. The
 * sibling guard `error-params-carry-no-pii` reached the same conclusion for
 * the same reason, and says so in its own docblock.
 */
const CLASS_THROW = /new\s+(?:SpatialLimitError|CodedFailureError)\(/g;
/** Generous stop so a malformed file cannot make the scan run away. */
const MAX_CALL_SCAN = 4_000;

/** The call's own argument list, from `start` to its matching close paren. */
function callArgs(src: string, start: number): string {
    let depth = 1;
    const end = Math.min(src.length, start + MAX_CALL_SCAN);
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
 * The HELPER calls, scanned through their argument list the way the classes
 * above are — because `EMISSIONS` can only read a code that is a LITERAL sitting
 * immediately where the pattern expects it (#2370).
 *
 * Measured on the tree: 457 `coded*()` call sites, of which 5 pass something
 * other than a literal. Two are ternaries — `chosen.isFertilizer ?
 * 'FERTILIZER_NOT_FOUND' : 'PRODUCT_NOT_FOUND'` — whose four codes the narrow
 * pattern saw NONE of. Three pass a function call, where there is no literal to
 * read at all.
 *
 * The cost of that was not hypothetical: `TASK_STATUS_UNCHANGED`,
 * `ILLEGAL_TRANSITION` and `UNKNOWN_TASK_STATUS` are thrown through
 * `transitionErrorCode(transitionErr)` on the task status route, had bg and en
 * copy, and were named nowhere in the spec for as long as the route existed.
 * The guard reported full coverage over a population that excluded them — not a
 * failure it could see, because a code it cannot read is simply absent from the
 * denominator rather than reported as skipped.
 *
 * This runs ALONGSIDE `EMISSIONS` rather than replacing it. The narrow patterns
 * are precise and have their own tests below; the union is the same set for
 * every literal call, and this adds the expression cases. Deleting the narrow
 * ones would leave those tests exercising a path production no longer uses.
 */
const HELPER_CALL = /coded(BadRequest|NotFound|Forbidden|Conflict|UnsupportedMediaType|ClientError)\(/g;

/**
 * Where the code sits, per helper. `codedClientError` takes the status first.
 */
const CODE_ARG_INDEX: Record<string, number> = {
    BadRequest: 0,
    NotFound: 0,
    Forbidden: 0,
    Conflict: 0,
    UnsupportedMediaType: 0,
    ClientError: 1,
};

/**
 * The nth top-level argument of an argument list, respecting nesting.
 *
 * A plain `split(',')` cannot do this: `codedBadRequest(f(a, b), 'msg')` has its
 * first comma INSIDE a call, and an object or array argument has more. Strings
 * are skipped as units so a comma inside a message cannot split it either.
 */
function nthArg(args: string, n: number): string {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < args.length; i++) {
        const c = args[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) {
            parts.push(args.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(args.slice(start));
    return parts[n] ?? '';
}

/**
 * The calls whose code is computed, and what each can emit.
 *
 * A DECLARATION rather than an exemption, and the difference is the point. An
 * exemption would say "this call is allowed to hide its code" and the codes
 * would stay out of the denominator — which is the state that let three live
 * codes go unnamed in the spec. Declaring them puts them INTO the emitted set,
 * so the documentation test below holds them to the same standard as a literal.
 *
 * Keyed by the function the code comes from, never by a line number: a comment
 * added above a call moves its line while the call is unchanged, which is the
 * same reason `known-flakes.json` matches on title rather than position.
 *
 * `codes` is checked against that function's own body in both directions, so a
 * new `return` it does not list fails, and a code it lists that the function no
 * longer returns fails too.
 */
const COMPUTED_CODE_SOURCES: readonly {
    /** Substring of the call-site expression, which is how a site is matched. */
    readonly through: string;
    /** The function whose body defines the code set, when there is one. */
    readonly via?: string;
    readonly codes?: readonly string[];
    /** Set instead when the call RE-THROWS a typed error whose codes are already collected. */
    readonly reThrowOf?: string;
    readonly why: string;
}[] = [
    {
        through: 'transitionErrorCode',
        via: 'transitionErrorCode',
        codes: ['TASK_STATUS_UNCHANGED', 'ILLEGAL_TRANSITION', 'UNKNOWN_TASK_STATUS'],
        why:
            'The work-item state machine returns a typed error and this maps it to a code. '
            + 'All three were undocumented until #2370 — the reason this mechanism exists.',
    },
    {
        through: 'contractTransitionErrorCode',
        via: 'contractTransitionErrorCode',
        codes: [
            'CONTRACT_STORED_STATUS_UNKNOWN',
            'CONTRACT_TARGET_STATUS_UNKNOWN',
            'CONTRACT_ILLEGAL_STATUS_TRANSITION',
        ],
        why: 'The contract state machine, same shape as the task one above.',
    },
    {
        through: 'verdict.code',
        via: 'checkHandleShape',
        codes: [
            'FARM_HANDLE_RESERVED',
            'FARM_HANDLE_TOO_LONG',
            'FARM_HANDLE_TOO_SHORT',
            'FARM_HANDLE_UNUSABLE',
        ],
        why:
            'Returns a verdict whose `code` the caller throws. These four were already '
            + 'documented — found by the same sweep, and declared so they stay that way.',
    },
    {
        through: 'err.code',
        reThrowOf: 'SpatialLimitError',
        why:
            'A RE-THROW, not a code source: the instance was constructed with a literal code '
            + 'somewhere, and `classCodes` collects it there. Declaring a code set here would '
            + 'duplicate every construction site and go stale as they change. The test asserts '
            + 'the site really is guarded by `instanceof SpatialLimitError`, so a plain '
            + '`err.code` on some other error cannot borrow this entry.',
    },
];

/**
 * The body of a named function, from its opening brace to the matching close.
 *
 * Needed because "the codes this function can return" is a question about the
 * FUNCTION, not the file: `work-item-status.ts` also defines
 * `transitionErrorParams`, and a file-wide scan would read its status names as
 * codes and demand the spec document them.
 */
function functionBody(src: string, name: string): string | null {
    const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
    if (!sig) return null;
    const open = src.indexOf('{', sig.index + sig[0].length);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    return null;
}

export interface UnreadableCodeSource {
    /** `file:line`, so the message can be acted on without a search. */
    at: string;
    /** The expression as written, trimmed — enough to recognise the call. */
    expression: string;
}

/**
 * Codes from the helper calls, plus the calls whose code could not be read.
 *
 * EVERY UPPER_SNAKE literal in the code argument is collected, not the first:
 * a ternary names two codes and taking one would under-report by exactly the
 * branch a reviewer is least likely to check.
 */
function helperCodes(src: string, rel: string): { codes: string[]; unreadable: UnreadableCodeSource[] } {
    const codes: string[] = [];
    const unreadable: UnreadableCodeSource[] = [];
    for (const m of src.matchAll(HELPER_CALL)) {
        const args = callArgs(src, m.index! + m[0].length);
        const arg = nthArg(args, CODE_ARG_INDEX[m[1]] ?? 0);
        const literals = [...arg.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)].map((x) => x[1]);
        if (literals.length > 0) {
            codes.push(...literals);
            continue;
        }
        unreadable.push({
            at: `${rel}:${src.slice(0, m.index!).split('\n').length}`,
            expression: `coded${m[1]}(${arg.trim().slice(0, 60)}, …)`,
        });
    }
    return { codes, unreadable };
}

/**
 * Codes passed to one of the error classes.
 *
 * The first single- or double-quoted UPPER_SNAKE literal in the argument
 * list is the code: the preceding argument is always the human message, and
 * a sentence is never UPPER_SNAKE. Template literals use backticks, which
 * this deliberately does not match.
 */
function classCodes(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(CLASS_THROW)) {
        const args = callArgs(src, m.index! + m[0].length);
        const code = args.match(/['"]([A-Z][A-Z0-9_]{2,})['"]/);
        if (code) out.push(code[1]);
    }
    return out;
}

/**
 * Codes reachable today that no schema or description names.
 *
 * SHRINK-ONLY. Document a code and delete its line in the same diff; the
 * no-stale-entries test below removes the entry's cover the moment the code
 * stops being emitted, so this list cannot outlive what it excuses.
 */
const UNDOCUMENTED_BASELINE: readonly string[] = [
    // #2019's Drive upload codes. `uploadToDrive` exists; NO ROUTE CALLS IT
    // YET, so there is no operation to name them on — the route is the next
    // increment, and it waits on a decision about who may export (the token
    // resolver is `assertCanAdmin`, while the journal is EDITOR-writable).
    //
    // Baselined rather than documented on an unrelated operation, which is
    // what `COMPANY_NAME_TAKEN` above does for the same reason: naming a code
    // on a route that cannot raise it is worse than a visible line here.
    //
    // Neither direction can rot silently. 'the baseline has no stale entries'
    // strikes them the moment `drive.ts` stops emitting them; 'a baselined code
    // that HAS been documented is removed from the baseline' strikes them the
    // moment the export route names them in the spec. So the PR that adds the
    // route cannot leave these three behind — it goes red until it deletes them.
    'GOOGLE_DRIVE_NOT_GRANTED',
    'GOOGLE_DRIVE_REFUSED',
    'GOOGLE_GRANT_REVOKED',

    // All three upload codes LEFT this list in #1861, which documented
    // `POST /api/account/avatar` — the route that raises them.
    //
    // Including `UPLOAD_UNSCANNED_ON_PUBLIC_SURFACE`, and that one is worth a
    // note because it has no reachable caller: `scanOrRefuse` raises it only
    // when `exposure === 'public'` and nothing in the product passes that
    // (every upload surface is private, and the owner ruled the public farm
    // page text-only — #1858). I expected it to stay here for that reason.
    //
    // This guard's reverse check disagreed, correctly. The operation's
    // description NAMES the code and says when it fires and why this surface
    // cannot raise it, so a client switching on codes does find it in the
    // spec — which is what `documented()` measures and what the rule is for.
    // A baselined code that is documented is debt the list is lying about.

    // `COMPANY_NAME_TAKEN` and `PROMOTION_LEAD_ALREADY_SENT` are new as of
    // #1391's 409 work and are here for a specific reason: their ROUTES are
    // not in the spec at all (`/admin/companies/{id}`, `/offers/leads`,
    // `/sso/entra/group-mappings` — three
    // of the 243 on `openapi-undocumented-baseline.json`). Naming a code on
    // an undocumented route means documenting the route, which is a larger
    // change than the one that introduced the code. Their sibling,
    // `LISTING_INTEREST_ALREADY_SENT`, IS documented, because
    // `POST /exchange/inquiries` was already in the spec and only wanted the
    // 409 it could already answer.
    // `TASK_LINK_NOT_FOUND` and `TASK_EVIDENCE_NOT_FOUND` are new as of #1712
    // and here for the `COMPANY_NAME_TAKEN` reason directly above, measured
    // rather than assumed: their routes exist in code and are absent from the
    // spec —
    //
    //     DELETE /tasks/{taskId}/links/{linkId}        removeTaskLink
    //     DELETE /tasks/{taskId}/evidence/{evidenceId}  unlinkTaskEvidence
    //
    // `tasks.paths.ts` documents `/tasks/{taskId}/links` (GET, POST) and no
    // `links/{linkId}` or `evidence/{…}` path at all. So naming these codes
    // means adding two operations, which is a bigger change than the one that
    // coded the throws.
    //
    // Both paths are ALREADY on `openapi-undocumented-baseline.json` (lines
    // 247-248), so this is not a new gap — it is the same tracked one reached
    // from the code side instead of the route side.
    //
    // A third sibling was NOT added: `removeTaskWatcher` threw
    // `WATCHER_NOT_FOUND` and had no caller anywhere — no route, no test.
    // Coding an unreachable throw would have put a code on this list that no
    // client can ever receive.
    //
    // RESOLVED by deletion (#1717, owner ruling): the usecase and its
    // repository are gone, so there is no code to list and nothing to
    // exempt. Kept because the rule generalises — an unreachable throw does
    // not belong on a published error surface.
    // `ASSET_NOT_FOUND`, `MAINTENANCE_RECORD_NOT_FOUND`,
    // `ASSET_EVIDENCE_NOT_FOUND` and `ARTICLE_NOT_FOUND` are new as of #1712
    // batch 3, for the `COMPANY_NAME_TAKEN` reason above and at a larger
    // scale: their whole SURFACES are undocumented. Measured —
    //
    //     assets    0 paths in the spec, 11 on openapi-undocumented-baseline
    //     evidence  0 in the spec, 18 on the baseline
    //     knowledge 0 in the spec, 10 on the baseline
    //     access-reviews  0 in the spec, 5 on the baseline
    //
    // — and there is no `assets.paths.ts`, `evidence.paths.ts` or
    // `knowledge.paths.ts` to name them on. Documenting these four codes means
    // writing 44 operations first, which is its own change.
    //
    // Baselining them is not deferring the point of #1712. The farmer-facing
    // half lands here regardless: the phone shows the server's `message` for a
    // code its own table lacks, so these 19 sites go from English to Bulgarian
    // on the next request, documented or not.
    // The evidence family — #1712 batch 4 — joins the batch-3 block above for
    // the same reason: `evidence` has 0 paths in the spec and 18 on
    // `openapi-undocumented-baseline.json`, and there is no
    // `evidence.paths.ts` to name a code on.
    //
    // Three of them are STATE, not absence: `*_DELETED` and
    // `*_NOT_DOWNLOADABLE` answer 404 today because that is what the throw
    // site chose. Giving them codes is what lets a client say "this was
    // deleted" rather than "no such thing" — which is the distinction #1662's
    // ledger exists to carry — WITHOUT changing a status code under a client
    // that already handles 404. The status question is separate and not
    // smuggled in here.
    // ── TEN `ACCESS_REVIEW_*` codes left this list in #1739 ──
    //
    // The five `/api/t/{tenantSlug}/access-reviews*` paths are registered now
    // (`src/lib/openapi/paths/access-review.paths.ts`), so each code is named
    // on the operation that can actually return it. The note that used to sit
    // here — "there is no operation in the spec to name a refusal on" — is
    // answered rather than deleted: that WAS the blocker, and registering the
    // surface was the work.
    //
    // The earlier note also argued that the two 403s should not go in the
    // shared 403 description because they are confined to one surface. That
    // reasoning held and is why they are per-operation now rather than in
    // `helpers.ts`.
    //
    // ## TWO remain, and not because the work was left half-done
    //
    // Both are raised ONLY by `revokeDecision`, and `revokeDecision` has no
    // route — measured: zero callers outside its own module, and the decisions
    // path exports `PUT` alone, calling `submitDecision`. So there is no
    // operation that can return either one.
    //
    // Documenting them anyway would be worse than leaving them: it would tell
    // a caller about a refusal it cannot receive, with no operation to attach
    // it to. Deleting them from this list would claim documentation that does
    // not exist. They therefore stay, which is the honest reading of what this
    // list is for — codes a client cannot learn from the contract. These are
    // codes a client cannot RECEIVE either, and the unmounted usecase is filed
    // as #1793; whichever way that is resolved (mount a route, or remove the
    // capability) removes these two entries with it.
    // The three `EVIDENCE_FILE_*` codes also left in #1739, and the stale-entry
    // assertion below is what found them: they are raised ONLY by the
    // access-review evidence route (measured — one file each), so registering
    // that path documented them too. I had not set out to drain them, and the
    // guard refusing a baseline entry for an already-documented code is the
    // reason they did not quietly stay.
    'ACCOUNT_HAS_NO_EMAIL',
    'EVIDENCE_DELETED',
    'EVIDENCE_NOT_FOUND',
    'FILE_DELETED',
    'FILE_NOT_DOWNLOADABLE',
    'FILE_NOT_FOUND',
    'ARTICLE_NOT_FOUND',
    'ASSET_EVIDENCE_NOT_FOUND',
    'ASSET_NOT_FOUND',
    'MAINTENANCE_RECORD_NOT_FOUND',
    'TASK_EVIDENCE_NOT_FOUND',
    'TASK_LINK_NOT_FOUND',
    // `AI_BUDGET_REQUIRES_VERIFIED_FARM` is new to this list as of #1645 and
    // for the `COMPANY_NAME_TAKEN` reason above, not because the code is
    // unclear: its only emission path is `assertAiBudget` → `completeWithRouting`,
    // whose sole route is `/api/t/{tenantSlug}/ai/copilot` — and NO `/ai/` path
    // is in the spec at all. Naming it would mean documenting the AI surface,
    // which is larger than the change that made the code visible.
    //
    // It was not "new" in any other sense. It has been thrown since the AI
    // budget gate landed, as `forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM')` —
    // a code in the MESSAGE field, which this test's population does not
    // collect, so it was never required to be documented and never appeared
    // here. Its three siblings from the same #1645 sweep are documented
    // instead: `MFA_REQUIRED` already was, and `API_KEY_NOT_PERSON_SCOPED`,
    // `OPERATOR_SCOPE` and `FARM_PROFILE_EIK_NOT_EDITABLE` are now.
    'AI_BUDGET_REQUIRES_VERIFIED_FARM',
    'API_KEY_FAMILY_NOT_ENABLED',
    'API_KEY_WRONG_SURFACE',
    'BLOCK_SELLER_ONLY',
    'COMPANY_NAME_TAKEN',
    'CROP_SEASON_YEAR_INVALID',
    'CROP_TYPE_INVALID',
    'DOSE_UNIT_NOT_FOUND',
    'ENTRA_GROUP_MAPPING_EXISTS',
    'FARM_NAME_NOT_SLUGGABLE',
    'FARM_NAME_REQUIRED',
    'FARM_SLUG_UNAVAILABLE',
    'FIELD_OPERATION_NOT_FOUND',
    // 'FILE_EMPTY' removed in #1630 — the spatial-import 400 now names it.
    //
    // `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED` and `INVALID_FILE` left in
    // #1812, which documented `POST /api/t/{tenantSlug}/journal/{id}/files` —
    // a route that raises all three from its OWN validation (it does not go
    // through `ingestUploadedFile`), verified at `journal.ts` lines 650, 656
    // and its multipart branch rather than assumed from the shared helper.
    //
    // The note that stood here said `FILE_TOO_LARGE` "only LOOKS documented
    // because `documented()` is `specText.includes(code)`" and
    // `SPATIAL_UPLOAD_TOO_LARGE` contains it. That hazard is real and is why
    // that code is named the way it is — but it is no longer what is
    // happening: the journal operation now names the bare code, which is a
    // word-boundary match and the thing the rule is actually about.
    'FILE_VALIDATION_ERROR',
    'IDEMPOTENCY_KEY_INVALID',
    'IDENTIFIERS_REQUIRED',
    'INSURANCE_PRODUCT_UNKNOWN',
    'INSURANCE_QUOTE_INVALID',
    'INVALID_ASSET',
    'INVALID_BBOX',
    'INVALID_EQUIPMENT',
    'INVALID_FARM_PAYLOAD',
    'INVALID_LIMIT',
    'INVALID_LOCATION',
    'INVALID_PLANTING',
    'INVALID_REVIEW_ACTION',
    'INVALID_TAB_ORDER',
    'INVALID_TASK',
    // ITEM_NAME_ALREADY_EXISTS left this baseline in #1391: the catalogue's
    // two 409 descriptions now NAME it, so it is documented rather than
    // excused. Deleted rather than commented out — a baseline is a list of
    // debts, and a paid one is not a debt with a note on it.
    'JOURNAL_ENTRY_NOT_FOUND',
    'JOURNAL_FILE_LINK_NOT_FOUND',
    'JOURNAL_TITLE_REQUIRED',
    'LISTING_NOT_FOUND',
    'MESSAGE_NOT_FOUND',
    'NOTES_TOO_LONG',
    'NOT_A_FIELD_OPERATION_TASK',
    'OPERATION_NOT_ASSIGNED_TO_YOU',
    'OPERATION_PARCEL_NOT_FOUND',
    'PARCELS_NOT_IN_LOCATION',
    'PROMOTION_LEAD_ALREADY_SENT',
    'TASK_NOT_AWAITING_REVIEW',
    'THREAD_NOT_A_PARTY',
    'THREAD_NOT_FOUND',
    'WATER_RATE_UNIT_NOT_FOUND',
    'WATER_RATE_UNIT_REQUIRED',
    'WEED_ENTRIES_TOO_MANY',
    'WEED_NAME_TOO_LONG',
    // ── #1712's farmer tranche: three of six codes, routes measured ──
    //
    // The other three ARE documented, on the operations that raise them:
    // AVATAR_NOT_FOUND on `/api/account/avatar/{userId}`, DELIVERY_NOT_FOUND
    // on `/grain/deliveries/{deliveryId}`, INQUIRY_NOT_FOUND on
    // `/exchange/inquiries/{inquiryId}`. Those three routes were already in
    // the spec and only wanted the 404 they can already answer, which is the
    // `LISTING_INTEREST_ALREADY_SENT` precedent above.
    //
    // These three are here for the `COMPANY_NAME_TAKEN` reason, measured
    // against `src/generated/openapi.json` (184 paths) rather than assumed:
    //
    //     ORG_NOT_FOUND_OR_FORBIDDEN   no /org/ path in the spec at all
    //     SUPPORT_SCHEME_NOT_FOUND     no support-scheme path
    //     TARGET_USER_NOT_IN_TENANT    no admin/sessions path
    //
    // ORG_NOT_FOUND_OR_FORBIDDEN is the awkward one and worth naming: it comes
    // from `context.ts`'s org resolver, so it is raised by EVERY organisation
    // route rather than one operation. Documenting it means documenting the
    // org surface, which is a larger change than the one that introduced the
    // code — and it would want the shared-envelope treatment, not a
    // per-operation line.
    //
    // Note what the code does NOT distinguish, so nobody "improves" it later:
    // `context.ts` deliberately answers the same way for "no such org" and
    // "not a member", with the real reason going only to the internal log.
    // Splitting it into ORG_NOT_FOUND and ORG_ACCESS_DENIED would re-open that
    // leak, so this entry must not be resolved by adding two codes.
    'ORG_NOT_FOUND_OR_FORBIDDEN',
    'SUPPORT_SCHEME_NOT_FOUND',
    'TARGET_USER_NOT_IN_TENANT',

    // The five Google-integration codes (#2005), here for the
    // `COMPANY_NAME_TAKEN` reason above and measured rather than assumed:
    // `src/generated/openapi.json` holds 184 paths and NONE of them is a
    // google path, so naming these codes means adding three operations to the
    // spec — a bigger change than the one that coded the throws.
    //
    // All three routes are already on `openapi-undocumented-baseline.json`
    // (added in #2005 with UNDOCUMENTED_CEILING 214 -> 217, matching how all
    // four SharePoint integration routes are handled), so this is the same
    // tracked gap reached from the code side rather than a new one.
    //
    // `GOOGLE_CONNECTION_NOT_FOUND` is ONE code for two sites, and must not
    // be resolved by splitting it. `loadConnection` and `disconnectGoogle`
    // both query on `tenantId`, so another tenant's connection returns null
    // and takes the same path as one that does not exist — the
    // `ORG_NOT_FOUND_OR_FORBIDDEN` note directly above is the same rule.
    'CONNECTION_ID_REQUIRED',
    'GOOGLE_CONNECTION_NAME_TAKEN',
    'GOOGLE_CONNECTION_NOT_FOUND',
    'GOOGLE_CONNECTION_NO_CREDENTIALS',
    'GOOGLE_SCOPES_MISSING',
];

/**
 * ONE walk of the tree, memoised, because two tests need two different things
 * from it — the codes, and the calls whose code could not be read. Walking
 * twice would read ~2,100 files twice to answer questions one pass already
 * answers.
 */
let SCAN: { codes: Map<string, string>; unreadable: UnreadableCodeSource[] } | null = null;

function scanTree(): { codes: Map<string, string>; unreadable: UnreadableCodeSource[] } {
    if (SCAN) return SCAN;
    SCAN = scanTreeOnce();
    return SCAN;
}

/** Every code reachable through a `coded*()` helper, from source. */
function emittedCodes(): Map<string, string> {
    return scanTree().codes;
}

function scanTreeOnce(): { codes: Map<string, string>; unreadable: UnreadableCodeSource[] } {
    const files = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => rel.startsWith('src/generated/'),
        // ~2100 at the time of writing. A floor near reality catches an
        // exclude predicate that ate the tree rather than reporting it clean.
        floor: 1500,
    });
    const found = new Map<string, string>();
    const unreadable: UnreadableCodeSource[] = [];
    for (const full of files) {
        const code = blankNonCode(readFileSync(full, 'utf8'));
        for (const pattern of EMISSIONS) {
            for (const m of code.matchAll(pattern)) {
                if (!found.has(m[1])) found.set(m[1], full.replace(`${REPO}/`, ''));
            }
        }
        for (const c of classCodes(code)) {
            if (!found.has(c)) found.set(c, full.replace(`${REPO}/`, ''));
        }
        // The expression-aware pass. Its literal codes are a SUPERSET of what
        // the narrow patterns found for the same calls, so the union changes
        // nothing for a literal call and adds the ternary branches.
        const rel = full.replace(`${REPO}/`, '');
        const helper = helperCodes(code, rel);
        for (const c of helper.codes) {
            if (!found.has(c)) found.set(c, rel);
        }
        unreadable.push(...helper.unreadable);
    }
    // The declared ones, so a computed code is held to the same standard as a
    // literal rather than excused. The origin is the declaration itself — if
    // this code is undocumented, the message should point here, not at a file
    // where the literal does not appear.
    for (const d of COMPUTED_CODE_SOURCES) {
        for (const c of d.codes ?? []) {
            if (!found.has(c)) found.set(c, `COMPUTED_CODE_SOURCES (via ${d.via})`);
        }
    }
    return { codes: found, unreadable };
}

/**
 * Teeth for #1632 and #1636.
 *
 * Both fixes produce an EMPTY behavioural diff on the tree as it stands —
 * measured: widening the collector surfaces 14 further codes and every one is
 * already documented, and `\b` changes the verdict for zero codes. That is
 * good news about the tree and terrible news for review, because a widened
 * scanner that finds nothing is indistinguishable from a scanner still
 * broken. These cases are the difference.
 */
describe('the scanner can see what it was blind to (#1636, #1632)', () => {
    /** The pattern this file used before #1636 — four helpers, code first. */
    const NARROW = /coded(?:BadRequest|NotFound|Forbidden|Conflict)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;

    /** Both halves of the live collector: the helper patterns and the classes. */
    const collect = (src: string, patterns: readonly RegExp[], classes = true): string[] => {
        const out = new Set<string>();
        for (const p of patterns) for (const m of src.matchAll(p)) out.add(m[1]);
        if (classes) for (const c of classCodes(src)) out.add(c);
        return [...out].sort();
    };

    it.each([
        ['codedUnsupportedMediaType', "throw codedUnsupportedMediaType('PLANTED_MEDIA_CODE', 'm');"],
        ['codedClientError', "throw codedClientError(400, 'PLANTED_CLIENT_CODE', 'm');"],
        ['SpatialLimitError', "throw new SpatialLimitError('a sentence', 'PLANTED_LIMIT_CODE', 422);"],
        ['CodedFailureError', "throw new CodedFailureError('a sentence', 'PLANTED_FAILURE_CODE');"],
    ])('%s: the widened patterns collect it and the old one does not', (_label, snippet) => {
        expect(collect(snippet, EMISSIONS)).toHaveLength(1);
        // The half that makes this a proof rather than a restatement.
        expect(collect(snippet, [NARROW], false)).toEqual([]);
    });

    it('control: the old pattern still works on the shape it DID cover', () => {
        // Otherwise the assertions above would also pass if NARROW were simply
        // broken, which would prove nothing about the widening.
        const snippet = "throw codedNotFound('PLANTED_NOTFOUND_CODE', 'm');";
        expect(collect(snippet, [NARROW], false)).toEqual(['PLANTED_NOTFOUND_CODE']);
        expect(collect(snippet, EMISSIONS)).toEqual(['PLANTED_NOTFOUND_CODE']);
    });

    it('a code behind a long COMMENT is still collected', () => {
        // The case a character window missed. `blankNonCode` blanks comment
        // text to spaces and preserves length, so a six-line comment between
        // the message and the code pushes the code ~560 characters out.
        const snippet = [
            "throw new SpatialLimitError(",
            "    `a message long enough to matter here, with ${interpolation} in it`,",
            `    ${' '.repeat(700)}`,
            "    'PLANTED_BEHIND_A_COMMENT',",
            "    413,",
            ");",
        ].join('\n');
        expect(collect(snippet, EMISSIONS)).toEqual(['PLANTED_BEHIND_A_COMMENT']);
    });

    it('the widening collects REAL codes from the tree, not just fixtures', () => {
        // A self-authored snippet only proves the regex matches the snippet.
        // These four are thrown in `src/lib/spatial/limits.ts` and the two
        // import jobs through channels the old pattern could not see, so the
        // live collector must now contain them.
        const emitted = new Set(emittedCodes().keys());
        for (const c of [
            'SPATIAL_UPLOAD_TOO_LARGE',
            'SPATIAL_PARCEL_TOO_COMPLEX',
            'SPATIAL_IMPORT_INTERNAL',
            'CADASTRE_NOT_CONFIGURED',
        ]) {
            expect([...emitted]).toContain(c);
        }
    });

    it('a near-miss in the spec is NOT documented — the substring trap', () => {
        const spec = 'the spec names SPATIAL_PARCEL_TOO_COMPLEXX here';
        // What the old `documented()` would have said:
        expect(spec.includes('SPATIAL_PARCEL_TOO_COMPLEX')).toBe(true);
        // What a word-boundary test says:
        expect(/\bSPATIAL_PARCEL_TOO_COMPLEX\b/.test(spec)).toBe(false);
    });

    it('a SHORTER code nested in a longer documented one is not absolved', () => {
        // The case that nearly cost `FILE_TOO_LARGE` its baseline entry on
        // #1633, which is why that code was renamed rather than nested.
        const spec = 'error.code is SPATIAL_FILE_TOO_LARGE';
        expect(spec.includes('FILE_TOO_LARGE')).toBe(true);
        expect(/\bFILE_TOO_LARGE\b/.test(spec)).toBe(false);
    });
});

describe('an error code the server sends is named in the spec (#1391)', () => {
    const emitted = emittedCodes();
    const specText = readFileSync(SPEC, 'utf8');
    /**
     * Does the spec NAME this code — as a whole token (#1632).
     *
     * This was `specText.includes(c)`, which answers yes when the spec names
     * a LONGER code that contains this one. Two ways that bites, and the
     * first one actually happened:
     *
     *   1. Documenting `SPATIAL_FILE_TOO_LARGE` would have made the
     *      genuinely-undocumented `FILE_TOO_LARGE` read as covered, and the
     *      no-stale-entries test below would then have demanded its baseline
     *      line be deleted — removing cover from a live gap on three upload
     *      paths. Avoided on #1633 by renaming the new code, which is a
     *      workaround for this line rather than a fix.
     *   2. A code RENAMED in the spec goes on reading as documented: a
     *      mutation that changed `SPATIAL_PARCEL_TOO_COMPLEX` to
     *      `…COMPLEXX` survived `includes()` entirely.
     *
     * `_` is a word character, so `\b` rejects both a longer prefix and a
     * longer suffix. Measured when introduced: the verdict changes for ZERO
     * codes on the tree as it stands, so this is a tripwire and not a repair.
     */
    const documented = (c: string): boolean =>
        new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(specText);
    const baseline = new Set(UNDOCUMENTED_BASELINE);

    it('ranges over a real population — the denominator', () => {
        // Without this the rule below is satisfied by finding no codes, which
        // is what a renamed helper or a broken scan produces.
        expect(emitted.size).toBeGreaterThanOrEqual(70);
        // Positive control on the DETECTOR, not just the file count: these
        // three are emitted from three different modules, so a scan that
        // resolves one tree and misses another cannot pass this.
        expect([...emitted.keys()]).toContain('PAST_DUE_RESTRICTED');
        expect([...emitted.keys()]).toContain('THREAD_NOT_FOUND');
        expect([...emitted.keys()]).toContain('FILE_TOO_LARGE');
    });

    it('the spec names every emitted code, or the baseline accounts for it', () => {
        const gap = [...emitted.keys()].filter((c) => !documented(c) && !baseline.has(c)).sort();

        if (gap.length) {
            throw new Error(
                `${gap.length} error code(s) the server can send are not named anywhere ` +
                    `in src/generated/openapi.json:\n\n` +
                    gap.map((c) => `    ${c.padEnd(40)} ${emitted.get(c)}`).join('\n') +
                    `\n\n\`ErrorResponse.error.code\` is the field the spec tells clients to ` +
                    `switch on, and a code they have never heard of falls back to a generic ` +
                    `message — so a refusal with a precise cause reaches the operator as ` +
                    `"something went wrong" (#1391).\n\n` +
                    `Name it on the route that raises it: an \`enum\` of the codes for that ` +
                    `operation's 4xx, or at minimum the code in the response description. ` +
                    `\`rawErrorResponses()\` / \`extraResponses\` in ` +
                    `src/lib/openapi/paths/helpers.ts override per route AND per status, so ` +
                    `this does not touch the shared envelope.\n\n` +
                    `If documenting it has to wait, add it to UNDOCUMENTED_BASELINE in this ` +
                    `file IN THE SAME DIFF, so the debt is a visible line rather than a ` +
                    `silent one.`,
            );
        }
    });

    it('the baseline has no stale entries — it may only shrink', () => {
        // An entry whose code is no longer emitted is cover for nothing, and
        // left in place it would excuse a FUTURE code that reuses the name.
        const stale = UNDOCUMENTED_BASELINE.filter((c) => !emitted.has(c)).sort();
        expect(stale).toEqual([]);
    });

    it('a baselined code that HAS been documented is removed from the baseline', () => {
        // The other direction, and the one that makes the ratchet monotone:
        // documenting a code without deleting its entry leaves the list
        // overstating the debt, and the next reader cannot tell which entries
        // are real.
        const redundant = UNDOCUMENTED_BASELINE.filter((c) => documented(c)).sort();
        expect(redundant).toEqual([]);
    });

    it('collects BOTH branches of a ternary code, not just the first', () => {
        // The widening itself. `EMISSIONS` requires the literal to sit
        // immediately after the paren, so it collected NEITHER branch; a
        // first-literal-wins reader would collect one and under-report by
        // exactly the branch a reviewer is least likely to check.
        const snippet =
            "throw codedBadRequest(isFert ? 'TERNARY_FIRST' : 'TERNARY_SECOND', 'msg');";
        const { codes, unreadable } = helperCodes(snippet, 'fixture.ts');
        expect(codes.sort()).toEqual(['TERNARY_FIRST', 'TERNARY_SECOND']);
        // And a ternary of literals is NOT an unreadable site — it is read.
        expect(unreadable).toEqual([]);
        // The control: the narrow pattern sees nothing here, which is why the
        // widening was needed rather than merely tidier.
        expect([...snippet.matchAll(EMISSIONS[0])].map((m) => m[1])).toEqual([]);
    });

    it('reads the code argument past a comma inside a nested call', () => {
        // `nthArg` exists for this. A `split(',')` would cut
        // `pick(a, b)` in half and read the code position as `b)`, losing the
        // code — and silently, since a missing code is an absent one.
        const snippet = "throw codedClientError(statusOf(a, b), 'NESTED_COMMA', 'msg');";
        expect(helperCodes(snippet, 'fixture.ts').codes).toEqual(['NESTED_COMMA']);
    });

    it('the two LIVE ternary call sites are collected from the real tree', () => {
        // Fixtures prove the reader; this proves it is pointed at the tree.
        // Both codes were invisible before the widening, and both happen to be
        // documented — so nothing would have failed to reveal it.
        const codes = scanTree().codes;
        for (const c of ['FERTILIZER_NOT_FOUND', 'PRODUCT_NOT_FOUND']) {
            expect([c, codes.has(c)]).toEqual([c, true]);
        }
    });

    it('every computed code source is DECLARED, not silently hidden', () => {
        // The denominator this guard reports over. A call whose code it cannot
        // read is not reported as skipped — it is simply absent, so coverage
        // reads as complete over a population missing exactly the call sites
        // someone had to think hardest about.
        const { unreadable } = scanTree();
        const undeclared = unreadable.filter(
            (u) => !COMPUTED_CODE_SOURCES.some((d) => u.expression.includes(d.through)),
        );
        console.log(
            `[computed-codes] ${unreadable.length} call(s) pass a computed code; `
                + `${COMPUTED_CODE_SOURCES.length} declaration(s) cover them`,
        );
        expect(
            undeclared.map((u) => `${u.at}  ${u.expression}`).sort(),
            // A ternary of literals is NOT in this list — those are read
            // directly, both branches. This is only for a code with no literal
            // to read: a function call, a property, a lookup.
        ).toEqual([]);
    });

    it.each(
        COMPUTED_CODE_SOURCES.filter((d) => d.via && d.codes).map((d) => [d.via!, d] as const),
    )(
        '%s declares exactly the codes its body returns',
        (via, decl) => {
            // Both directions, which is what stops the declaration rotting. A
            // new `return` the declaration omits fails here, and so does a code
            // it lists that the function no longer returns — the same two
            // ratchets the UNDOCUMENTED_BASELINE carries.
            const files = collectSourceFiles({
                roots: ['src'],
                extensions: ['.ts', '.tsx'],
                exclude: (rel) => rel.startsWith('src/generated/'),
                floor: 1500,
            });
            let body: string | null = null;
            for (const full of files) {
                body = functionBody(blankNonCode(readFileSync(full, 'utf8')), via);
                if (body) break;
            }
            // A declaration whose function has been renamed or deleted is
            // stale, and stale is how a registry stops describing the code.
            expect(body).not.toBeNull();
            const actual = [...new Set([...body!.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)].map((m) => m[1]))];
            expect(actual.sort()).toEqual([...decl.codes!].sort());
        },
    );

    it('a re-throw declaration only covers a site that really re-throws it', () => {
        // `through: 'err.code'` is a loose match by necessity — the expression
        // is three characters of property access. Without this, ANY
        // `coded*(err.code, …)` would silently borrow the SpatialLimitError
        // entry, including one re-throwing an error whose codes nothing
        // collects. So the site has to prove the guard is there.
        const { unreadable } = scanTree();
        const borrowed: string[] = [];
        for (const u of unreadable) {
            const decl = COMPUTED_CODE_SOURCES.find(
                (d) => d.reThrowOf && u.expression.includes(d.through),
            );
            if (!decl) continue;
            const file = u.at.slice(0, u.at.lastIndexOf(':'));
            const src = readFileSync(`${REPO}/${file}`, 'utf8');
            if (!src.includes(`instanceof ${decl.reThrowOf}`)) borrowed.push(u.at);
        }
        expect(borrowed.sort()).toEqual([]);
    });
});
