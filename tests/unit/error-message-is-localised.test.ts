/**
 * A refusal's `message` comes back in the reader's language (#1677).
 *
 * ## What the owner chose, and why it needed a mechanism
 *
 * `coded*()`'s second argument is **displayed copy on both clients**: the web
 * renders `message` directly in 37 components and reads the error `code`
 * nowhere, and the phone shows `message` verbatim for any code it has no
 * sentence for. 130 of 138 literal messages were English prose. The two
 * clients wanted opposite conventions, so the owner ruled that the SERVER
 * resolves the locale — the only answer needing nothing from either client.
 *
 * ## The property that makes 100 remaining codes migratable
 *
 * **A code with no catalogue entry keeps its message byte for byte.** That is
 * asserted here directly, because it is what lets the rest move a family at a
 * time instead of as one unreviewable 100-sentence diff. If it ever stops
 * holding, the failure mode is a `message` reading `errors.SOME_CODE` — a key
 * where a sentence should be, in a farmer's face.
 */
const getRequestContext = jest.fn();
jest.mock('@/lib/observability/context', () => ({
    ...jest.requireActual('@/lib/observability/context'),
    getRequestContext: () => getRequestContext(),
}));

import { localizeErrorPayload } from '@/lib/errors/localize';
import type { ApiErrorResponse } from '@/lib/errors/types';

const payloadFor = (
    code: string,
    message: string,
    params?: Record<string, string>,
): ApiErrorResponse => ({ error: { code, message, ...(params ? { params } : {}) } });

beforeEach(() => {
    jest.clearAllMocks();
    // No session language by default — the fallback path.
    getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0 });
});

describe('a refusal speaks the reader’s language (#1677)', () => {
    it('translates a code that HAS an entry', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payloadFor('BILLING_UNAVAILABLE', 'This deployment runs in self-hosted mode; …', {
            mode: 'SELFHOSTED',
        });
        await localizeErrorPayload(p);
        // Bulgarian, and no unsubstituted placeholder — a message reading
        // "{mode}" is worse than the English it replaced.
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).not.toMatch(/\{\w+\}/);
        expect(p.error.message).not.toBe('This deployment runs in self-hosted mode; …');
    });

    it('PLAN_LIMIT_EXCEEDED is NOT translated yet, and keeps its English', async () => {
        // The migration property on a REAL un-migrated code rather than an
        // invented one. agrent-ios reviewed the Bulgarian for this code and
        // found `{resource}` putting a wire identifier — `exchange_listing` —
        // on a farmer's screen, and their corrected copy needs ICU plurals
        // (Bulgarian agreement after a numeral differs by gender) which
        // `translateFor` deliberately cannot render. So it waits for stage 2,
        // and until then it must look exactly as it did before #1677.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const original = 'FREE plan allows 5 location(s); tenant currently has 5.';
        const p = payloadFor('PLAN_LIMIT_EXCEEDED', original, {
            plan: 'FREE', resource: 'location', limit: '5', current: '5',
        });
        await localizeErrorPayload(p);
        expect(p.error.message).toBe(original);
        // And specifically NOT a wire identifier dressed as Bulgarian.
        expect(p.error.message).not.toMatch(/[А-Яа-я]/);
    });

    it('leaves a code with NO entry byte for byte — the migration property', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const original = 'Journal entry not found';
        const p = payloadFor('JOURNAL_ENTRY_NOT_FOUND', original);
        await localizeErrorPayload(p);
        expect(p.error.message).toBe(original);
    });

    it('never leaves a KEY where a sentence belongs', async () => {
        // The failure mode of the detector. `translateFor` returns the key when
        // it finds no entry, so a localiser that assigned unconditionally would
        // put `errors.WHATEVER` in front of a farmer.
        const p = payloadFor('NO_SUCH_CODE_ANYWHERE', 'the original');
        await localizeErrorPayload(p);
        expect(p.error.message).not.toContain('errors.');
        expect(p.error.message).toBe('the original');
    });

    // ── the `reason` variant ────────────────────────────────────────────
    it('prefers errors.<CODE>.<reason> when the error carries one', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const plan = payloadFor('MODULE_DISABLED', 'module X is not available', {
            module: 'CERTIFICATION', reason: 'plan',
        });
        const tenant = payloadFor('MODULE_DISABLED', 'module X is not available', {
            module: 'CERTIFICATION', reason: 'tenant',
        });
        await localizeErrorPayload(plan);
        await localizeErrorPayload(tenant);

        // The whole point of the variant: only ONE of them may name an
        // administrator. Naming one when the PLAN excludes the module is
        // agrent-ios#241 — a farmer sent to somebody who cannot help.
        expect(tenant.error.message).toMatch(/[Аа]дминистратор/);
        expect(plan.error.message).not.toMatch(/[Аа]дминистратор/);
        expect(plan.error.message).not.toBe(tenant.error.message);
    });

    it('falls back to the plain code when the reason has no variant', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payloadFor('BILLING_UNAVAILABLE', 'self-hosted', { mode: 'SELFHOSTED' });
        await localizeErrorPayload(p);
        // `mode` is not a `reason`, so nothing variant-shaped is attempted and
        // the plain entry answers. Adding a param must never break a message.
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).not.toBe('self-hosted');
    });

    // ── the locale's source, which is the part agrent-ios caught ────────
    it('uses the session claim, not a header', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'en' });
        const p = payloadFor('BILLING_UNAVAILABLE', 'x', { mode: 'SELFHOSTED' });
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/installation|plans/i);
        expect(p.error.message).not.toMatch(/[А-Яа-я]/);
    });

    it('falls back to bg, NOT to DEFAULT_LOCALE — which is `en`', async () => {
        // The #686 mistake, and the reason `statement-dispatch.ts` restates it:
        // `DEFAULT_LOCALE` is the fallback for an UNAUTHENTICATED surface,
        // while `User.uiLanguage` defaults to `bg` at the column. A refusal is
        // answered to a known person, so reaching for `'en'` hands English to a
        // Bulgarian farmer whose claim merely failed to load.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0 });
        const p = payloadFor('BILLING_UNAVAILABLE', 'x', { mode: 'SELFHOSTED' });
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
    });

    it('an unrecognised claim value falls back rather than breaking', async () => {
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'de' });
        const p = payloadFor('BILLING_UNAVAILABLE', 'x', { mode: 'SELFHOSTED' });
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
    });

    // ── it must never make a refusal worse ──────────────────────────────
    it('never throws, and leaves the message alone when the context blows up', async () => {
        getRequestContext.mockImplementation(() => {
            throw new Error('ALS exploded');
        });
        const p = payloadFor('BILLING_UNAVAILABLE', 'the original', { mode: 'SELFHOSTED' });
        await expect(localizeErrorPayload(p)).resolves.toBeUndefined();
        expect(p.error.message).toBe('the original');
    });

    it('does nothing for a payload with no code', async () => {
        const p = { error: { code: '', message: 'bare' } } as ApiErrorResponse;
        await expect(localizeErrorPayload(p)).resolves.toBeUndefined();
        expect(p.error.message).toBe('bare');
    });

    it('bg and en both answer — the positive control', async () => {
        // `a-probe-with-no-discriminating-power`: without this, a catalogue
        // that only ever served one language would satisfy the assertions above
        // in whichever direction happened to be tested.
        const out: string[] = [];
        for (const loc of ['bg', 'en']) {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: loc });
            const p = payloadFor('BILLING_UNAVAILABLE', 'x', { mode: 'SELFHOSTED' });
            await localizeErrorPayload(p);
            out.push(p.error.message);
        }
        expect(out[0]).not.toBe(out[1]);
        expect(out[0]).toMatch(/[А-Яа-я]/);
        expect(out[1]).not.toMatch(/[А-Яа-я]/);
    });
});
