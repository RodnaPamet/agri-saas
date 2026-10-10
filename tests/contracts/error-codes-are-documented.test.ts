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
const EMISSION = /coded(?:BadRequest|NotFound|Forbidden|Conflict)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;

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
    'ACCOUNT_HAS_NO_EMAIL',
    'API_KEY_FAMILY_NOT_ENABLED',
    'API_KEY_WRONG_SURFACE',
    'BLOCK_SELLER_ONLY',
    'COMPANY_NAME_TAKEN',
    'CROP_PLAN_NOT_READY',
    'CROP_SEASON_YEAR_INVALID',
    'CROP_TYPE_INVALID',
    'DOSE_UNIT_NOT_FOUND',
    'ENTRA_GROUP_MAPPING_EXISTS',
    'FARM_NAME_NOT_SLUGGABLE',
    'FARM_NAME_REQUIRED',
    'FARM_SLUG_UNAVAILABLE',
    'FIELD_OPERATION_NOT_FOUND',
    'FILE_EMPTY',
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
    'INVALID_CROP_TYPE',
    'INVALID_EQUIPMENT',
    'INVALID_FARM_PAYLOAD',
    'INVALID_FILE',
    'INVALID_LIMIT',
    'INVALID_LOCATION',
    'INVALID_PARCEL',
    'INVALID_PLANTING',
    'INVALID_REVIEW_ACTION',
    'INVALID_SEASON',
    'INVALID_TAB_ORDER',
    'INVALID_TASK',
    'INVALID_VARIETY',
    'ITEM_NAME_ALREADY_EXISTS',
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
    'PARCEL_LOCATION_MISMATCH',
    'PROMOTION_LEAD_ALREADY_SENT',
    'PRODUCT_IS_SAMPLE_ARCHETYPE',
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
        for (const m of code.matchAll(EMISSION)) {
            if (!found.has(m[1])) found.set(m[1], full.replace(`${REPO}/`, ''));
        }
    }
    return found;
}

describe('an error code the server sends is named in the spec (#1391)', () => {
    const emitted = emittedCodes();
    const specText = readFileSync(SPEC, 'utf8');
    const documented = (c: string): boolean => specText.includes(c);
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
