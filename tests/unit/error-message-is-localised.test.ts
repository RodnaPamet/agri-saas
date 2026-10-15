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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    it('the two role refusals from #1779 read in Bulgarian, with the role substituted', async () => {
        // The half #1779's first version left out. Adding a code without a
        // catalogue entry gains the WEB nothing: `src/lib/api-client.ts` does
        // `message = body.error.message || message` with no language test, and
        // 142 call sites print that straight to screen. So the unit of work is
        // code PLUS entry, and this is the assertion that the pair reaches a
        // farmer.
        //
        // `params.role` is substituted, so a reader is told which role they
        // actually hold rather than being left to guess — and an unsubstituted
        // `{role}` on screen would be worse than the English it replaced,
        // which is why the placeholder is asserted absent.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        for (const code of ['ADMIN_FORBIDDEN_FOR_ROLE', 'AUDIT_FORBIDDEN_FOR_ROLE']) {
            const p = payloadFor(code, 'You do not have permission …', { role: 'EDITOR' });
            await localizeErrorPayload(p);
            expect(`${code}: ${p.error.message}`).toMatch(/[А-Яа-я]/);
            expect(`${code}: ${p.error.message}`).not.toMatch(/\{\w+\}/);
            expect(p.error.message).not.toBe('You do not have permission …');

            // The role is named in BULGARIAN, and the wire enum does NOT
            // appear (#1919). This case asserted `toContain('EDITOR')` when
            // it shipped, which locked in «Вашата роля в това стопанство
            // (EDITOR) не позволява…» — a Bulgarian sentence with an English
            // enum inside it, breaking the rule `localize.ts` states in its
            // own docblock: a `{param}` belongs in a sentence only if it is a
            // NUMBER or a NAME THE PERSON TYPED.
            //
            // «Редактор» is agrent-ios's own `MembershipRole.label`, so the
            // two clients do not name one role two ways.
            expect(p.error.message).toContain('Редактор');
            expect(p.error.message).not.toContain('EDITOR');
        }
    });

    it('a role with NO sentence falls back to the roleless default (#1919)', async () => {
        // The variant table's own fallback. OWNER and ADMIN are never refused
        // by these two checks, so they have no entry — and a role that
        // somehow arrived without one must get a sentence rather than the
        // literal key or the English. This is what `errors.<CODE>.default` is
        // for, and it is the arm a `has`-only detector would miss.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payloadFor('ADMIN_FORBIDDEN_FOR_ROLE', 'English fallback', { role: 'OWNER' });
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).not.toContain('OWNER');
        expect(p.error.message).not.toContain('errors.');
        expect(p.error.message).not.toBe('English fallback');
    });

    it('an English reader gets the role in English, not the enum (#1919)', async () => {
        // Same rule, other locale: `EDITOR` is a wire value in an English
        // sentence too, and the table gives both locales the same treatment
        // so the two cannot drift apart.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'en' });
        const p = payloadFor('ADMIN_FORBIDDEN_FOR_ROLE', 'original', { role: 'MECHANISATOR' });
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('Machine operator');
        expect(p.error.message).not.toContain('MECHANISATOR');
    });

    it('and an English reader still gets English for the same two', async () => {
        // The other direction. A catalogue entry that replaced the message for
        // EVERY reader would be a regression for the English one, and
        // `localizeErrorPayload` keys on the session language — so this is the
        // control that the lookup is language-dependent rather than
        // unconditional.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'en' });
        const p = payloadFor('ADMIN_FORBIDDEN_FOR_ROLE', 'original', { role: 'READER' });
        await localizeErrorPayload(p);
        expect(p.error.message).not.toMatch(/[А-Яа-я]/);
        // 'Reader', not 'READER' (#1919). This asserted the ENUM when it
        // shipped — the same mistake as the Bulgarian case above, and the
        // reason both locales get the variant table rather than only the one
        // whose breakage was visible.
        expect(p.error.message).toContain('Reader');
        expect(p.error.message).not.toContain('READER');
    });

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

    it('PLAN_LIMIT_EXCEEDED picks its RESOURCE variant, with Bulgarian plural agreement', async () => {
        // Stage 2. This case asserted the opposite in stage 1 — that the code
        // kept its English — and objected the moment the catalogue entry
        // landed, which is what a boundary test is for.
        //
        // The noun is TRANSLATED AND DECLINED, never interpolated: «до 5
        // exchange_listing» was the defect agrent-ios found, and Bulgarian
        // agreement after a numeral differs by gender, so the count and the
        // noun have to agree inside one ICU message.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payloadFor('PLAN_LIMIT_EXCEEDED', 'FREE plan allows 5 location(s); …', {
            plan: 'FREE', resource: 'location', limit: '5', current: '5',
        });
        await localizeErrorPayload(p);
        expect(p.error.message).toContain('локации');
        // The wire identifier is GONE from the sentence, which is the point.
        expect(p.error.message).not.toContain('location');
        expect(p.error.message).not.toContain('FREE');
        expect(p.error.message).not.toMatch(/\{\w+\}/);
    });

    it('the singular and plural forms AGREE — 1 локация, 5 локации', async () => {
        // The reason this needed ICU at all. `translateFor` would have rendered
        // the selector literally; a sentence with a bare `{limit}` would read
        // «до 1 локации», which is wrong in a way a farmer notices.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const one = payloadFor('PLAN_LIMIT_EXCEEDED', 'x', { resource: 'location', limit: '1' });
        const many = payloadFor('PLAN_LIMIT_EXCEEDED', 'x', { resource: 'location', limit: '5' });
        await localizeErrorPayload(one);
        await localizeErrorPayload(many);
        expect(one.error.message).toContain('1 локация');
        expect(many.error.message).toContain('5 локации');
        // Masculine nouns take the count form instead — the distinction
        // agrent-ios supplied and I would not have known.
        const user = payloadFor('PLAN_LIMIT_EXCEEDED', 'x', { resource: 'user', limit: '3' });
        await localizeErrorPayload(user);
        expect(user.error.message).toContain('3 потребителя');
    });

    it('an UNKNOWN resource falls back to the variant table’s default', async () => {
        // A fifth `GatedResource` must get a true sentence, not a key and not
        // the English. This is the sentence agrent-ios uses on the phone, so
        // the two agree when both fall back.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payloadFor('PLAN_LIMIT_EXCEEDED', 'x', { resource: 'something_new', limit: '5' });
        await localizeErrorPayload(p);
        expect(p.error.message).toMatch(/[А-Яа-я]/);
        expect(p.error.message).not.toContain('errors.');
        expect(p.error.message).not.toContain('something_new');
    });

    it('never renders a variant TABLE as a message', async () => {
        // `t.has('errors.PLAN_LIMIT_EXCEEDED')` returns TRUE — it is a
        // namespace node — and `t()` on a namespace returns the KEY. So a
        // `has`-only detector would put `errors.PLAN_LIMIT_EXCEEDED` in front
        // of a farmer. With no discriminator at all, the `.default` key is
        // what must answer.
        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const p = payloadFor('PLAN_LIMIT_EXCEEDED', 'the original English');
        await localizeErrorPayload(p);
        expect(p.error.message).not.toContain('errors.');
        expect(p.error.message).not.toBe('errors.PLAN_LIMIT_EXCEEDED');
        expect(p.error.message).toMatch(/[А-Яа-я]/);
    });

    it('leaves a code with NO entry byte for byte — the migration property', async () => {
        // The example is COMPUTED, not named. This case used to name
        // `JOURNAL_ENTRY_NOT_FOUND`, and #1918 batch 1 gave that code an
        // entry — so the test failed on somebody doing exactly the work it
        // was describing. Naming an instance of a shrinking set makes a test
        // break on its own success, which is the lesson
        // `i18n-dead-keys-reports-three-numbers` records for the same reason.
        //
        // So: take any code the catalogue does not yet carry. 124 of the
        // server's 211 were unentried when #1918 was filed, and the set
        // shrinks as batches land.
        const bg = JSON.parse(
            readFileSync(join(process.cwd(), 'messages/bg.json'), 'utf8'),
        ) as { errors: Record<string, string> };
        const unentried = ['JOURNAL_IMPORT_FAILED', 'SOME_CODE_WITHOUT_AN_ENTRY_1918']
            .find((c) => !(c in bg.errors));

        // When this set is EMPTY, #1918 is finished and this case should be
        // deleted rather than repaired — the migration it describes is over.
        expect(unentried).toBeDefined();

        getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
        const original = 'An English sentence that must survive.';
        const p = payloadFor(unentried as string, original);
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

    describe('every catalogued code actually resolves', () => {
        // DERIVED from the catalogue, not a curated list. A list of code names
        // here would go stale the moment somebody adds the 25th entry and then
        // assert nothing about it — the exact failure #805 records. This way a
        // new `errors.<CODE>` is covered the moment it is written.
        //
        // The flat-string entries only: a variant table is exercised by the
        // PLAN_LIMIT_EXCEEDED and MODULE_DISABLED cases above, which check the
        // discriminator selection a bulk sweep cannot.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const catalogue = require('../../messages/bg.json') as {
            errors: Record<string, unknown>;
        };
        const flatCodes = Object.entries(catalogue.errors)
            .filter(([, v]) => typeof v === 'string')
            .map(([code, text]) => [code, text as string] as const);

        it('covers a real population — the denominator', () => {
            // Without this the loop below passes on an empty catalogue, which
            // would read as "every code resolves" while checking none.
            expect(flatCodes.length).toBeGreaterThanOrEqual(24);
        });

        it.each(flatCodes)('%s renders its Bulgarian sentence', async (code, expected) => {
            getRequestContext.mockReturnValue({ requestId: 'r1', startTime: 0, uiLanguage: 'bg' });
            const english = 'Some English prose that must not survive.';
            const p = payloadFor(code, english);
            await localizeErrorPayload(p);
            expect(p.error.message).toBe(expected);
            // Three things that each look like success and are not: the English
            // surviving, the KEY leaking through (`t()` returns the key for a
            // namespace node), and a non-Cyrillic result.
            expect(p.error.message).not.toBe(english);
            expect(p.error.message).not.toContain('errors.');
            expect(p.error.message).toMatch(/[\u0400-\u04FF]/);
        });
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
