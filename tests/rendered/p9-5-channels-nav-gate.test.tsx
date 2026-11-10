/**
 * The «Канали» sidebar item is gated on a FLAG, not a module (P9.5, #2939).
 *
 * ## Why this is its own file, and executing rather than a guard
 *
 * Every other `visible:` in `useNavSections()` reads
 * `tenant.availableModules` — module availability, with an "absent ⇒ all
 * available" graceful degrade. `social.channels` is a feature FLAG, and flags
 * are server-only by design: there is no client-side flags hook, and adding
 * one would be a second source of truth for a kill switch (P5.3). So the flag
 * is resolved in the tenant layout and carried on the context, following
 * `googleIntegrationEnabled` (#2019).
 *
 * That makes this item the first in the hook whose polarity is INVERTED
 * against its neighbours — absent means hidden, not available — and polarity
 * is exactly the kind of thing a source-reading guard cannot grade. Hence a
 * rendered test that runs the hook.
 *
 * ## The load-bearing case is the LAST one
 *
 * It must not be ANDed with the EXCHANGE module even though it renders inside
 * the «Пазар» section. P8.4 is the instance: a farm that switched the
 * marketplace off would lose a surface that has nothing to do with the
 * marketplace, and because a module gate REDIRECTS, the symptom is "my
 * channels vanished" rather than an error anybody can act on. Measured on
 * production at the time: 3 live tenants, 0 with customised
 * `TenantModuleSettings`, so the trap cost nobody — which is precisely why it
 * would have shipped.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { useNavSections } from '@/components/layout/SidebarNav';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'bg',
}));

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/dashboard',
    useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

// The calendar badge fetches; it is irrelevant here and must not make the
// hook asynchronous.
jest.mock('@/components/layout/use-calendar-badge', () => ({
    useCalendarBadge: () => undefined,
}));

function Probe() {
    const sections = useNavSections();
    const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    return <div data-testid="hrefs">{hrefs.join(' ')}</div>;
}

function mount(over: Partial<TenantContextValue>) {
    const value = {
        tenantId: 't1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role: 'OWNER',
        permissions: {
            canRead: true, canWrite: true, canAdmin: true,
            canAudit: true, canExport: true,
        },
        appPermissions: {},
        ...over,
    } as unknown as TenantContextValue;
    return render(
        <TenantProvider value={value}>
            <Probe />
        </TenantProvider>,
    );
}

afterEach(restoreViewport);

describe('«Канали» nav visibility', () => {
    it('is PRESENT when the flag is on', () => {
        setViewport('desktop');
        mount({ channelsEnabled: true });
        expect(screen.getByTestId('hrefs').textContent).toContain('/t/acme/channels');
    });

    it('is ABSENT when the flag is off', () => {
        setViewport('desktop');
        mount({ channelsEnabled: false });
        expect(screen.getByTestId('hrefs').textContent).not.toContain('/t/acme/channels');
    });

    it('is ABSENT when the flag is UNDEFINED — degrading CLOSED', () => {
        setViewport('desktop');
        // The POLARITY, and it is inverted against every neighbour in this
        // hook. `social.channels` is default-OFF, so for most tenants the
        // surface answers 404 — and a nav item leading to a 404 is worse than
        // an absent one. An old session that predates the field carries
        // nothing, which must read as hidden.
        mount({});
        expect(screen.getByTestId('hrefs').textContent).not.toContain('/t/acme/channels');
    });

    it('is PRESENT with the EXCHANGE module OFF — it is not the marketplace', () => {
        setViewport('desktop');
        // THE LOAD-BEARING CASE. A channel depends on no module. ANDing this
        // with `exchangeAvailable` because it sits in the «Пазар» section is
        // the mistake P8.4 made for DMs, and it fails as a REDIRECT, so the
        // symptom is "my channels vanished".
        mount({ channelsEnabled: true, availableModules: ['GRAIN'] });
        const hrefs = screen.getByTestId('hrefs').textContent!;
        expect(hrefs).toContain('/t/acme/channels');
        // The control: the exchange item IS gone, so the module list was
        // genuinely applied and this is not a test of an ignored prop.
        expect(hrefs).not.toContain('/t/acme/exchange');
    });
});
