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
    ['AVATAR_TOO_LARGE', 'Processed avatar is too large — re-select a smaller image.'],
    ['AVATAR_NOT_WEBP', 'Avatar must be a WebP image.'],
    ['AVATAR_EMPTY', 'Avatar upload was empty.'],
    ['AVATAR_FILE_MISSING', 'Missing avatar file in form data.'],
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

    it('a code with NO entry is left alone, which is the 109 still to do', async () => {
        // The boundary. An invented code must pass through untouched, or this
        // batch would be claiming coverage it does not have — and a
        // `localizeErrorPayload` that invented a sentence for an unknown code
        // would be worse than leaving the English.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payload('NOT_A_REAL_CODE_1918', 'Original English stays.');
        await localizeErrorPayload(p);
        expect(p.error.message).toBe('Original English stays.');
    });
});
