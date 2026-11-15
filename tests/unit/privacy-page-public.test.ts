/**
 * The privacy notice must be reachable WITHOUT an account.
 *
 * This shipped broken: the page was added and allowlisted in the
 * tenant-isolation structural guard (so it may live outside `/t/[tenantSlug]`),
 * but NOT in the middleware's public-path allowlist — two separate lists that
 * both have to agree. In production `/privacy` answered `307 → /login?next=…`.
 *
 * That is worse than having no page. The consent box links to it in a new tab
 * before a farmer submits a request, and a prospective user has to be able to
 * read it before signing up — so a login wall makes the link a dead end while
 * still *looking* like a policy is on offer, which is the exact defect the
 * promotions work removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
import { isPublicPath } from '../../src/lib/auth/guard';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the privacy notice is publicly reachable', () => {
    it('is in the middleware public-path allowlist', () => {
        // Through the real predicate rather than a regex over `guard.ts` —
        // see the note in `legal-pages-public.test.ts`. The policy paths are
        // derived from one constant since #3085, so the literal no longer
        // appears as its own list line while the page is MORE certainly
        // public than before.
        expect(isPublicPath('/privacy')).toBe(true);
    });

    it('is also allowed to live outside /t/[tenantSlug]', () => {
        // Both lists must agree — satisfying only one is how this broke.
        const structural = read('tests/unit/tenant-isolation-structural.test.ts');
        expect(structural).toMatch(/'privacy',/);
    });

    it('the consent notice links to it', () => {
        const modal = read('src/app/t/[tenantSlug]/(app)/offers/AskForOfferModal.tsx');
        expect(modal).toMatch(/'\/privacy'/);
    });

    it('the page renders no tenant data — nothing to gate', () => {
        // The justification for it being public. If it ever reads tenant
        // context, the allowlist entry above stops being safe.
        const page = read('src/app/privacy/page.tsx');
        expect(page).not.toMatch(/useTenantContext|getTenantCtx|tenantSlug/);
    });
});
