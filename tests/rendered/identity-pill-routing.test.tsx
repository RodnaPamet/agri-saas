/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<TenantIdentityPill>` / `<OrgIdentityPill>`.
 *
 * Scope lock: a settled product decision is that BOTH pills route to
 * `/tenants` (the unified post-sign-in picker) — there is no
 * separate `/orgs` picker page. This test fails if a future change
 * silently re-points either pill, so the scope boundary cannot drift
 * by accident.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ tenantName: 'Acme Corp', tenantSlug: 'acme' }),
}));
jest.mock('@/lib/org-context-provider', () => ({
    useOrgContext: () => ({ orgName: 'Globex Org', orgSlug: 'globex' }),
}));

import { TenantIdentityPill, OrgIdentityPill } from '@/components/layout/IdentityPill';

describe('IdentityPill — routing stays at /tenants (scope-locked)', () => {
    it('TenantIdentityPill links to /tenants', () => {
        render(<TenantIdentityPill />);
        expect(
            screen.getByTestId('top-chrome-tenant-pill').getAttribute('href'),
        ).toBe('/tenants');
    });

    it('OrgIdentityPill links to /tenants — no separate /orgs picker', () => {
        render(<OrgIdentityPill />);
        expect(
            screen.getByTestId('top-chrome-org-pill').getAttribute('href'),
        ).toBe('/tenants');
    });

    it('both pills render an initials avatar for their context', () => {
        // The initials are `data-initials` + a `::before` rule, not a text
        // node — WCAG 2.5.3 (#2449), so `getByText` cannot see them. Asserting
        // the attribute keeps the original claim (each pill renders the avatar
        // for ITS context) against the new mechanism.
        const tenant = render(<TenantIdentityPill />);
        // "Acme Corp" → AC.
        expect(
            tenant.container.querySelector('[data-initials="AC"]'),
        ).not.toBeNull();
        const org = render(<OrgIdentityPill />);
        // "Globex Org" → GO.
        expect(org.container.querySelector('[data-initials="GO"]')).not.toBeNull();
    });
});
