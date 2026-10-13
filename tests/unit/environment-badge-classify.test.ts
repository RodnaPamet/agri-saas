/**
 * Which hostnames show which badge.
 *
 * `environment-badge.tsx` had NO test naming it — one of the 15 such files
 * #1471 measured — and its rules are the whole contract of a badge whose job
 * is to stop somebody mistaking staging for production. Written BEFORE the
 * `useSyncExternalStore` conversion so the conversion has something to be
 * checked against, which is #1471's own rule.
 *
 * `classifyEnv` is exported for this: driving these cases through
 * `window.location` would make each one a jsdom navigation, and the
 * interesting content is the string rules, not the plumbing.
 */
import { classifyEnv } from '@/components/layout/environment-badge';

describe('classifyEnv — which hostnames are not production', () => {
    it.each([
        ['localhost', 'dev'],
        ['127.0.0.1', 'dev'],
        ['agrent.local', 'dev'],
        ['my-box.local', 'dev'],
    ])('%s → %s', (host, expected) => {
        expect(classifyEnv(host)).toBe(expected);
    });

    it.each([
        ['staging.agrent.bg', 'staging'],
        ['app.staging.agrent.bg', 'staging'],
        ['app-staging.agrent.bg', 'staging'],
    ])('%s → %s', (host, expected) => {
        expect(classifyEnv(host)).toBe(expected);
    });

    it.each([
        ['dev.agrent.bg', 'dev'],
        ['app-dev.agrent.bg', 'dev'],
    ])('%s → %s', (host, expected) => {
        expect(classifyEnv(host)).toBe(expected);
    });

    it('the LIVE host is production, so no badge', () => {
        // The one case that must never be wrong in the other direction: a
        // badge on production tells a farmer their data might not be real.
        expect(classifyEnv('app.agrent.bg')).toBe('prod');
        expect(classifyEnv('agrent.bg')).toBe('prod');
    });

    it('is case-insensitive', () => {
        expect(classifyEnv('STAGING.AGRENT.BG')).toBe('staging');
        expect(classifyEnv('LocalHost')).toBe('dev');
    });

    it('staging wins over dev when a host matches both', () => {
        // `dev.staging.agrent.bg` contains `dev.` AND `.staging.`. The order
        // of the checks decides, and the answer should be the more alarming
        // one — a reader who is told "dev" may assume throwaway data on a
        // staging box that mirrors production.
        expect(classifyEnv('dev.staging.agrent.bg')).toBe('staging');
    });

    it('does NOT match a substring inside a longer label', () => {
        // The failure this catches: a rule written as `host.includes('dev')`
        // would classify these as dev. The real rules anchor on a dot or a
        // dash, so a tenant or product name containing those letters is
        // production.
        expect(classifyEnv('devon-farms.agrent.bg')).toBe('prod');
        expect(classifyEnv('app.agrent.bg')).toBe('prod');
    });
});
