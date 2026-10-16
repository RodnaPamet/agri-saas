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

const REPO_ROOT = resolve(__dirname, '../..');

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

    it('INVALID_LIMIT has NO entry, deliberately', async () => {
        // Three sites, three DIFFERENT sentences, and both of the things that
        // distinguish them live in the English template rather than on the
        // wire: a caller-supplied `opts.label` (so the same code says "Invalid
        // limit" or "Invalid radius" depending on who called it) and the
        // received value. One entry would flatten all three and lose the
        // label, in every locale — rule 3.
        //
        // It is not unfixable, and the fix is a separate change: pass
        // `{ reason: 'empty' | 'not_an_integer' }` and the label as params,
        // then write a variant TABLE, which `DISCRIMINATORS` already supports
        // because `reason` is one. Recorded on #1918 rather than half-done
        // here, because the validator is shared by every list endpoint.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const original = 'Invalid radius: must be a positive integer; received "x".';
        const p = payload('INVALID_LIMIT', original);
        await localizeErrorPayload(p);
        expect(p.error.message).toBe(original);
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
