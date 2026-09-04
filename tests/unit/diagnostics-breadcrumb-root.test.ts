/**
 * The diagnostics breadcrumb must not strand the persona #812 just let in.
 *
 * This page carries a breadcrumb precisely BECAUSE it has no nav entry — the
 * trail is the only way back out. Its root pointed at `/t/<slug>/dashboard`,
 * which `isOperatorAllowedPath` denies, so opening the page to the
 * MECHANISATOR would have put a bouncing link at the top of the one screen we
 * had just made reachable for them.
 *
 * The two assertions are checked against the REAL predicate rather than a
 * hard-coded string, so this test cannot drift away from the allowlist it
 * depends on: if someone later removes `my-work` from the operator surface,
 * this fails rather than silently certifying a dead link.
 */
import { diagnosticsBreadcrumbRoot } from '@/app/t/[tenantSlug]/(app)/diagnostics/offline/breadcrumb-root';
import { isOperatorAllowedPath } from '@/lib/auth/guard';

const slug = 'acme';

describe('diagnosticsBreadcrumbRoot', () => {
    it('sends the operator somewhere the operator lockdown actually permits', () => {
        const root = diagnosticsBreadcrumbRoot('MECHANISATOR', slug);
        expect(root.isOperator).toBe(true);
        // The decisive assertion — not `toBe('/t/acme/my-work')`, which would
        // pass over any string and tell us nothing about reachability.
        expect(isOperatorAllowedPath(root.href, slug)).toBe(true);
    });

    it('sends everyone else to the dashboard, which the operator may NOT reach', () => {
        for (const role of ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR'] as const) {
            const root = diagnosticsBreadcrumbRoot(role, slug);
            expect(root.isOperator).toBe(false);
            expect(root.href).toBe(`/t/${slug}/dashboard`);
        }
        // Anti-vacuity in the other direction: this proves the two branches
        // are genuinely different destinations, not the same one twice.
        expect(isOperatorAllowedPath(`/t/${slug}/dashboard`, slug)).toBe(false);
    });
});
