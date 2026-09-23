/**
 * The language a reader gets, and why it is not the cookie.
 *
 * `getTranslations()` resolves from `NEXT_LOCALE`. That is wrong for anything
 * a NATIVE client can reach: a bearer session carries no cookie, so a
 * cookie-derived locale silently hands the phone the unauthenticated default
 * (`en`) — and the phone is the surface most of this product's localisation
 * exists for. Nothing would have errored; the labels would just have been
 * English on a Bulgarian screen, which is the defect being fixed.
 *
 * So the resolution reads the caller's own `uiLanguage`, and it must FAIL
 * SOFT: a locale lookup that throws should cost a reader their language, not
 * the page they asked for.
 */
const findFirst = jest.fn();
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantMembership: { findFirst } }),
}));

import { resolveReaderLocale } from '@/app-layer/usecases/reader-locale';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });

beforeEach(() => jest.clearAllMocks());

describe('resolving the reader’s locale', () => {
    it('uses the member’s stored uiLanguage', async () => {
        findFirst.mockResolvedValue({ user: { uiLanguage: 'en' } });
        expect(await resolveReaderLocale(CTX)).toBe('en');
    });

    it('falls back to bg, not to the unauthenticated default', async () => {
        // DEFAULT_LOCALE is `en` for signed-out surfaces. A member of a
        // Bulgarian farm is not that, and four of five users carry `bg`.
        findFirst.mockResolvedValue({ user: { uiLanguage: null } });
        expect(await resolveReaderLocale(CTX)).toBe('bg');
    });

    it('falls back when there is no membership row at all', async () => {
        findFirst.mockResolvedValue(null);
        expect(await resolveReaderLocale(CTX)).toBe('bg');
    });

    it('ignores a value that is not a known locale', async () => {
        // The column is a string; a hand-edited row must not become a locale.
        findFirst.mockResolvedValue({ user: { uiLanguage: 'klingon' } });
        expect(await resolveReaderLocale(CTX)).toBe('bg');
    });

    it('FAILS SOFT when the lookup throws', async () => {
        // The load-bearing one. This resolution precedes a read the caller
        // actually wants; a database hiccup here must cost a language, not a
        // page. Without the catch, a Trends request would 500 because of a
        // preference lookup.
        findFirst.mockRejectedValue(new Error('connection reset'));
        await expect(resolveReaderLocale(CTX)).resolves.toBe('bg');
    });

    it('scopes the read to the caller, not just the tenant', async () => {
        findFirst.mockResolvedValue({ user: { uiLanguage: 'bg' } });
        await resolveReaderLocale(CTX);
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 't1', userId: 'u1' }),
            }),
        );
    });
});
