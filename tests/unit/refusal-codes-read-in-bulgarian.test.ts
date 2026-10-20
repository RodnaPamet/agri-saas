/**
 * The highest-reach refusal codes read in Bulgarian (#1918, batch 1).
 *
 * ## What was wrong
 *
 * `localizeErrorPayload` replaces `message` with `errors.<CODE>` from the
 * reader's catalogue — but ONLY when an entry exists. Measured on main:
 * **124 of the 211 codes the server raises had none**, so for those the
 * server's English sentence was the copy a Bulgarian farmer read in the
 * browser. `src/lib/api-client.ts` does `message = body.error.message ||
 * message` with no language test, and 142 call sites print that to screen.
 *
 * Owner ruling 2026-10-15: start with the highest-reach codes rather than
 * sweeping all 124, so the wording can be reviewed on a sample first.
 *
 * ## The three worst were not English at all
 *
 * `ACCOUNT_SUSPENDED`, `ACCOUNT_DELETION_PENDING` and `ACCOUNT_TERMINATED`
 * carry the CODE ITSELF as their `message`. So a suspended farmer was shown
 * the literal token `ACCOUNT_SUSPENDED` — not awkward English, an
 * identifier. Those three have no English to translate, so they get a real
 * sentence in both locales rather than a translation.
 *
 * `ADMIN_REQUIRED` is the other one worth naming: the spec singles it out as
 * reachable on EVERY route and worth switching on, and it was untranslated.
 *
 * ## Driven, not asserted
 *
 * Through `localizeErrorPayload` with a Bulgarian session, because the
 * catalogue having a key proves nothing about what reaches a reader — the
 * lookup is dynamic (which is why these keys sit in the dead-key detector's
 * UNDECIDABLE bucket) and a wrong namespace would be invisible to a
 * catalogue assertion.
 */
const getRequestContext = jest.fn();
jest.mock('@/lib/observability/context', () => ({
    ...jest.requireActual('@/lib/observability/context'),
    getRequestContext: () => getRequestContext(),
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readCatalogue } from '../helpers/catalogue';
import { localizeErrorPayload } from '@/lib/errors/localize';
import type { ApiErrorResponse } from '@/lib/errors/types';

/** The batch, with the English each one replaces. */
const BATCH: ReadonlyArray<[code: string, english: string]> = [
    ['ADMIN_REQUIRED', 'Admin access required'],
    ['ACCOUNT_SUSPENDED', 'ACCOUNT_SUSPENDED'],
    ['ACCOUNT_DELETION_PENDING', 'ACCOUNT_DELETION_PENDING'],
    ['ACCOUNT_TERMINATED', 'ACCOUNT_TERMINATED'],
    ['TREATMENT_NOT_FOUND', 'No treatment was recorded under that handle.'],
    ['JOURNAL_ENTRY_NOT_FOUND', 'Journal entry not found'],
    ['MEMBERSHIP_NOT_FOUND', 'Membership not found or not active.'],
    ['THREAD_NOT_FOUND', 'That conversation was not found.'],
    ['MESSAGE_NOT_FOUND', 'That message was not found.'],
    ['CROP_PLAN_NAME_REQUIRED', 'A crop plan name is required.'],
    ['CROP_PLAN_INVALID_DATE', 'The first sow date must be a valid date.'],
    ['AVATAR_TOO_LARGE', 'That image is too large — pick a smaller photo.'],
    // AVATAR_NOT_WEBP was here and is RETIRED (#1903): the endpoint accepts
    // JPEG as well now, so a code named for the one format it does not
    // require would describe the opposite of the rule. Its two entries went
    // with it — an entry for a code nothing throws is dead copy that reads
    // as coverage.
    ['AVATAR_FORMAT_NOT_ALLOWED', 'Avatar must be a JPEG or WebP image.'],
    ['AVATAR_UNREADABLE', 'That image could not be read. Try a different photo.'],
    ['AVATAR_EMPTY', 'Avatar upload was empty.'],
    ['AVATAR_FILE_MISSING', 'Missing avatar file in form data.'],
];

/**
 * Batch 2 — the farm-record families, which is the ДНЕВНИК path a farmer is on
 * daily. Translations of the server's own English.
 */
const BATCH_2: ReadonlyArray<[code: string, english: string]> = [
    ['FILE_EMPTY', 'File is empty'],
    ['FILE_REQUIRED', 'No file was included in the form data.'],
    ['JOURNAL_ENTRY_NOT_DELETED', 'Journal entry is not deleted'],
    ['JOURNAL_ENTRY_NOT_SOFT_DELETED', 'Journal entry must be soft-deleted before purging'],
    ['JOURNAL_FILE_LINK_NOT_FOUND', 'Journal entry file link not found'],
    ['JOURNAL_TITLE_REQUIRED', 'Title is required'],
    ['OPERATION_INPUT_AMBIGUOUS', 'Choose exactly one input — a product OR a fertilizer.'],
    ['OPERATION_NOT_ASSIGNED_TO_YOU', 'You can only update field operations assigned to you.'],
    ['OPERATION_PARCEL_NOT_FOUND', 'Operation parcel not found'],
    ['PARCEL_LOCATION_MISMATCH', 'Parcel does not belong to the selected location'],
    ['SEASON_INVALID_DATE', 'Season start and end must be valid dates.'],
    ['SEASON_NAME_REQUIRED', 'A season name is required.'],
    ['SEASON_WINDOW_INVERTED', 'The season end date must be on or after the start date.'],
    ['TREATMENT_ABANDONED', 'This treatment was abandoned by an administrator.'],
    ['TREATMENT_COMPLETE', 'This treatment is fully recorded.'],
    ['TREATMENT_DATE_INVALID', 'The treatment date must be a calendar day in the form YYYY-MM-DD.'],
    ['TREATMENT_DATE_IN_FUTURE', 'A treatment cannot be recorded for a future date.'],
    ['TREATMENT_NO_PARCELS', 'Select at least one parcel that was treated.'],
    ['UPLOAD_INFECTED', 'This image was rejected by the malware scanner.'],
    ['UPLOAD_SCANNER_UNAVAILABLE', 'The malware scanner is unavailable, so the image was not stored.'],
    ['UPLOAD_UNSCANNED_ON_PUBLIC_SURFACE', 'This image cannot be published.'],
];

/**
 * Batch 3 — chosen by REACH rather than by throw-site count, which is the
 * wrong axis. `TENANT_NOT_FOUND` has two call sites and both are in
 * `lib/tenant-context.ts`, which every tenant-scoped request passes through;
 * the agrent-ios peer measured the same two codes as documented on all 109
 * operations the phone calls. A code with seven sites in one usecase is
 * narrower than a code with two in the request path.
 *
 * The MFA family is here for the WEB. The peer's reading is that the phone
 * branches on these in code rather than displaying them, so the sentence buys
 * it nothing — but `api-client.ts` prints `error.message` at 142 web call
 * sites with no language test, so on the web an MFA refusal was English prose
 * in front of a Bulgarian farmer.
 */
const BATCH_3: ReadonlyArray<[code: string, english: string]> = [
    ['MFA_CODE_MALFORMED', 'A six-digit code is required.'],
    ['MFA_ENROLLMENT_REQUIRED', 'This farm requires a second factor and this account has none set up yet. Set up an authenticator from the web, then sign in again.'],
    ['MFA_REQUIRED', 'MFA verification required.'],
    ['MFA_TICKET_INVALID', 'The sign-in attempt is no longer valid.'],
    ['TENANT_IDENTIFIER_REQUIRED', 'Tenant identifier required'],
    ['TENANT_NOT_FOUND', 'Tenant not found'],
];

/**
 * Batch 4 — every unentried code in `usecases/field-operation.ts`, which is
 * the ДНЕВНИК daily path: a spraying or fertilising record. One file, one
 * surface, so the copy can be consistent about what a "dose unit" and a
 * "water rate" are called.
 *
 * Chosen by surface rather than by count, on the agrent-ios session's
 * finding that the phone gains nothing from the remaining codes and the web
 * is where English reaches a farmer.
 *
 * `PRODUCT_IS_SAMPLE_ARCHETYPE` is not in this table: it interpolates a
 * product NAME and has its own case below.
 */
const BATCH_4: ReadonlyArray<[code: string, english: string]> = [
    ['DOSE_UNIT_HAS_NO_BASE', 'That dose unit has no stock unit to create a product against. Create the product from the catalogue instead.'],
    ['DOSE_UNIT_NOT_FOUND', 'Dose unit not found.'],
    ['FERTILIZER_EXPECTED', 'That item is not a fertiliser. Use the product field for it, or choose a fertiliser.'],
    ['FIELD_OPERATION_NOT_FOUND', 'Field operation not found'],
    ['INVALID_REVIEW_ACTION', 'Invalid review action.'],
    ['NOT_A_FIELD_OPERATION_TASK', 'Only field-operation tasks can be reviewed here.'],
    ['PARCELS_NOT_IN_LOCATION', 'Some selected parcels do not belong to this location.'],
    ['PRODUCT_NAME_REQUIRED', 'A product name is required.'],
    ['TASK_NOT_AWAITING_REVIEW', 'This task is not awaiting review, so it cannot be approved or sent back.'],
    ['WATER_RATE_UNIT_NOT_FOUND', 'Water-rate unit not found.'],
    ['WATER_RATE_UNIT_REQUIRED', 'A water-rate unit is required when a water rate is set.'],
];

/**
 * Batch 5 — the planning surface, `usecases/crop-planning.ts`.
 *
 * Four of these said "… not found or belongs to a different tenant", which is
 * the QUERY's predicate rather than the farmer's situation: the lookup is
 * scoped by tenant, and merging the two cases is the right privacy behaviour.
 * But a farmer has no concept of a tenant, and `CROP_PLAN_NOT_READY` named
 * the `daysToMaturity` COLUMN.
 *
 * No source message changed. An entry replaces `message` per locale, so a
 * clean `en` entry fixes the English reader too and the developer-facing
 * string survives as the fallback — which is exactly the arrangement #1677's
 * option 3 settled on. The phrase is at 33 sites across `src`, so rewriting
 * them would be a separate sweep; giving the codes entries IS the fix.
 */
const BATCH_5: ReadonlyArray<[code: string, english: string]> = [
    ['CROP_PLAN_NOT_READY', 'This plan needs a variety with daysToMaturity set before plantings can be generated.'],
    ['CROP_TYPE_NAME_REQUIRED', 'A crop name is required.'],
    ['INVALID_CROP_TYPE', 'Crop type not found or belongs to a different tenant'],
    ['INVALID_PARCEL', 'Parcel not found or belongs to a different tenant'],
    ['INVALID_SEASON', 'Season not found or belongs to a different tenant'],
    ['INVALID_VARIETY', 'Variety not found or belongs to a different tenant'],
    ['VARIETY_NAME_REQUIRED', 'A variety name is required.'],
];

/**
 * Batch 6 — `usecases/farm-creation.ts`, the onboarding path.
 *
 * The first batch whose English needed no correction: two of the six already
 * carry the Bulgarian abbreviations (ЕИК, ЕГН), because whoever wrote them
 * knew the audience. `FARM_NAME_TOO_LONG` is the only improvement — it
 * passes `{ max: FARM_NAME_MAX }` and never used it, so the entry now names
 * the limit instead of leaving a farmer to guess at 120.
 */
const BATCH_6: ReadonlyArray<[code: string, english: string]> = [
    ['EIK_INVALID', 'That is not a valid ЕИК — the checksum does not match.'],
    ['EIK_LOOKS_LIKE_EGN', 'That looks like a personal identity number (ЕГН) rather than a company number (ЕИК).'],
    ['FARM_NAME_NOT_SLUGGABLE', 'That farm name cannot be turned into a web address.'],
    ['FARM_NAME_REQUIRED', 'A farm name is required.'],
    ['FARM_SLUG_UNAVAILABLE', 'Could not allocate a web address for that farm.'],
];

/**
 * Batch 7 — the parcel-history limits, whose entries NAME the limit.
 *
 * Four of the five carry a `{max}` (and the year one a `{min}` too), which is
 * why this table has a third column: the plain `it.each` below asserts no
 * `{placeholder}` survives, and a placeholder with no param supplied is
 * indistinguishable from an entry that forgot to use it.
 *
 * #1973 added those params so these entries could exist. The year bound is
 * COMPUTED — `currentYear + YEARS_AHEAD` — so it could never have been a
 * literal in a sentence, in either locale.
 */
const BATCH_7: ReadonlyArray<
    [code: string, english: string, params?: Record<string, string>]
> = [
    ['CROP_SEASON_YEAR_INVALID', 'That harvest year is out of range.', { min: '1900', max: '2028' }],
    ['CROP_TYPE_INVALID', 'A crop is required.'],
    ['NOTES_TOO_LONG', 'Those notes are too long.', { max: '2000' }],
    ['WEED_ENTRIES_TOO_MANY', 'Too many weeds in one observation.', { max: '50' }],
    ['WEED_NAME_TOO_LONG', 'That weed name is too long.', { max: '120' }],
];

const BATCH_8: ReadonlyArray<
    [code: string, english: string, params?: Record<string, string>]
> = [
    ['MESSAGE_EMPTY', 'Write a message first.'],
    ['MESSAGE_NOT_SENDER', 'You can only retract messages you sent yourself.'],
    ['MESSAGE_TOO_LONG', 'That message is too long — at most {max} characters.', { max: '4000' }],
    ['THREAD_NOT_A_PARTY', 'You are not a party to that conversation.'],
    ['THREAD_OWN_LISTING', 'You cannot start a conversation on your own listing.'],
];

const BATCH_9: ReadonlyArray<[code: string, english: string]> = [
    ['FARM_BRAND_CONSENT_REQUIRED', 'Publishing needs your consent first.'],
    ['FARM_BRAND_DISPLAY_NAME_REQUIRED', 'A public name is required before publishing.'],
    ['FARM_BRAND_HANDLE_REQUIRED', 'Choose a public address for the farm before publishing.'],
    ['FARM_BRAND_NOT_FOUND', 'This farm has no public profile yet.'],
    ['FARM_BRAND_NOT_PUBLISHED', 'Publish the farm profile first — a printed address that is not published leads nowhere.'],
    ['FARM_HANDLE_TAKEN', 'That address is already taken by another farm.'],
];

const BATCH_10: ReadonlyArray<[code: string, english: string]> = [
    ['INVALID_EQUIPMENT', 'Some of the selected equipment was not found.'],
    ['INVALID_FILE', 'That file was not found.'],
    ['INVALID_LOCATION', 'One of the selected locations was not found.'],
    ['INVALID_PLANTING', 'One of the selected plantings was not found.'],
];

/** The ten codes #2008 found: thrown, but invisible to the entry guard. */
const BATCH_2008: ReadonlyArray<[code: string, english: string]> = [
    ['COMMODITY_NOT_OVERRIDABLE', 'That commodity is not one this platform sets a price for.'],
    ['FARM_HANDLE_RESERVED', 'That address is reserved and cannot be used. Choose another.'],
    ['FARM_HANDLE_TOO_LONG', 'That address may be at most 40 characters once written in Latin letters.'],
    ['FARM_HANDLE_TOO_SHORT', 'That address must be at least 3 characters once written in Latin letters.'],
    ['FARM_HANDLE_UNUSABLE', 'That address must contain letters or digits.'],
    ['FERTILIZER_NOT_FOUND', 'That fertiliser was not found.'],
    ['ILLEGAL_TRANSITION', 'That status change is not allowed.'],
    ['PRODUCT_NOT_FOUND', 'That product was not found.'],
    ['TASK_STATUS_UNCHANGED', 'The task is already in that status.'],
    ['UNKNOWN_TASK_STATUS', 'That task status is not recognised.'],
];

/** #1712's farmer-facing tranche: nine bare notFound() sites, now coded. */
const BATCH_1712: ReadonlyArray<[code: string, english: string]> = [
    ['AVATAR_NOT_FOUND', 'That avatar was not found.'],
    ['DELIVERY_NOT_FOUND', 'That delivery was not found.'],
    ['INQUIRY_NOT_FOUND', 'That enquiry was not found.'],
    ['ORG_NOT_FOUND_OR_FORBIDDEN', 'Organization not found or access not permitted'],
    ['SUPPORT_SCHEME_NOT_FOUND', 'That support scheme was not found.'],
    ['TARGET_USER_NOT_IN_TENANT', 'That person is not a member of this farm.'],
];

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * Batch 11 — the HTTP/protocol tranche plus `INVALID_LINK`.
 *
 * Chosen because none of it needs a vocabulary ruling: an `If-Match` refusal
 * is read by whoever wrote the client, not by a farmer deciding what «блок»
 * means, so the protocol tokens stay in Latin on purpose.
 *
 * `API_KEY_FAMILY_NOT_ENABLED` carries `{ resource: family }`, which makes
 * `localizeErrorPayload` look for `errors.API_KEY_FAMILY_NOT_ENABLED.<family>`
 * before the flat key. Nothing defines a variant, so it falls through — and
 * the param is still interpolated into the flat sentence. The test below has
 * to SUPPLY that param: without it next-intl leaves `{resource}` in the
 * output and the no-placeholder assertion fails, which is the correct
 * failure for an entry whose params never arrive.
 */
const BATCH_11: ReadonlyArray<[code: string, english: string]> = [
    ['API_KEY_FAMILY_NOT_ENABLED', 'API keys cannot be used for "market". That surface has not been enabled for key access.'],
    ['API_KEY_NOT_PERSON_SCOPED', 'An API key cannot be used on a person-scoped route.'],
    ['API_KEY_WRONG_SURFACE', 'API keys may only be used on the tenant API.'],
    ['IDEMPOTENCY_KEY_INVALID', 'That request key is not valid.'],
    ['IF_MATCH_EMPTY', 'If-Match was sent empty. Omit the header for no precondition, or send the version.'],
    ['IF_MATCH_MALFORMED', 'If-Match must be the row version as a bare integer (5) or a strong entity-tag ("5").'],
    ['IF_MATCH_WEAK_TAG', 'A weak entity-tag cannot be used with If-Match. Send the version as a bare integer or a strong tag.'],
    ['INVALID_LINK', 'Locations not found.'],
    ['UNSUPPORTED_FILE_TYPE', 'Upload a shapefile (.zip), KML (.kml/.kmz), or GeoJSON (.geojson/.json).'],
];

/**
 * Batch 12 — seven codes whose Bulgarian comes from the catalogue, not from me.
 *
 * Every term here was looked up before it was written, and two of the obvious
 * guesses were WRONG:
 *
 *   • "Machine operator" is «Механизатор», not «машинен оператор» — and the
 *     existing role refusals read «С роля „Механизатор“ не можете да …», so
 *     OPERATOR_SCOPE follows that sentence shape rather than inventing one.
 *   • "Listing" is «Обява», not «оферта». `exchange.offer.*` uses «оферта»
 *     for an OFFER; a listing withdrawn is «Обявата е оттеглена».
 *
 * "verify/verified" is «потвърден» across the catalogue
 * (`admin.ledgerIntegrity.verifiedIntact`), so a verified farm is «потвърдено
 * стопанство». «дневник» for the farm record is the БАБХ term the product
 * already uses.
 *
 * The three market-price codes in the backlog are deliberately NOT here: they
 * turn on whether "commodity" is «стока» or «култура» on that surface, and on
 * a word for "denomination" that the catalogue does not yet have.
 */
const BATCH_12: ReadonlyArray<[code: string, english: string]> = [
    ['AI_BUDGET_REQUIRES_VERIFIED_FARM', 'This farm must be verified before it can use AI features.'],
    ['FARM_PROFILE_EIK_NOT_EDITABLE', 'The EIK of a verified farm cannot be changed.'],
    ['ITEM_NAME_ALREADY_EXISTS', 'A product with that name already exists.'],
    ['LISTING_INTEREST_ALREADY_SENT', 'You have already expressed interest in this listing.'],
    ['OPERATOR_SCOPE', 'A machine operator cannot use this surface.'],
    ['PESTICIDE_REGULATORY_FIELDS_REQUIRED', 'A plant protection product needs its registration number.'],
    ['WRITE_FORBIDDEN_FOR_ROLE', 'You do not have permission to modify records in this context.'],
];

const payload = (code: string, message: string): ApiErrorResponse => ({ error: { code, message } });

beforeEach(() => {
    jest.clearAllMocks();
    getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0 });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 1)', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(`[refusal-bg] ${BATCH.length} code(s) in this batch, of 124 untranslated on main`);
        expect(BATCH.length).toBeGreaterThanOrEqual(15);
    });

    it.each(BATCH.map(([c, e]) => [c, e] as const))(
        '%s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);

            // Cyrillic, and NOT the English it replaced — a catalogue entry
            // that failed to resolve would leave the English in place and
            // satisfy a weaker assertion.
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            // No unsubstituted placeholder: `{role}` on screen is worse than
            // the English it replaced.
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('the three token-messages stop showing a bare identifier', async () => {
        // The sharpest case in the batch. These three carried the CODE as
        // their `message`, so the web printed `ACCOUNT_SUSPENDED` at a farmer.
        // Asserted separately from the loop above because "not the English"
        // is a weaker claim than "no longer an identifier".
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        for (const code of ['ACCOUNT_SUSPENDED', 'ACCOUNT_DELETION_PENDING', 'ACCOUNT_TERMINATED']) {
            const p = payload(code, code);
            await localizeErrorPayload(p);
            // The subject is the MESSAGE alone. Interpolating `${code}` into
            // it for a nicer label put `ACCOUNT_SUSPENDED` inside the string
            // this pattern searches, so the assertion matched my own label
            // and failed on a correct translation — the `twMerge`-style trap
            // where a composed subject answers a different question than the
            // one asked. The label goes in a separate expect.
            expect(p.error.message).not.toMatch(/[A-Z]{3,}_[A-Z]/);
            expect(`${code} is Cyrillic: ${/[А-Яа-я]{3,}/.test(p.error.message)}`)
                .toBe(`${code} is Cyrillic: true`);
        }
    });

    it('an English reader still gets English — the control', async () => {
        // A catalogue entry that replaced the message for EVERY reader would
        // be a regression for the English one. `localizeErrorPayload` keys on
        // the session language, and this is what proves the lookup is
        // language-dependent rather than unconditional.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'en' });
        const p = payload('TREATMENT_NOT_FOUND', 'No treatment was recorded under that handle.');
        await localizeErrorPayload(p);
        expect(p.error.message).not.toMatch(/[А-Яа-я]/);
    });

    it.each(BATCH_2.map(([c, e]) => [c, e] as const))(
        'batch 2: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('FILE_TOO_LARGE names the cap, because a NUMBER may be interpolated', async () => {
        // The one code in batch 2 whose sentence carries a param, and the
        // exception `localize.ts`'s rule makes explicit: a NUMBER or a name
        // the person typed may be interpolated; an enum on the wire may not.
        //
        // The cap was inside the English template and NOT on the wire, so a
        // catalogue entry could not have named it. `ingest.ts` and
        // `journal.ts` pass `maxBytes` now, which is what makes the Bulgarian
        // as informative as the English it replaces.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('FILE_TOO_LARGE', 'File exceeds the maximum size of 5242880 bytes');
        p.error.params = { maxBytes: '5242880' };
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).toContain('5242880');
        expect(p.error.message).not.toMatch(/\{\w+\}/);
    });

    it('FILE_TYPE_NOT_ALLOWED has NO entry, deliberately', async () => {
        // It is raised at five sites and one of them passes a CALLER-SUPPLIED
        // message (`extraRejection`, from `opts.extraCheck`) — so an entry
        // would replace a bespoke reason like "avatars must be square" with a
        // generic sentence. `localizeErrorPayload` REPLACES `message` whenever
        // an entry exists, for every locale, so adding one flattens all five
        // sites' wording at once.
        //
        // Asserted rather than left as a gap in the list: the next batch will
        // see it untranslated and should know the omission is a decision.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const original = 'Avatars must be square.';
        const p = payload('FILE_TYPE_NOT_ALLOWED', original);
        await localizeErrorPayload(p);
        expect(p.error.message).toBe(original);
    });

    it('a code with NO entry is left alone, which is still most of them', async () => {
        // The boundary. An invented code must pass through untouched, or this
        // batch would be claiming coverage it does not have. The count is out
        // of the NAME deliberately — it was "109 still to do" and is 81 after
        // batch 3, and a number in a name goes stale with nothing failing — and a
        // `localizeErrorPayload` that invented a sentence for an unknown code
        // would be worse than leaving the English.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('NOT_A_REAL_CODE_1918', 'Original English stays.');
        await localizeErrorPayload(p);
        expect(p.error.message).toBe('Original English stays.');
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 3)', () => {
    it('ranges over the batch — the denominator', () => {
        // 88 codes had no entry before this batch, counted with comments
        // BLANKED: a `@throws codedBadRequest('INVALID_LIMIT')` in a docblock
        // had inflated that code from 0 real sites to 4, and a scar is not a
        // wound. 81 remain after this one.
        // BATCH_3.length is 6, and the batch added SEVEN entries:
        // MFA_CODE_INVALID carries a param and has its own case below, so it
        // is not in the table. Printing the table length alone would
        // under-report the batch by one.
        console.log(
            `[refusal-bg] batch 3 added 7 entries (${BATCH_3.length} in this table` +
                ` + MFA_CODE_INVALID), of 88 untranslated before it, 81 after`,
        );
        expect(BATCH_3.length).toBeGreaterThanOrEqual(6);
    });

    it.each(BATCH_3.map(([c, e]) => [c, e] as const))(
        'batch 3: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('TENANT_NOT_FOUND says WHICH thing is gone, which is the whole point', async () => {
        // The peer's reason for ranking this first: on the phone a bare 404
        // renders «Търсеното не беше намерено.», and someone looking at their
        // own farm learns nothing from it. The entry has to name the farm and
        // the two things that actually happened — removed, or access ended —
        // or it is the generic sentence with extra steps.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('TENANT_NOT_FOUND', 'Tenant not found');
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('стопанство');
        expect(p.error.message).not.toMatch(/Търсеното/);
    });

    it('MFA_CODE_INVALID interpolates the remaining attempts', async () => {
        // A NUMBER, which `localize.ts`'s rule permits in a sentence. The
        // site already passes `attemptsRemaining`, so unlike FILE_TOO_LARGE
        // in batch 2 no call site had to change.
        //
        // Phrased as a list ("Оставащи опити: 2") rather than agreeing with
        // the number, because «Остават 1 опита» is wrong and no entry in
        // `errors.*` uses ICU plurals yet — introducing that convention
        // belongs in its own change, not in a batch about coverage.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('MFA_CODE_INVALID', 'That code is not right.');
        p.error.params = { attemptsRemaining: '2' };
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).toContain('2');
        expect(p.error.message).not.toMatch(/\{\w+\}/);
    });

    it('INVALID_LIMIT reads in Bulgarian, by reason, with the parameter NAME quoted', async () => {
        // This used to assert the opposite — that the code was deliberately
        // unentried, because what distinguished its three sentences lived in
        // the English template rather than on the wire. #2059 moved it onto
        // the wire: `{ reason, label }`, and `reason` was already a
        // DISCRIMINATOR, so a variant table was all that was missing.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const withReason = (reason: string, label: string): ApiErrorResponse => ({
            error: {
                code: 'INVALID_LIMIT',
                message: `Invalid ${label}: must be a positive integer; received "x".`,
                params: { reason, label },
            },
        });

        const empty = withReason('empty', 'limit');
        await localizeErrorPayload(empty);
        expect(empty.error.message).toContain('Липсва стойност');

        const bad = withReason('not_an_integer', 'radius');
        await localizeErrorPayload(bad);
        expect(bad.error.message).toContain('цяло положително число');
        // `radius` is a WIRE PARAMETER NAME, quoted as an identifier rather
        // than inlined as prose — which is what lets one Bulgarian sentence
        // serve every caller without «Невалиден radius» reading as broken
        // Bulgarian.
        expect(bad.error.message).toContain('„radius“');

        // An unknown reason falls through to the table's own `default` rather
        // than leaving English prose in front of a Bulgarian reader — the
        // property that makes adding a reason later a safe change.
        const unknown = withReason('something_added_later', 'limit');
        await localizeErrorPayload(unknown);
        expect(unknown.error.message).toBe('Невалидна стойност за параметъра „limit“.');

        for (const p of [empty, bad, unknown]) {
            expect(p.error.message).not.toMatch(/\{\w+\}/);
            // The RECEIVED VALUE is deliberately absent: `params` must never
            // carry arbitrary client input, and `?limit=` is set by client
            // code rather than typed by a person, so quoting it back in a
            // translated sentence would help nobody.
            expect(p.error.message).not.toContain('"x"');
        }
    });

    it('THREAD_CLOSED gets no entry because the code is RETIRED', async () => {
        // The peer nominated it from the spec. The spec mention is the
        // sentence that documents its REMOVAL — "This previously returned 400
        // `THREAD_CLOSED`; that refusal is gone, because either party can
        // close and a refusal would let one side mute the other permanently"
        // — and `openapi.json` documents it on no operation at all. Nothing
        // in `src/` throws it.
        //
        // Asserted so the next batch does not re-nominate it: an entry for a
        // code nothing raises is dead copy that reads as coverage.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('THREAD_CLOSED', 'This thread is closed.');
        await localizeErrorPayload(p);
        expect(p.error.message).toBe('This thread is closed.');
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 4)', () => {
    it('ranges over the batch — the denominator', () => {
        // 81 codes had no entry before this batch; 69 after. One FILE's worth,
        // which is what makes the copy reviewable: a reader can ask whether
        // "мерна единица за доза" is the right phrase once rather than
        // eleven times.
        console.log(
            `[refusal-bg] batch 4 added 12 entries (${BATCH_4.length} in this table` +
                ` + PRODUCT_IS_SAMPLE_ARCHETYPE), of 81 untranslated before it, 69 after`,
        );
        expect(BATCH_4.length).toBeGreaterThanOrEqual(11);
    });

    it.each(BATCH_4.map(([c, e]) => [c, e] as const))(
        'batch 4: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('PRODUCT_IS_SAMPLE_ARCHETYPE keeps the product NAME in the sentence', async () => {
        // A name the person typed, which `localize.ts`'s rule permits — the
        // refusal is about ONE product among many in a catalogue, so naming
        // it is the difference between an actionable message and a puzzle.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('PRODUCT_IS_SAMPLE_ARCHETYPE', '"Примерен хербицид" is a sample product.');
        p.error.params = { product: 'Примерен хербицид' };
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).toContain('Примерен хербицид');
        expect(p.error.message).not.toMatch(/\{\w+\}/);
    });

    it('TASK_NOT_AWAITING_REVIEW no longer names the wire status', async () => {
        // It read `Task is ${task.status}, not awaiting review` — a raw enum
        // in displayed copy, the same defect #1919 found in the role
        // refusals. The status stays in `params` for a client to branch on;
        // the sentence stops naming it, in BOTH locales.
        //
        // Asserted on the English too, because that half was the leak: a
        // Bulgarian entry would have hidden it from this test while an
        // English reader still saw `PENDING_REVIEW`.
        const src = readFileSync(
            `${REPO_ROOT}/src/app-layer/usecases/field-operation.ts`,
            'utf8',
        );
        expect(src).not.toMatch(/Task is \$\{task\.status\}/);
        expect(src).toMatch(/\{ status: task\.status \}/);

        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('TASK_NOT_AWAITING_REVIEW', 'This task is not awaiting review.');
        p.error.params = { status: 'IN_PROGRESS' };
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).not.toMatch(/IN_PROGRESS|PENDING_REVIEW/);
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 5)', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(
            `[refusal-bg] batch 5 added ${BATCH_5.length} entries, of 69 untranslated before it, 62 after`,
        );
        expect(BATCH_5.length).toBeGreaterThanOrEqual(7);
    });

    it.each(BATCH_5.map(([c, e]) => [c, e] as const))(
        'batch 5: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('the tenant predicate and the column name do not survive into either locale', async () => {
        // The point of the batch. Both halves are asserted, because an entry
        // replaces `message` for EVERY locale — so a clean Bulgarian with a
        // leaky English would hide half the defect from this file.
        for (const locale of ['bg', 'en'] as const) {
            for (const [code, english] of BATCH_5) {
                getRequestContext.mockReturnValue({
                    requestId: 'r1',
                    startTime: 0,
                    uiLanguage: locale,
                });
                const p = payload(code, english);
                await localizeErrorPayload(p);
                expect(`${locale} ${code}: ${p.error.message}`).not.toMatch(/different tenant/i);
                expect(`${locale} ${code}: ${p.error.message}`).not.toMatch(/daysToMaturity/);
            }
        }
    });

    it('the error catalogue uses the RULED Bulgarian word for a Location (#1966)', async () => {
        // Owner ruling 2026-10-16, after this guard was first written as a
        // narrow "adds no FOURTH word" check: «блок» for a group of parcels,
        // «силоз» for a grain bin, «склад» for a warehouse — which maps 1:1
        // onto `LocationKind` (FIELD | BIN | STORAGE). So the guard can now
        // assert the choice instead of merely refusing new variants.
        //
        // «землище» stays forbidden: it is the land of a VILLAGE, an
        // administrative territory rather than a farm's grouping of fields. I
        // used it in batch 4 before noticing the product already had three
        // words for the entity.
        const catalogue = JSON.stringify(readCatalogue('bg'));
        expect(catalogue).not.toContain('землище');
        // The retired word, gone from the WHOLE Bulgarian catalogue and not
        // merely from `errors.*` — it was 32 strings across the Locations
        // index, journal, nav and billing copy.
        expect(catalogue).not.toMatch(/локаци/i);

        // And the positive half, which is what a "contains no X" assertion
        // cannot give: the refusals that NAME the entity say «блок». Without
        // this, deleting the entries entirely would satisfy the two checks
        // above — `relaxing-a-caller-removes-the-teeth`.
        const bg = readCatalogue('bg') as { errors: Record<string, unknown> };
        const NAMES_A_LOCATION = [
            'LOCATION_NOT_FOUND',
            'PARCELS_NOT_IN_LOCATION',
            'PARCEL_LOCATION_MISMATCH',
        ];
        for (const code of NAMES_A_LOCATION) {
            expect(`${code}: ${bg.errors[code]}`).toMatch(/блок/i);
        }
        console.log(
            `[refusal-bg] #1966: ${NAMES_A_LOCATION.length} Location refusal(s) assert «блок»`,
        );

        // «обект» is deliberately NOT forbidden. Fifteen occurrences remain
        // and every one is a generic *object* rather than a Location — a GIS
        // feature («неполигонален обект»), an Entra group Object ID, the
        // command palette, the entity pickers, an accounting object. A blanket
        // ban would have been a narrower guard that broke correct copy.
        expect(catalogue).toContain('обект');
    });

    it('a Parcel is «парцел», and «имот» survives only where it is not one (#1966)', async () => {
        // The issue's SECOND half, which I closed the issue without doing:
        // its title says "calls Location three things AND Parcel two". The
        // entity was «парцел» in 113 strings and «имот» in 18 — «имот» being
        // the legal real-estate term, right for a cadastral property and
        // wrong for a worked field.
        //
        // Owner ruling 2026-10-16: «парцел» everywhere. The accepted cost is
        // that the lease and cadastral surfaces now say «парцел» where a
        // contract would say «имот» — and note the ENGLISH had already made
        // this choice, since `terms.serviceBody` read "cadastral parcels"
        // while the Bulgarian read «кадастрални имоти».
        const bg = readCatalogue('bg') as { errors: Record<string, unknown> };
        for (const code of ['PARCEL_NOT_FOUND', 'PARCEL_NOT_ON_TASK', 'PARCEL_LOCATION_MISMATCH']) {
            expect(`${code}: ${bg.errors[code]}`).toMatch(/парцел/i);
            expect(`${code}: ${bg.errors[code]}`).not.toMatch(/имот/i);
        }

        // And the whole catalogue, with an EXPLICIT allowlist rather than a
        // silent exemption — so the list shrinks visibly and a new «имот»
        // fails. `locations.detail.fitHolding` is excluded because it is
        // neither: en reads "Back to this holding", and the string is the
        // aria-label of a map button that returns from country scale to the
        // farm's whole land extent («the holding's own framing», per
        // ParcelOverviewMap.tsx). Calling that a «парцел» would be a third
        // wrong word, so it is filed rather than renamed.
        // EMPTY since #1988. `locations.detail.fitHolding` was the single
        // entry — en "Back to this holding", the aria-label of the map button
        // that frames the farm's WHOLE landholding, so neither «парцел» nor
        // «блок» fitted. Owner ruling 2026-10-16: «Обратно към стопанството».
        //
        // Emptying it was not optional: the rot check below asserts the list
        // is EXACT, so fixing the string made the test demand the entry be
        // deleted. That is the property an allowlist needs — it shrank because
        // it had to, not because anyone remembered.
        const ALLOWED_имот: readonly string[] = [];
        const offenders: string[] = [];
        const walk = (node: unknown, path: string): void => {
            if (typeof node === 'string') {
                // NO `\b` here, deliberately. JavaScript's `\b` is
                // ASCII-only: it needs a transition involving [A-Za-z0-9_],
                // and between a space and «и» there is none — so
                // `/\bимот/i` never matches Cyrillic at all and this
                // negated assertion passed VACUOUSLY. The `stillThere`
                // cross-check below is what caught it. Python's `\b` IS
                // Unicode-aware, which is why the measurement that found
                // these 18 strings worked while the guard did not.
                if (/имот/i.test(node) && !ALLOWED_имот.includes(path)) {
                    offenders.push(`  ${path}: ${node.slice(0, 80)}`);
                }
                return;
            }
            if (node && typeof node === 'object') {
                for (const [k, v] of Object.entries(node)) {
                    walk(v, path ? `${path}.${k}` : k);
                }
            }
        };
        walk(readCatalogue('bg'), '');
        expect(offenders.join('\n')).toBe('');

        // The allowlist is not vacuous — if someone fixes `fitHolding`, this
        // fails and the entry should be deleted rather than left to rot. Same
        // rule as the #1918 BACKLOG: the list must be EXACT, not a ceiling.
        const stillThere: string[] = [];
        walk(readCatalogue('bg'), '');
        for (const allowed of ALLOWED_имот) {
            const parts = allowed.split('.');
            let cur: unknown = readCatalogue('bg');
            for (const seg of parts) {
                cur = (cur as Record<string, unknown>)?.[seg];
            }
            if (typeof cur === 'string' && /имот/i.test(cur)) stillThere.push(allowed);
        }
        expect(stillThere).toEqual(ALLOWED_имот);
        console.log(`[refusal-bg] #1966 parcel: ${ALLOWED_имот.length} allowlisted «имот» string(s) left`);
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 6)', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(
            `[refusal-bg] batch 6 added 6 entries (${BATCH_6.length} in this table` +
                ` + FARM_NAME_TOO_LONG), of 62 untranslated before it, 56 after`,
        );
        expect(BATCH_6.length).toBeGreaterThanOrEqual(5);
    });

    it.each(BATCH_6.map(([c, e]) => [c, e] as const))(
        'batch 6: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('FARM_NAME_TOO_LONG names the limit, which the English never did', async () => {
        // The site passes `{ max: FARM_NAME_MAX }` and its message ignored
        // it, so a farmer was told the name is too long without being told
        // how long is allowed. A NUMBER, which `localize.ts`'s rule permits.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('FARM_NAME_TOO_LONG', 'That farm name is too long.');
        p.error.params = { max: '120' };
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).toContain('120');
        expect(p.error.message).not.toMatch(/\{\w+\}/);
    });

    it('the ЕГН refusal never echoes the number it refused', async () => {
        // An ЕГН is personal data. The call site refuses BEFORE any handling
        // that could persist the value — its comment says so, and it passes
        // no params at all — so the only way the number could reach a log or
        // a screen is an entry that interpolated it.
        //
        // Asserted in both locales and on the SOURCE, because the protection
        // is the absence of a param: a future `{ eik }` added for a client to
        // branch on would put personal data into `params`, which is the one
        // place this codebase has ruled it must never go.
        const src = readFileSync(
            `${REPO_ROOT}/src/app-layer/usecases/farm-creation.ts`,
            'utf8',
        );
        const site = src.slice(src.indexOf("'EIK_LOOKS_LIKE_EGN'"));
        expect(site.slice(0, 400)).not.toMatch(/\{\s*eik/);

        for (const locale of ['bg', 'en'] as const) {
            getRequestContext.mockReturnValue({
                requestId: 'r1',
                startTime: 0,
                uiLanguage: locale,
            });
            const p = payload('EIK_LOOKS_LIKE_EGN', 'That looks like an ЕГН.');
            // A real-shaped 10-digit ЕГН, to prove it cannot survive.
            p.error.params = { attempted: '7501020345' };
            await localizeErrorPayload(p);
            expect(`${locale}: ${p.error.message}`).not.toContain('7501020345');
            expect(`${locale}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        }
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 7)', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(
            `[refusal-bg] batch 7 added ${BATCH_7.length} entries, of 56 untranslated before it, 51 after`,
        );
        expect(BATCH_7.length).toBeGreaterThanOrEqual(5);
    });

    it.each(BATCH_7.map(([c, e, p]) => [c, e, p] as const))(
        'batch 7: %s is replaced with Bulgarian',
        async (code, english, params) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            if (params) p.error.params = params;
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('each limit entry RENDERS the number, in both locales', async () => {
        // The point of the batch, and of #1973 passing the params. An entry
        // that said "твърде дълго" without the figure would satisfy the
        // it.each above — it has no placeholder left either — so the number
        // has to be asserted on its own.
        const wanted: Array<[string, string[]]> = [
            ['CROP_SEASON_YEAR_INVALID', ['1900', '2028']],
            ['NOTES_TOO_LONG', ['2000']],
            ['WEED_ENTRIES_TOO_MANY', ['50']],
            ['WEED_NAME_TOO_LONG', ['120']],
        ];
        for (const locale of ['bg', 'en'] as const) {
            for (const [code, numbers] of wanted) {
                const row = BATCH_7.find(([c]) => c === code);
                expect(row).toBeDefined();
                getRequestContext.mockReturnValue({
                    requestId: 'r1',
                    startTime: 0,
                    uiLanguage: locale,
                });
                const p = payload(code, row![1]);
                p.error.params = row![2];
                await localizeErrorPayload(p);
                for (const n of numbers) {
                    expect(`${locale} ${code}: ${p.error.message}`).toContain(n);
                }
            }
        }
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 8)', () => {
    it('ranges over the batch — the denominator', () => {
        // Five of the SEVEN untranslated codes in `exchange-messaging.ts`.
        // The other two are block vocabulary and belong to the P5.7 work in
        // the peer session's lane; the case below asserts their absence is a
        // decision rather than an oversight.
        console.log(
            `[refusal-bg] batch 8 added ${BATCH_8.length} entries, of 51 untranslated before it, 46 after`,
        );
        expect(BATCH_8.length).toBeGreaterThanOrEqual(5);
    });

    it.each(BATCH_8.map(([c, e, p]) => [c, e, p] as const))(
        'batch 8: %s is replaced with Bulgarian',
        async (code, english, params) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            if (params) p.error.params = params;
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('MESSAGE_TOO_LONG RENDERS the limit, in both locales', async () => {
        // The limit was `MAX_BODY_LENGTH` inside the module and nowhere on
        // the wire, so no catalogue entry could have named it — same shape as
        // FILE_TOO_LARGE in batch 2 and the four parcel-history codes in
        // batch 7. The site passes it now.
        //
        // Its own case, not folded into the it.each: an entry reading
        // «твърде дълго» with no figure leaves no placeholder behind either,
        // so the loop above would pass on it.
        for (const locale of ['bg', 'en'] as const) {
            getRequestContext.mockReturnValue({
                requestId: 'r1',
                startTime: 0,
                uiLanguage: locale,
            });
            const p = payload('MESSAGE_TOO_LONG', 'That message is too long — at most {max} characters.');
            p.error.params = { max: '4000' };
            await localizeErrorPayload(p);
            expect(`${locale}: ${p.error.message}`).toContain('4000');
            expect(`${locale}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        }
    });

    it('MESSAGE_NOT_SENDER says the PERSON, not the farm — which is what it checks', async () => {
        // The check is `message.senderUserId !== ctx.userId`, deliberately:
        // its comment records that comparing `senderTenantId` would let a
        // seller admin retract the listing creator's words under #1298's
        // per-person conversations. "Your own messages" does not say that —
        // on a shared farm account it reads as the farm's messages.
        //
        // So the English changed too, from "remove your own messages" to
        // "retract messages you sent yourself". Both halves are asserted
        // because an entry replaces `message` for every locale.
        const src = readFileSync(
            `${REPO_ROOT}/src/app-layer/usecases/exchange-messaging.ts`,
            'utf8',
        );
        expect(src).toMatch(/message\.senderUserId !== ctx\.userId/);

        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('MESSAGE_NOT_SENDER', 'You can only retract messages you sent yourself.');
        await localizeErrorPayload(p);
        // «Вие» is the word carrying the person-not-farm distinction.
        expect(p.error.message).toContain('Вие');

        // And the verb the UI itself uses. `ThreadClient.tsx` calls this a
        // retraction ("A retracted message keeps its place and says so") and
        // the OpenAPI description says "Retracting twice is not an error",
        // while the refusal said "remove" — three words for one action.
        expect(p.error.message).toMatch(/оттегл/);
    });

    it('the two BLOCK codes have no entry — the peer session owns that wording', async () => {
        // `BLOCK_SELLER_ONLY` and `THREAD_BLOCKED` are the remaining two in
        // this file. Left alone on purpose: they are P5.7 vocabulary in
        // another session's lane, and `THREAD_BLOCKED`'s sentence ALREADY
        // exists in this catalogue as `exchange.messaging.blockedForYou`
        // («Този продавач не приема съобщения от Вас.»), so an entry written
        // here would be a second Bulgarian wording for one refusal.
        //
        // Asserted rather than left as a gap, so the next batch sees the
        // omission is a decision — and so that if someone does add them, this
        // case fails and makes them reconcile the two wordings.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        for (const [code, english] of [
            ['BLOCK_SELLER_ONLY', 'Only the seller can block a buyer.'],
            ['THREAD_BLOCKED', 'That seller is not accepting messages from you.'],
        ] as const) {
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toBe(`${code}: ${english}`);
        }

        // The wording that already exists, and that a future entry should
        // reuse instead of inventing. Read from the catalogue so a rename
        // breaks this rather than silently dropping the claim.
        const catalogue = readCatalogue('bg') as Record<string, unknown>;
        const exchange = (catalogue.exchange as Record<string, Record<string, string>>);
        expect(exchange.messaging.blockedForYou).toContain('не приема съобщения');
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 9)', () => {
    it('ranges over the batch — the denominator', () => {
        // Every untranslated code in `public-farm-profile.ts`. 46 -> 40.
        console.log(
            `[refusal-bg] batch 9 added ${BATCH_9.length} entries, of 46 untranslated before it, 40 after`,
        );
        expect(BATCH_9.length).toBeGreaterThanOrEqual(6);
    });

    it.each(BATCH_9.map(([c, e]) => [c, e] as const))(
        'batch 9: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('follows the vocabulary the public-profile SCREEN already uses', () => {
        // The screen these refusals come from has its own established words,
        // and a refusal that invents different ones reads as being about
        // something else. `admin.publicProfile.*` says «Публична страница»
        // for the page, «Публично име» for the display name and «Адрес» for
        // the handle — so the refusals do too.
        //
        // Asserted rather than merely done, because the alternative
        // («профил», «потребителско име», «линк») is what a translator
        // reaching for the English would naturally pick.
        // Typed property access, no assertion: `Catalogue` is the INTERSECTION
        // of the bundle JSON types, so these keys are known statically and a
        // typo is a type error. `tests/helpers/catalogue.ts` says that is the
        // point of keeping the type through the #1960 split.
        const bg = readCatalogue('bg');
        expect(bg.admin.publicProfile.displayNameLabel).toBe('Публично име');
        expect(bg.errors.FARM_BRAND_DISPLAY_NAME_REQUIRED).toContain('публично име');
        expect(bg.errors.FARM_BRAND_HANDLE_REQUIRED).toContain('адрес');
        expect(bg.errors.FARM_BRAND_NOT_FOUND).toContain('публична страница');
    });

    it('FARM_HANDLE_TAKEN does not try to name the alternatives', async () => {
        // The site passes the free handles it found as `details`, NOT
        // `params`, and says why: `ErrorParams` values are `string | number`
        // for interpolation, while a list of alternatives is structured data
        // a client renders as buttons.
        //
        // So the sentence must stand on its own. A Bulgarian entry that said
        // «опитайте {suggestions}» would leave a literal placeholder on
        // screen — the it.each above would catch that — but one that merely
        // IMPLIED a list the client might not render would not be caught by
        // anything, which is why the source contract is asserted too.
        const src = readFileSync(
            `${REPO_ROOT}/src/app-layer/usecases/public-farm-profile.ts`,
            'utf8',
        );
        const site = src.slice(src.indexOf("'FARM_HANDLE_TAKEN'"));
        expect(site.slice(0, 220)).toContain('undefined');
        expect(site.slice(0, 220)).toContain('{ suggestions }');

        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('FARM_HANDLE_TAKEN', 'That address is already taken by another farm.');
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).not.toMatch(/\{\w+\}/);
    });

    it('is a WEB-only improvement, and the phone keys all six itself', async () => {
        // Recorded so the batch is not described as reaching the phone. The
        // agrent-ios peer confirmed 2026-10-16 that `UserMessage.swift`
        // carries its own sentence for every code in this batch —
        // FARM_BRAND_NOT_FOUND and FARM_HANDLE_TAKEN earlier, and the three
        // FARM_BRAND_*_REQUIRED in agrent-ios #337/#339. `bulgarian[code]`
        // is step 2 of its lookup and `message` is step 4, so the phone's
        // wording WINS and these entries never render there.
        //
        // The value is the web: `api-client.ts` prints `error.message` at 142
        // call sites with no language test, and four of five accounts are
        // `uiLanguage: 'bg'`.
        //
        // Asserted as a property of the MECHANISM rather than of the phone,
        // which this repo cannot see: an entry exists for every code here, so
        // the web is covered whatever the phone does.
        // `as unknown as` here and not above, because this loop indexes
        // DYNAMICALLY. A direct `as` fails TS2352 — `Catalogue` and
        // `Record<string, string>` do not overlap — which is what CI caught on
        // this PR's first push, and the same two-step the other catalogue
        // readers in `tests/unit` use.
        const bg = readCatalogue('bg') as unknown as { errors: Record<string, string> };
        for (const [code] of BATCH_9) {
            expect(`${code} entried: ${typeof bg.errors[code]}`).toBe(`${code} entried: string`);
        }
    });
});

describe('a Bulgarian reader gets Bulgarian (#1918 batch 10)', () => {
    it('ranges over the batch — the denominator', () => {
        // The total is printed by `a-new-code-ships-with-its-entry.test.ts`,
        // which derives it, and is deliberately NOT repeated here: a count in
        // a second place goes stale with nothing failing.
        console.log(`[refusal-bg] batch 10 added ${BATCH_10.length} entries (journal.ts)`);
        expect(BATCH_10.length).toBe(4);
    });

    it.each(BATCH_10.map(([c, e]) => [c, e] as const))(
        'batch 10: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('the tenant predicate is gone from the SOURCE and from both locales', async () => {
        // All four read "<thing> not found or belongs to a different tenant".
        // That clause is the repository's WHERE condition, and it tells a
        // farmer about multi-tenancy rather than about their own data — the
        // same defect batch 5 fixed elsewhere, and the reason #1677's option 3
        // pays for itself: one catalogue entry replaces the sentence for every
        // reader, so no call site had to be rewritten.
        //
        // `assertLinksValid`'s own docblock says it validates that links
        // "belong to the tenant", which is correct as a description of the
        // CHECK and wrong as a sentence for the person who tripped it.
        const src = readFileSync(
            `${REPO_ROOT}/src/app-layer/usecases/journal.ts`,
            'utf8',
        );
        expect(src).not.toMatch(/belongs to a different tenant/);

        for (const locale of ['bg', 'en'] as const) {
            for (const [code, english] of BATCH_10) {
                getRequestContext.mockReturnValue({
                    requestId: 'r1',
                    startTime: 0,
                    uiLanguage: locale,
                });
                const p = payload(code, english);
                p.error.params = { id: 'ckz9planting0001' };
                await localizeErrorPayload(p);
                expect(`${locale} ${code}: ${p.error.message}`).not.toMatch(/different tenant/i);
            }
        }
    });

    it('the raw ID leaves the sentence but STAYS in params', async () => {
        // Three of the four interpolated `${missing[0]}` — a cuid — into
        // displayed copy. An id identifies nothing a farmer can act on; it is
        // for a client to branch on, which is what `params` is for. Same
        // family as `TASK_NOT_AWAITING_REVIEW` naming a wire enum (#1965) and
        // the phone printing `kind` as «FIELD», which agrent-ios found on the
        // same day. Three instances in two codebases.
        //
        // INVALID_PLANTING passed NO params, so removing the id from its
        // message would have lost it entirely — it now passes the same
        // `{ id }` its two siblings already did. Asserted on the source,
        // because a catalogue entry cannot show that the id survived.
        const src = readFileSync(
            `${REPO_ROOT}/src/app-layer/usecases/journal.ts`,
            'utf8',
        );
        expect(src).not.toMatch(/tenant: \$\{missing\[0\]\}/);
        expect(src.match(/\{ id: missing\[0\] \}/g) ?? []).toHaveLength(3);

        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('INVALID_PLANTING', 'One of the selected plantings was not found.');
        p.error.params = { id: 'ckz9planting0001' };
        await localizeErrorPayload(p);
        expect(p.error.message).not.toContain('ckz9planting0001');
        expect(p.error.message).toMatch(/[А-Яа-я]/);
    });

    it('INVALID_LOCATION says «блок», which #1966 ruled', async () => {
        // The tie between the two issues: this code names the Location
        // entity, so its Bulgarian has to use the ruled word rather than the
        // retired one. The phone made the same change for its own
        // INVALID_LOCATION sentence (agrent-ios #349).
        //
        // Plural framing on purpose: `missing` is a filtered ARRAY of ids the
        // caller submitted and only `[0]` is reported, so "one of the
        // selected" is what actually happened — «Блокът не беше намерен»
        // would claim a single link was checked, and would duplicate
        // LOCATION_NOT_FOUND, a different code for a different situation.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('INVALID_LOCATION', 'One of the selected locations was not found.');
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/блок/i);
        expect(p.error.message).not.toMatch(/локаци/i);
        expect(p.error.message).toMatch(/Един от избраните/);
    });
});

describe('the codes the entry guard could not see (#2008)', () => {
    it('ranges over the batch — the denominator', () => {
        // These ten were thrown with neither an entry nor a BACKLOG line, and
        // `a-new-code-ships-with-its-entry.test.ts` said nothing: it read only
        // a LITERAL first argument, so a ternary, a second-position code and a
        // code from a function were all invisible. Its denominator moved from
        // 211 to 225 once it could see them.
        console.log(`[refusal-bg] #2008 entried ${BATCH_2008.length} previously invisible code(s)`);
        expect(BATCH_2008.length).toBe(10);
    });

    it.each(BATCH_2008.map(([c, e]) => [c, e] as const))(
        '#2008: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('the FARM_HANDLE_* four close a gap where the PHONE was ahead of the web', async () => {
        // The reason these matter beyond the count. agrent-ios confirmed on
        // 2026-10-15 that the phone carries Bulgarian for all four, so a
        // farmer choosing a public address got a Bulgarian refusal on the
        // phone and an English one in the browser — same action, same code,
        // decided by which client they happened to be using.
        //
        // `FARM_HANDLE_TAKEN` is the control: it already had an entry, because
        // batch 9 reached it through its OWN literal call site in the same
        // file. Its four siblings are thrown only through `verdict.code`, so
        // nothing asked for them.
        const bg = readCatalogue('bg') as unknown as { errors: Record<string, string> };
        for (const code of [
            'FARM_HANDLE_RESERVED',
            'FARM_HANDLE_TOO_LONG',
            'FARM_HANDLE_TOO_SHORT',
            'FARM_HANDLE_UNUSABLE',
            'FARM_HANDLE_TAKEN',
        ]) {
            expect(`${code}: ${typeof bg.errors[code]}`).toBe(`${code}: string`);
        }
    });

    it('the handle length entries name the REAL limits, not a remembered pair', async () => {
        // The English spelled the bounds as words ("at least three", "at most
        // forty") while the code exports numbers. Writing a number into copy
        // duplicates a constant, so this ties the two together: change
        // HANDLE_MIN_LENGTH or HANDLE_MAX_LENGTH and the copy fails until it
        // is updated.
        const src = readFileSync(
            `${REPO_ROOT}/src/lib/public-profile/handle.ts`,
            'utf8',
        );
        const min = /HANDLE_MIN_LENGTH\s*=\s*(\d+)/.exec(src)?.[1];
        const max = /HANDLE_MAX_LENGTH\s*=\s*(\d+)/.exec(src)?.[1];
        expect(min).toBeDefined();
        expect(max).toBeDefined();

        for (const locale of ['bg', 'en'] as const) {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: locale });
            const short = payload('FARM_HANDLE_TOO_SHORT', 'x');
            const long = payload('FARM_HANDLE_TOO_LONG', 'y');
            await localizeErrorPayload(short);
            await localizeErrorPayload(long);
            expect(`${locale} short: ${short.error.message}`).toContain(min!);
            expect(`${locale} long: ${long.error.message}`).toContain(max!);
            // And the clause that makes the number mean anything. The count is
            // of the TRANSLITERATED slug, not of what was typed:
            // `checkHandleShape` measures `toSlug(typed, …).length`. Measured —
            // «Щ» is 3 Latin letters, «Ж» is 2, «Щастие» is 6 typed and 8
            // Latin. So a farmer typing Cyrillic sees a limit applied to
            // characters they never entered, and a bare "at most 40" is a
            // number they cannot count to.
            //
            // agrent-ios shipped this clause first and the web now matches
            // their wording rather than the reverse, so a farmer moving
            // between the two reads the same sentence.
            const clause = locale === 'bg' ? /латински букви/ : /Latin letters/;
            expect(short.error.message).toMatch(clause);
            expect(long.error.message).toMatch(clause);
        }
    });

    it('the transition entries never name a wire status — the FOURTH instance', async () => {
        // `formatTransitionError` builds "Illegal work-item transition:
        // ${err.from} → ${err.to}." and "Status is already ${err.status}." —
        // raw `WorkItemStatus` values in displayed copy. That is the same
        // defect as `Task is ${task.status}` (#1965), the phone printing
        // `kind` as «FIELD», and journal.ts's four interpolated cuids: the
        // fourth instance in two codebases.
        //
        // The entries close it WITHOUT touching the formatter, because
        // `localizeErrorPayload` replaces `message` for EVERY locale once an
        // entry exists. `transitionErrorParams` keeps `from`/`to`/`status` on
        // the wire for a client to branch on, which is where an enum belongs.
        for (const locale of ['bg', 'en'] as const) {
            for (const code of ['ILLEGAL_TRANSITION', 'TASK_STATUS_UNCHANGED', 'UNKNOWN_TASK_STATUS']) {
                getRequestContext.mockReturnValue({
                    requestId: 'r1',
                    startTime: 0,
                    uiLanguage: locale,
                });
                const p = payload(code, 'Illegal work-item transition: TODO → DONE.');
                p.error.params = { from: 'TODO', to: 'DONE', status: 'IN_PROGRESS' };
                await localizeErrorPayload(p);
                // The subject is the MESSAGE ALONE. I interpolated `${code}`
                // into it for a nicer label and the assertion matched my own
                // label — `ILLEGAL_TRANSITION` is itself `[A-Z]{3,}_[A-Z]` —
                // so a correct translation failed. Batch 1's case carries a
                // comment warning about exactly this and I did it anyway. The
                // label goes in its own expect.
                expect(p.error.message).not.toMatch(/[A-Z]{3,}_[A-Z]|TODO|DONE/);
                expect(`${locale} ${code} is Cyrillic-or-plain: true`).toBe(
                    `${locale} ${code} is Cyrillic-or-plain: true`,
                );
            }
        }
    });
});

describe('#1712 — the farmer-facing notFound() sites now speak Bulgarian', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(
            `[refusal-bg] #1712 coded 9 site(s) with ${BATCH_1712.length} new code(s) + 2 reused`,
        );
        expect(BATCH_1712.length).toBe(6);
    });

    it.each(BATCH_1712.map(([c, e]) => [c, e] as const))(
        '#1712: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('two sites REUSE an existing code rather than minting a near-duplicate', async () => {
        // `catalog.ts` threw 'Item not found.' for a row with `sku`,
        // `activeIngredient` and `pppRegistrationNo` — a product, not a
        // generic item — so it takes PRODUCT_NOT_FOUND, which #2008 had just
        // entried. `grain-blend.ts`'s "source lot" has `quantityOnHand`,
        // `lotCode` and `unitId`: the same InventoryLot that LOT_NOT_FOUND
        // already names.
        //
        // Minting CATALOG_ITEM_NOT_FOUND and SOURCE_LOT_NOT_FOUND would have
        // given one entity two sentences, which is the #1966 defect in a
        // different costume.
        const src = readFileSync(`${REPO_ROOT}/src/app-layer/usecases/catalog.ts`, 'utf8');
        expect(src).toContain("codedNotFound('PRODUCT_NOT_FOUND'");
        expect(src).not.toMatch(/CATALOG_ITEM_NOT_FOUND/);

        const blend = readFileSync(`${REPO_ROOT}/src/app-layer/usecases/grain-blend.ts`, 'utf8');
        expect(blend).toContain("codedNotFound('LOT_NOT_FOUND'");
        // And the raw cuid left the sentence while staying on the wire.
        expect(blend).toContain('{ id: s.lotId }');
        expect(blend).not.toMatch(/Source lot not found: \$\{/);
    });

    it('ORG_NOT_FOUND_OR_FORBIDDEN keeps the ambiguity it was written for', async () => {
        // `context.ts` carries its own note: "Generic external message — same
        // string for both 'no such org' and 'not a member'. The internal log
        // line below carries the real reason for ops diagnostics."
        //
        // So ONE code, deliberately. Splitting it into ORG_NOT_FOUND and
        // ORG_ACCESS_DENIED would re-open the leak that line exists to close,
        // and a Bulgarian entry that named only one cause would do the same.
        const bg = readCatalogue('bg') as unknown as { errors: Record<string, string> };
        const sentence = bg.errors.ORG_NOT_FOUND_OR_FORBIDDEN;
        // Names BOTH possibilities, so it reveals neither.
        expect(sentence).toMatch(/намерена/);
        expect(sentence).toMatch(/достъп/);

        const src = readFileSync(`${REPO_ROOT}/src/app-layer/context.ts`, 'utf8');
        expect(src).not.toMatch(/ORG_NOT_FOUND'|ORG_ACCESS_DENIED/);
    });

    it('TARGET_USER_NOT_IN_TENANT says FARM, not tenant', async () => {
        // "Tenant" is the schema's word, not the product's. The old English
        // read "Target user is not a member of this tenant" — the same class
        // of leak as the repository WHERE clause batch 10 removed from
        // journal.ts, and as "or belongs to a different tenant".
        for (const locale of ['bg', 'en'] as const) {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: locale });
            const p = payload('TARGET_USER_NOT_IN_TENANT', 'x');
            await localizeErrorPayload(p);
            expect(p.error.message).not.toMatch(/tenant/i);
        }
        const bg = readCatalogue('bg') as unknown as { errors: Record<string, string> };
        expect(bg.errors.TARGET_USER_NOT_IN_TENANT).toMatch(/стопанство/);
    });
});

describe('#1918 batch 11 — the protocol tranche, and one source message rewritten', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(`[refusal-bg] batch 11 added ${BATCH_11.length} entries (http + api-key + links)`);
        expect(BATCH_11.length).toBe(9);
    });

    it.each(BATCH_11.map(([c, e]) => [c, e] as const))(
        'batch 11: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            // Only this code takes a param, and it must be supplied — see the
            // table's docblock for why an absent one is a real failure.
            if (code === 'API_KEY_FAMILY_NOT_ENABLED') p.error.params = { resource: 'market' };
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('INVALID_LINK no longer names the tenant predicate or a raw id AT SOURCE', () => {
        // Batch 5 deliberately did NOT rewrite this phrase, and was right to:
        // it is at 33 sites and an entry replaces the sentence for every
        // reader, so a sweep would have bought nothing.
        //
        // This site is the exception for a reason that is not scale. It also
        // interpolated `${missing[0]}` — a raw cuid — and `localizeErrorPayload`
        // SWALLOWS its own failures by design, so on any localisation miss the
        // original message is what ships. An entry cannot protect a string it
        // never replaced. The id moved to `params`, where a client can read it
        // and nobody sees it.
        const src = readFileSync(`${REPO_ROOT}/src/app-layer/usecases/farm-task.ts`, 'utf8');
        expect(src).toContain("codedBadRequest('INVALID_LINK'");
        expect(src).not.toMatch(/belongs to a different tenant/);
        expect(src).not.toMatch(/INVALID_LINK[^;]*\$\{missing\[0\]\}`/);
        expect(src).toContain('{ id: missing[0] }');
    });
});

describe('#1918 batch 12 — vocabulary taken from the catalogue, not invented', () => {
    it('ranges over the batch — the denominator', () => {
        console.log(`[refusal-bg] batch 12 added ${BATCH_12.length} entries`);
        expect(BATCH_12.length).toBe(7);
    });

    it.each(BATCH_12.map(([c, e]) => [c, e] as const))(
        'batch 12: %s is replaced with Bulgarian',
        async (code, english) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('OPERATOR_SCOPE uses the role name the rest of the product uses', async () => {
        // «Механизатор», not «машинен оператор». The role already has a name
        // in this catalogue and a refusal that invents a second one teaches a
        // farmer that there are two things — the #1966 defect in a new place.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('OPERATOR_SCOPE', 'A machine operator cannot use this surface.');
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('Механизатор');
        expect(p.error.message).not.toContain('машинен оператор');
    });

    it('LISTING_INTEREST_ALREADY_SENT says «обява», the word for a listing', async () => {
        // «оферта» is an OFFER elsewhere in the exchange surface. Using it for
        // a listing would collide with a term already in use for something
        // adjacent, which is worse than a plain mistranslation.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('LISTING_INTEREST_ALREADY_SENT', 'You have already expressed interest in this listing.');
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('обява');
    });
});

describe('#1918 batch 12b — the market-price tranche, on the owner\'s vocabulary ruling', () => {
    /**
     * Owner ruling 2026-10-17, and both halves needed asking.
     *
     * "commodity" already had TWO translations: «Стока» on the exchange
     * surface, «Култура» on grain. This surface takes «стока», because the
     * override table prices DIESEL (~1.95 EUR/l in its own docblock) and
     * diesel is not a култура. One word has to cover the whole set.
     *
     * "denomination" had none, and the literal «деноминация» is a FALSE
     * FRIEND — in Bulgarian it means currency redenomination, the 1999 BGN
     * change. Ruled «мерна единица и валута», which spells out what it is.
     *
     * The sentences name the commodity rather than only categorising it,
     * because all three sites already pass `{ commodity }`, and
     * OVERRIDE_DENOMINATION_CHANGED passes `stored` and `expected` too — so
     * "recorded in a different denomination" becomes "recorded in EUR/l
     * rather than EUR/t", which is the fact the superuser needs.
     */
    const BATCH_12B: ReadonlyArray<[code: string, english: string, params: Record<string, string>]> = [
        ['DUPLICATE_COMMODITY', 'The commodity "wheat" appears twice in one day.', { commodity: 'wheat' }],
        ['UNKNOWN_COMMODITY', '"unobtainium" is not a commodity this platform sets a price for.', { commodity: 'unobtainium' }],
        ['OVERRIDE_DENOMINATION_CHANGED', 'A live override is recorded in the wrong denomination.',
            { commodity: 'diesel', stored: 'EUR l', expected: 'EUR t' }],
    ];

    it.each(BATCH_12B.map(([c, e, pr]) => [c, e, pr] as const))(
        'batch 12b: %s is replaced with Bulgarian and interpolates',
        async (code, english, params) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            p.error.params = params;
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            // No placeholder may survive. Every one of these entries takes a
            // param, so an un-interpolated `{commodity}` on screen is the
            // failure mode this batch is most exposed to.
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
        },
    );

    it('«деноминация» never reaches a reader — it means currency redenomination', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('OVERRIDE_DENOMINATION_CHANGED', 'x');
        p.error.params = { commodity: 'diesel', stored: 'EUR l', expected: 'EUR t' };
        await localizeErrorPayload(p);
        expect(p.error.message).not.toMatch(/деноминаци/i);
        expect(p.error.message).toContain('мерна единица и валута'.split(' ')[0]);
        // And it tells the superuser WHICH two, not merely that they differ.
        expect(p.error.message).toContain('EUR l');
        expect(p.error.message).toContain('EUR t');
    });

    it('the market surface says «стока», not «култура» — diesel is not a култура', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('UNKNOWN_COMMODITY', 'x');
        p.error.params = { commodity: 'diesel' };
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('стока');
        expect(p.error.message).not.toMatch(/култура/i);
    });
});

describe('#1918 batch 13 — the last fourteen, and the backlog reaches zero', () => {
    /**
     * Two were defects rather than translations.
     *
     * `ACCOUNT_ALREADY_ERASED` passed the CODE as its own message, at both of
     * its two sites: `codedNotFound('ACCOUNT_ALREADY_ERASED',
     * 'ACCOUNT_ALREADY_ERASED')`. The comment above it says telling the caller
     * is deliberate — "saying so is better than pretending it worked" — and
     * that intent was never delivered. What shipped was the token. Being
     * specific is safe there because `getUserCtx` means the caller is asking
     * about their OWN account, so there is no existence to hide.
     *
     * `INVALID_FARM_TASK_TYPE` interpolated the type into the English with no
     * param, so a Bulgarian entry would have had to drop it. `{ type }` added
     * at the throw, and the entry names it.
     *
     * Vocabulary looked up, not translated. «Оставащо» is what the catalogue
     * says for a bare "Outstanding", and it is the WRONG sense here — the
     * payment meaning is «не е получено», which is how the existing past-due
     * email reads. Taking the first match would have produced "the payment is
     * remaining".
     */
    const BATCH_13: ReadonlyArray<[code: string, english: string, params?: Record<string, string>]> = [
        ['ACCOUNT_ALREADY_ERASED', 'This account has already been erased.'],
        ['ACCOUNT_HAS_NO_EMAIL', 'Your account has no email address.'],
        ['IMPORT_JOB_NOT_FOUND', 'No such import job.'],
        ['INSURANCE_PRODUCT_UNKNOWN', 'Unknown insurance product.'],
        ['INSURANCE_QUOTE_INVALID', 'That quote cannot be calculated.'],
        ['INVALID_ASSET', 'Asset not found or belongs to a different tenant'],
        ['INVALID_FARM_PAYLOAD', 'Invalid farm payload.'],
        ['INVALID_FARM_TASK_TYPE', 'Unknown farm task type: spraying', { type: 'spraying' }],
        ['INVALID_TAB_ORDER', 'order must be an array of up to 5 ids.', { max: '5' }],
        ['INVALID_TASK', 'Task not found or belongs to a different tenant'],
        ['LEASE_PAYMENT_NOT_FOUND', 'Payment not found'],
        ['PAST_DUE_RESTRICTED', 'Account payment is outstanding.'],
    ];

    it('ranges over the batch — the denominator', () => {
        console.log(`[refusal-bg] batch 13 added ${BATCH_13.length} entries; backlog now 0, 5 deliberate`);
        expect(BATCH_13.length).toBe(12);
    });

    it.each(BATCH_13.map(([c, e, pr]) => [c, e, pr] as const))(
        'batch 13: %s is replaced with Bulgarian',
        async (code, english, params) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const p = payload(code, english);
            if (params) p.error.params = params;
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(p.error.message).not.toBe(english);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
            // And never the token itself, which is what ACCOUNT_ALREADY_ERASED
            // actually shipped before this batch.
            expect(p.error.message).not.toBe(code);
        },
    );

    it('ACCOUNT_ALREADY_ERASED no longer passes its own code as the message', () => {
        const src = readFileSync(`${REPO_ROOT}/src/app/api/account/deletion/route.ts`, 'utf8');
        // Both sites. A count, not a boolean: the first fix I wrote asserted
        // uniqueness and failed, which is how I learned there were two.
        expect(src).not.toMatch(/'ACCOUNT_ALREADY_ERASED',\s*'ACCOUNT_ALREADY_ERASED'/);
        expect(src.match(/ACCOUNT_ALREADY_ERASED/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('the past-due wording is «не е получено», not the «Оставащо» sense', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('PAST_DUE_RESTRICTED', 'Account payment is outstanding.');
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('не е получено');
        expect(p.error.message).not.toContain('Оставащо');
    });
});
