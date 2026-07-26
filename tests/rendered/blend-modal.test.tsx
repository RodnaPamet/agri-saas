/**
 * `BlendModal` — the entry point that made `grain-blend.ts` reachable.
 *
 * Shipped in #392 with no direct tests. The parts worth locking are not the
 * chrome:
 *
 *   - the quality preview **duplicates server arithmetic** (`blendQuality`), so
 *     it can silently disagree with what gets stored
 *   - it weights over the lots that actually CARRY an attribute, so one lot
 *     missing a moisture reading must not drag the average toward zero
 *   - mixed units are rejected client-side because the server rejects them, and
 *     submitting into a guaranteed 400 is a worse experience than saying so
 *   - the request must send whole-lot quantities and this bin as the destination
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

// The Modal primitive itself calls useRouter (for its discard-guard
// navigation interception), so the router must be mocked even though this
// component never navigates.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/grain/bins/bin-1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => (p: string) => `/t/acme${p}` };
});

const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiGet: jest.fn(),
    apiPatch: jest.fn(),
    apiDelete: jest.fn(),
}));

// Only produce items may be the blend output; the modal filters by category.
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({
        data: [
            { id: 'item-out', name: 'Blended Wheat', category: 'HARVESTED_PRODUCE' },
            { id: 'item-fert', name: 'Urea', category: 'FERTILIZER' },
        ],
        mutate: jest.fn(),
        isLoading: false,
    }),
}));

import { BlendModal } from '@/app/t/[tenantSlug]/(app)/grain/bins/[binId]/BlendModal';

const LOT_A = {
    id: 'lot-a',
    lotCode: 'WHEAT-A1',
    itemName: 'Milling Wheat',
    quantity: 100,
    unitSymbol: 't',
    attributes: { moisture: 12, protein: 11 } as Record<string, unknown> | null,
};
const LOT_B = {
    id: 'lot-b',
    lotCode: 'WHEAT-A2',
    itemName: 'Milling Wheat',
    quantity: 300,
    unitSymbol: 't',
    attributes: { moisture: 16, protein: 13 } as Record<string, unknown> | null,
};

function renderModal(lots = [LOT_A, LOT_B]) {
    const onBlended = jest.fn();
    render(
        <BlendModal
            open
            setOpen={jest.fn()}
            binId="bin-1"
            binName="Silo 3"
            lots={lots}
            onBlended={onBlended}
        />,
    );
    return { onBlended };
}

beforeEach(() => {
    jest.clearAllMocks();
    apiPost.mockResolvedValue({});
});

describe('BlendModal — source selection', () => {
    it('lists the bin’s lots with their quantities', () => {
        renderModal();
        expect(screen.getByText(/WHEAT-A1/)).toBeInTheDocument();
        expect(screen.getByText('100 t')).toBeInTheDocument();
        expect(screen.getByText('300 t')).toBeInTheDocument();
    });

    it('says so when the bin has nothing to blend', () => {
        renderModal([]);
        expect(screen.getByText(/No lots to blend yet/i)).toBeInTheDocument();
    });

    it('keeps confirm disabled until sources and an output item are chosen', async () => {
        renderModal();
        const confirm = screen.getByRole('button', { name: /Blend lots/i });
        expect(confirm).toBeDisabled();

        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        // Sources chosen but no output item yet.
        expect(confirm).toBeDisabled();
    });
});

describe('BlendModal — quality preview (mirrors blendQuality)', () => {
    it('weights the average by quantity, not by lot count', async () => {
        renderModal();
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A2' }));

        // 100 t @ 12% + 300 t @ 16% → (1200 + 4800) / 400 = 15, NOT the
        // unweighted mean of 14.
        expect(screen.getByText(/Moisture: 15/)).toBeInTheDocument();
        // Protein: (100×11 + 300×13) / 400 = 12.5
        expect(screen.getByText(/Protein: 12.5/)).toBeInTheDocument();
    });

    it('reports the blended total and lot count', async () => {
        renderModal();
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A2' }));
        expect(screen.getByText(/2 lots · 400 t blended/)).toBeInTheDocument();
    });

    it('weights over the lots that CARRY the attribute, not all selected lots', async () => {
        // Lot B has no moisture reading. Averaging over both would report 6%
        // for grain that is actually 12% — a missing reading is not a zero.
        renderModal([LOT_A, { ...LOT_B, attributes: { protein: 13 } }]);
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A2' }));

        expect(screen.getByText(/Moisture: 12/)).toBeInTheDocument();
    });

    it('shows no quality line when no lot carries an attribute', async () => {
        renderModal([{ ...LOT_A, attributes: null }]);
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        expect(screen.queryByText(/Moisture:/)).not.toBeInTheDocument();
    });
});

describe('BlendModal — mixed units', () => {
    it('refuses a mixed-unit selection instead of submitting into a 400', async () => {
        renderModal([LOT_A, { ...LOT_B, unitSymbol: 'kg' }]);
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A2' }));

        expect(screen.getByText(/different units and cannot be blended/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Blend lots/i })).toBeDisabled();
    });
});

describe('BlendModal — submission', () => {
    async function selectAndSubmit() {
        await userEvent.click(screen.getByRole('checkbox', { name: 'WHEAT-A1' }));
        // Pick the output product via the combobox.
        await userEvent.click(screen.getByRole('combobox'));
        await userEvent.click(screen.getByText('Blended Wheat'));
        await userEvent.click(screen.getByRole('button', { name: /Blend lots/i }));
    }

    it('posts whole-lot quantities with this bin as the destination', async () => {
        const { onBlended } = renderModal();
        await selectAndSubmit();

        expect(apiPost).toHaveBeenCalledTimes(1);
        const [url, body] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/grain/blend');
        expect(body).toMatchObject({
            sourceLots: [{ lotId: 'lot-a', quantity: 100 }],
            outputItemId: 'item-out',
            outputLocationId: 'bin-1',
        });
        expect(onBlended).toHaveBeenCalled();
    });

    it('surfaces a server rejection instead of closing silently', async () => {
        apiPost.mockRejectedValueOnce(new Error('Blended output does not fit in Silo 3'));
        const { onBlended } = renderModal();
        await selectAndSubmit();

        expect(await screen.findByRole('alert')).toHaveTextContent(/does not fit in Silo 3/);
        // A failed blend must not report success upward.
        expect(onBlended).not.toHaveBeenCalled();
    });
});
