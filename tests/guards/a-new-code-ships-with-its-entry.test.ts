/**
 * Guard: a new refusal code ships with its Bulgarian entry (#1677, #1918).
 *
 * ## The decision #1677 left open has in fact been taken
 *
 * #1677 names three ways out and says none was chosen. Option 3 — "resolve
 * `message` server-side from the request locale" — is what shipped:
 * `localizeErrorPayload` looks up `errors.<CODE>` and REPLACES
 * `error.message`, so an entried code reads in the caller's language on both
 * clients and needs nothing from either.
 *
 * That settles the convention question #1677 asks. `coded*()`'s English
 * second argument is not displayed copy for an entried code — it is the
 * FALLBACK for an unentried one, and the English prose is right for that job.
 *
 * What #1677 is left asking is the thing nothing enforced: the entry has to
 * exist. A code without one falls through to English, and
 * `src/lib/api-client.ts` prints `error.message` at 142 web call sites with
 * no language test, so the fallback is what a Bulgarian farmer reads.
 *
 * ## Why a ratchet and not a rule
 *
 * 81 codes have no entry today. A guard demanding all 81 at once would be
 * reverted, so they are grandfathered BY NAME below and the list may only
 * shrink. What the guard actually stops is the 82nd — which is the thing that
 * made this a backlog of 124 rather than a handful.
 *
 * The two lists are separate on purpose. `BACKLOG` is "not yet";
 * `DELIBERATELY_UNENTRIED` is "never", each with the reason attached. A
 * single list would let a decision rot into a to-do item, and that
 * distinction is the one this repo keeps having to rediscover.
 *
 * ## The lists must be EXACT, and that churn is the point
 *
 * Their union must equal the live unentried set — not contain it. A stale
 * name is how a cap accumulates slack until it stops meaning anything, so a
 * batch that adds entries MUST delete those names here, and the diff is then
 * the record of progress. An entry for a code nothing throws fails too:
 * `THREAD_CLOSED` was nominated for translation from a spec sentence that
 * documents its REMOVAL.
 */
import { readCatalogue } from '../helpers/catalogue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Codes that must NEVER get an entry, with the reason.
 *
 * An entry REPLACES `message` for every site of that code, in every locale,
 * so a code whose wording is composed per-site cannot have one.
 */
const DELIBERATELY_UNENTRIED: ReadonlyArray<[code: string, why: string]> = [
    [
        'FILE_TYPE_NOT_ALLOWED',
        'Five sites, and one passes a CALLER-SUPPLIED reason (`extraRejection` from ' +
            '`opts.extraCheck`) — an entry would replace "avatars must be square" with a generic sentence.',
    ],
    [
        'INVALID_LIMIT',
        'Three sites, three sentences, and what distinguishes them is in the English template rather ' +
            'than on the wire: a caller-supplied `opts.label` plus the received value. Fixable by passing ' +
            '`{ reason }` as a param and writing a variant table — a change to a validator every list ' +
            'endpoint shares, so not a catalogue batch.',
    ],
];

/** Codes with no entry yet. SHRINK ONLY — delete a name when you add its entry. */
const BACKLOG: ReadonlyArray<string> = [
    'ACCOUNT_ALREADY_ERASED',
    'ACCOUNT_HAS_NO_EMAIL',
    'AI_BUDGET_REQUIRES_VERIFIED_FARM',
    'API_KEY_FAMILY_NOT_ENABLED',
    'API_KEY_NOT_PERSON_SCOPED',
    'API_KEY_WRONG_SURFACE',
    'BLOCK_SELLER_ONLY',
    'CROP_PLAN_NOT_READY',
    'CROP_SEASON_YEAR_INVALID',
    'CROP_TYPE_INVALID',
    'CROP_TYPE_NAME_REQUIRED',
    'DOSE_UNIT_HAS_NO_BASE',
    'DOSE_UNIT_NOT_FOUND',
    'DUPLICATE_COMMODITY',
    'EIK_INVALID',
    'EIK_LOOKS_LIKE_EGN',
    'FARM_BRAND_CONSENT_REQUIRED',
    'FARM_BRAND_DISPLAY_NAME_REQUIRED',
    'FARM_BRAND_HANDLE_REQUIRED',
    'FARM_BRAND_NOT_FOUND',
    'FARM_BRAND_NOT_PUBLISHED',
    'FARM_HANDLE_TAKEN',
    'FARM_NAME_NOT_SLUGGABLE',
    'FARM_NAME_REQUIRED',
    'FARM_NAME_TOO_LONG',
    'FARM_PROFILE_EIK_NOT_EDITABLE',
    'FARM_SLUG_UNAVAILABLE',
    'FERTILIZER_EXPECTED',
    'FIELD_OPERATION_NOT_FOUND',
    'FILE_VALIDATION_ERROR',
    'IDEMPOTENCY_KEY_INVALID',
    'IF_MATCH_EMPTY',
    'IF_MATCH_MALFORMED',
    'IF_MATCH_WEAK_TAG',
    'IMPORT_JOB_NOT_FOUND',
    'INSURANCE_PRODUCT_UNKNOWN',
    'INSURANCE_QUOTE_INVALID',
    'INVALID_ASSET',
    'INVALID_CROP_TYPE',
    'INVALID_EQUIPMENT',
    'INVALID_FARM_PAYLOAD',
    'INVALID_FARM_TASK_TYPE',
    'INVALID_FILE',
    'INVALID_LINK',
    'INVALID_LOCATION',
    'INVALID_PARCEL',
    'INVALID_PLANTING',
    'INVALID_REVIEW_ACTION',
    'INVALID_SEASON',
    'INVALID_TAB_ORDER',
    'INVALID_TASK',
    'INVALID_VARIETY',
    'ITEM_NAME_ALREADY_EXISTS',
    'LEASE_PAYMENT_NOT_FOUND',
    'LISTING_INTEREST_ALREADY_SENT',
    'MESSAGE_EMPTY',
    'MESSAGE_NOT_SENDER',
    'MESSAGE_TOO_LONG',
    'NOTES_TOO_LONG',
    'NOT_A_FIELD_OPERATION_TASK',
    'OPERATOR_SCOPE',
    'OVERRIDE_DENOMINATION_CHANGED',
    'PARCELS_NOT_IN_LOCATION',
    'PAST_DUE_RESTRICTED',
    'PESTICIDE_REGULATORY_FIELDS_REQUIRED',
    'PRODUCT_IS_SAMPLE_ARCHETYPE',
    'PRODUCT_NAME_REQUIRED',
    'TASK_NOT_AWAITING_REVIEW',
    'THREAD_BLOCKED',
    'THREAD_NOT_A_PARTY',
    'THREAD_OWN_LISTING',
    'UNKNOWN_COMMODITY',
    'UNSUPPORTED_FILE_TYPE',
    'VARIETY_NAME_REQUIRED',
    'WATER_RATE_UNIT_NOT_FOUND',
    'WATER_RATE_UNIT_REQUIRED',
    'WEED_ENTRIES_TOO_MANY',
    'WEED_NAME_TOO_LONG',
    'WRITE_FORBIDDEN_FOR_ROLE',
];

/**
 * Every `coded*('CODE'` in `src/`, comments blanked, spec prose excluded.
 *
 * Through `collectSourceFiles` rather than a hand-rolled walk, because
 * `file-collection-is-not-silently-empty` is right about the failure it
 * prevents: a hand-rolled collector can be gutted to return `[]` with every
 * assertion built on it still green — measured at 81% of the guards an
 * automated sweep could audit. The `floor` is what makes "found nothing"
 * different from "nothing is wrong", and this guard's whole value is its
 * denominator.
 */
function thrownCodes(): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>();
    const files = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });
    for (const full of files) {
        // `src/lib/openapi/` DOCUMENTS codes in prose, including retired
        // ones. A code mentioned there is not a code anything throws.
        if (full.includes(join('src', 'lib', 'openapi'))) continue;
        const code = blankNonCode(readFileSync(full, 'utf8'));
        for (const m of code.matchAll(/coded[A-Za-z]*\s*\(\s*'([A-Z][A-Z0-9_]{3,})'/g)) {
            if (!found.has(m[1])) found.set(m[1], new Set());
            found.get(m[1])!.add(full.slice(REPO_ROOT.length + 1));
        }
    }
    return found;
}

const bg = readCatalogue('bg') as {
    errors?: Record<string, unknown>;
};
const ENTRIED = new Set(Object.keys(bg.errors ?? {}));
const thrown = thrownCodes();
const unentried = [...thrown.keys()].filter((c) => !ENTRIED.has(c)).sort();
const excused = new Set([...DELIBERATELY_UNENTRIED.map(([c]) => c), ...BACKLOG]);

describe('a new refusal code ships with its Bulgarian entry (#1677)', () => {
    it('ranges over every thrown code — the denominators', () => {
        console.log(
            `[code-entry] ${thrown.size} code(s) thrown in src, ${thrown.size - unentried.length} entried, ` +
                `${unentried.length} not — ${BACKLOG.length} backlog + ${DELIBERATELY_UNENTRIED.length} deliberate`,
        );
        // A floor, so a refactor that stops finding call sites fails loudly
        // instead of passing over an empty population.
        expect(thrown.size).toBeGreaterThan(150);
    });

    it('the detector sees a real code — the control it needs', () => {
        // Multi-line calls included: `MFA_CODE_INVALID` has its code on its
        // own line, and an earlier version of this scan missed exactly those.
        expect(thrown.has('TENANT_NOT_FOUND')).toBe(true);
        expect(thrown.has('MFA_CODE_INVALID')).toBe(true);
        expect(ENTRIED.has('TENANT_NOT_FOUND')).toBe(true);
        // And a code mentioned ONLY in spec prose is not "thrown".
        expect(thrown.has('THREAD_CLOSED')).toBe(false);
    });

    it('no NEW code lacks an entry', () => {
        const fresh = unentried
            .filter((c) => !excused.has(c))
            .map((c) => `  ${c} — thrown at ${[...thrown.get(c)!].join(', ')}, no errors.${c} in messages/bg.json`);
        expect(fresh.join('\n')).toBe('');
    });

    it('both lists are exact — no name outlives what it excuses', () => {
        // A grandfathered name that has since been entried, or whose code is
        // gone, must be deleted. Otherwise the list accumulates slack until
        // it stops describing anything.
        const stale = [...excused]
            .filter((c) => !unentried.includes(c))
            .map((c) => `  ${c} — ${ENTRIED.has(c) ? 'now HAS an entry; delete it from the list' : 'no longer thrown anywhere; delete it'}`);
        expect(stale.sort().join('\n')).toBe('');
    });

    it('a deliberate exclusion carries a reason long enough to be one', () => {
        for (const [code, why] of DELIBERATELY_UNENTRIED) {
            // A one-word "why" is how a decision becomes folklore.
            expect(`${code}: ${why.length > 80}`).toBe(`${code}: true`);
        }
    });
});
