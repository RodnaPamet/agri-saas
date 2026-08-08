/**
 * Asset create/edit form fields — agricultural rework.
 *   - Create: type / criticality / status are dropdowns; owner is a
 *     people-picker; manufacturer / model / serial / year / purchase
 *     cost are text inputs. No information-security CIA sliders.
 *   - Edit: type / status / criticality dropdowns; manufacturer + the
 *     other ag attributes as text inputs; no Classification / Data
 *     Residency.
 *   - Detail: shows the ag attributes; no CIA badge / classification.
 */
// The asset forms now render <AssetLocationField>, which reads the
// tenant's Location list via useTenantSWR and therefore needs tenant
// context. These tests mount the field groups bare (no TenantProvider),
// so stub the context module — same idiom as
// tests/rendered/evidence-upload-optimistic.test.tsx. The empty list
// keeps the picker rendered but with no options, which is exactly the
// state these assertions care about (they are about the OTHER fields).
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantContext: () => ({ tenantSlug: 'acme', permissions: { canWrite: true } }),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: [], error: undefined, isLoading: false, mutate: jest.fn() }),
}));

import { render, screen } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/assets',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

// NewAssetFields / EditAssetFields use `useTranslations('assets')` for
// their non-prop labels + placeholders. Echo the key so assertions can
// match the message key.
jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
}));

import { NewAssetFields } from '@/app/t/[tenantSlug]/(app)/assets/_form/NewAssetFields';
import { EditAssetFields } from '@/app/t/[tenantSlug]/(app)/assets/_form/EditAssetFields';

beforeEach(() => {
    global.fetch = jest.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    ) as unknown as typeof fetch;
});

function withClient(node: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>,
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockForm(fields: Record<string, any>): any {
    return {
        fields,
        setField: jest.fn(),
        touchField: jest.fn(),
        fieldError: () => undefined,
        submitting: false,
        error: null,
        canSubmit: true,
        submit: jest.fn(),
        isDirty: false,
    };
}

const NEW_LABELS = { name: 'Name', type: 'Type', owner: 'Owner', location: 'Location' };

describe('NewAssetFields (create)', () => {
    const form = mockForm({
        name: '', type: 'TRACTOR', status: 'ACTIVE', criticality: undefined,
        ownerUserId: '', location: '', manufacturer: '', model: '',
        serialNumber: '', year: undefined, purchaseDate: '', purchaseCost: undefined,
    });

    it('type, criticality, status, and owner are dropdown buttons (not text inputs)', () => {
        withClient(<NewAssetFields form={form} labels={NEW_LABELS} tenantSlug="acme" />);
        for (const id of ['asset-type-select', 'asset-criticality-select', 'asset-status-select', 'asset-owner-input']) {
            const el = document.getElementById(id);
            expect(el).not.toBeNull();
            expect(el!.tagName.toLowerCase()).toBe('button'); // Combobox/UserCombobox trigger
        }
    });

    it('renders agricultural attribute text inputs and no CIA sliders', () => {
        const { container } = withClient(<NewAssetFields form={form} labels={NEW_LABELS} tenantSlug="acme" />);
        for (const id of ['asset-manufacturer-input', 'asset-model-input', 'asset-serial-input', 'asset-year-input', 'asset-purchase-cost-input']) {
            const el = document.getElementById(id);
            expect(el).not.toBeNull();
            expect(el!.tagName.toLowerCase()).toBe('input');
        }
        // The information-security CIA sliders are gone.
        expect(container.querySelectorAll('input[type="range"]').length).toBe(0);
        expect(screen.queryByText('Asset Criticality')).toBeNull();
    });
});

describe('EditAssetFields (edit)', () => {
    const form = mockForm({
        name: 'A', type: 'TRACTOR', criticality: 'MEDIUM', status: 'ACTIVE',
        ownerUserId: '', owner: 'legacy', externalRef: 'EXT-1', location: '',
        manufacturer: 'John Deere', model: '6155R', serialNumber: 'X',
        year: '2021', purchaseDate: '', purchaseCost: '145000',
    });

    it("labels the people-picker 'Assigned to' and exposes editable Keeper + External Ref", () => {
        // B4/B5: the structured people-picker is now labelled `assignedTo`,
        // and the free-text keeper (`owner`) + `externalRef` are editable
        // fields. i18n mock echoes the message key.
        withClient(<EditAssetFields form={form} tenantSlug="acme" />);
        expect(screen.getByText('assignedTo')).not.toBeNull();
        expect(screen.getByText('keeper')).not.toBeNull();
        expect(screen.getByText('externalRef')).not.toBeNull();
        // The bare 'owner' label is gone — the picker no longer claims it.
        expect(screen.queryByText('owner')).toBeNull();
    });

    it('has Criticality + Manufacturer fields and no Classification / Data Residency', () => {
        const { container } = withClient(<EditAssetFields form={form} tenantSlug="acme" />);
        const labels = [...container.querySelectorAll('label.input-label')].map(
            (l) => l.textContent,
        );
        // i18n keys (mock echoes the key). Name label renders "name *".
        expect(labels).toContain('criticality');
        expect(labels).toContain('manufacturer');
        expect(labels).toContain('status');
        expect(labels).not.toContain('Classification');
        expect(labels).not.toContain('Data Residency');
    });

    it('type / criticality / status dropdown triggers are full-width', () => {
        const { container } = withClient(<EditAssetFields form={form} tenantSlug="acme" />);
        const triggers = container.querySelectorAll('button.w-full');
        expect(triggers.length).toBeGreaterThanOrEqual(3); // type, status, criticality
    });
});

describe('asset detail page source', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx'),
        'utf8',
    );
    it('no longer renders the Suggest Risks action', () => {
        expect(src).not.toMatch(/suggest-risks-btn/);
        expect(src).not.toMatch(/Suggest Risks/);
    });
    it('shows agricultural attributes and no information-security fields', () => {
        // Labels are now i18n keys (`t('manufacturer')` / `t('serialNumber')`).
        expect(src).toMatch(/manufacturer/);
        expect(src).toMatch(/serialNumber/);
        expect(src).not.toMatch(/AssetCriticalityBadge/);
        expect(src).not.toMatch(/Data Residency/);
        expect(src).not.toMatch(/>Classification</);
    });
});
