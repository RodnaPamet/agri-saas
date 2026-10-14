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
    // `FILE_TOO_LARGE` STAYS: it is emitted by upload/ingest, evidence and
    // journal and is still undocumented. It only LOOKS documented because
    // `documented()` is `specText.includes(code)` and
    // `SPATIAL_UPLOAD_TOO_LARGE` would have contained it — which is why that
    // code is named the way it is.
    'FILE_TOO_LARGE',
    'FILE_TYPE_NOT_ALLOWED',
    'FILE_VALIDATION_ERROR',
    'IDEMPOTENCY_KEY_INVALID',
    'IDENTIFIERS_REQUIRED',
    'IF_MATCH_EMPTY',
    'IF_MATCH_MALFORMED',
    'IF_MATCH_WEAK_TAG',
    'INSURANCE_PRODUCT_UNKNOWN',
    'INSURANCE_QUOTE_INVALID',
    'INVALID_ASSET',
    'INVALID_BBOX',
    'INVALID_EQUIPMENT',
    'INVALID_FARM_PAYLOAD',
    'INVALID_FILE',
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
    'JOURNAL_ENTRY_NOT_DELETED',
    'JOURNAL_ENTRY_NOT_FOUND',
    'JOURNAL_ENTRY_NOT_SOFT_DELETED',
    'JOURNAL_FILE_LINK_NOT_FOUND',
    'JOURNAL_TITLE_REQUIRED',
    'LISTING_NOT_FOUND',
    'LOCATION_NOT_FOUND',
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
];

/** Every code reachable through a `coded*()` helper, from source. */
function emittedCodes(): Map<string, string> {
    const files = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => rel.startsWith('src/generated/'),
        // ~2100 at the time of writing. A floor near reality catches an
        // exclude predicate that ate the tree rather than reporting it clean.
        floor: 1500,
    });
    const found = new Map<string, string>();
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
    }
    return found;
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
});
