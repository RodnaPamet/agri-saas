/**
 * `BinDetailClient` — the bin detail page's client island.
 *
 * Shipped in #392 with no direct tests. Covered here behaviourally rather than
 * for a coverage number: this page is where a farmer reads how full a bin is
 * and where the destructive actions live, and several of its rules were the
 * point of the roadmap.
 *
 * What's asserted:
 *   - quantities render in each LOT'S OWN unit (only the bin total is tonnes,
 *     because only that is compared against a tonnes capacity)
 *   - unconvertible stock is stated beside the tonnage, never folded into it
 *   - an ARCHIVED bin is visibly archived (the grain UI cannot change status,
 *     so it must not look live)
 *   - `lotsTruncated` says so, instead of a capped list looking complete
 *   - write actions are absent for a READER
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

const push = jest.fn();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => (p: string) => `/t/acme${p}` };
});

// The blend modal has its own suite; stub it so this one stays about the page.
jest.mock('@/app/t/[tenantSlug]/(app)/grain/bins/[binId]/BlendModal', () => ({
    BlendModal: ({ open }: { open: boolean }) => (open ? <div data-testid="blend-modal" /> : null),
}));
jest.mock('@/app/t/[tenantSlug]/(app)/grain/bins/BinFormModal', () => ({
    BinFormModal: ({ open }: { open: boolean }) => (open ? <div data-testid="bin-form-modal" /> : null),
}));

const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiDelete: (...a: unknown[]) => apiDelete(...a),
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    apiPatch: jest.fn(),
}));

import { BinDetailClient, type BinDetail } from '@/app/t/[tenantSlug]/(app)/grain/bins/[binId]/BinDetailClient';

function bin(over: Partial<BinDetail> = {}): BinDetail {
    return {
        id: 'bin-1',
        name: 'Silo 3',
        key: 'S3',
        kind: 'BIN',
        status: 'ACTIVE',
        description: null,
        capacityTonnes: 500,
        storedTonnes: 320,
        lotCount: 2,
        fillPct: 0.64,
        mixedUnits: false,
        unconvertible: [],
        lots: [
            {
                id: 'lot-1',
                lotCode: 'WHEAT-A1',
                itemId: 'item-1',
                itemName: 'Milling Wheat',
                quantity: 180,
                unitSymbol: 't',
                expiresAt: null,
                attributes: { moisture: 13.2, protein: 12.1 },
            },
        ],
        lotsTruncated: false,
        ...over,
    };
}

const WRITE = { canWrite: true };
const READ = { canWrite: false };

beforeEach(() => jest.clearAllMocks());

describe('BinDetailClient — reading the bin', () => {
    it('names the bin and lists the lots inside it', () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />);
        // Appears twice by design: the breadcrumb trail's leaf and the title.
        expect(screen.getAllByText('Silo 3').length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('WHEAT-A1')).toBeInTheDocument();
        expect(screen.getByText('Milling Wheat')).toBeInTheDocument();
    });

    it('shows each lot in ITS OWN unit, not converted', () => {
        // The bin total is tonnes because it is compared to a tonnes capacity.
        // A per-lot row is whatever the farmer wrote on the lot.
        render(
            <BinDetailClient
                bin={bin({
                    lots: [
                        { ...bin().lots[0], quantity: 320, unitSymbol: 'kg' },
                    ],
                })}
                tenantSlug="acme"
                permissions={WRITE}
            />,
        );
        expect(screen.getByText('320 kg')).toBeInTheDocument();
    });

    it('renders the grain quality attributes', () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />);
        expect(screen.getByText('13.2')).toBeInTheDocument();
        expect(screen.getByText('12.1')).toBeInTheDocument();
    });

    it('renders an em dash for a missing quality reading', () => {
        render(
            <BinDetailClient
                bin={bin({ lots: [{ ...bin().lots[0], attributes: null }] })}
                tenantSlug="acme"
                permissions={WRITE}
            />,
        );
        // moisture / protein / testWeight all absent.
        expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });
});

describe('BinDetailClient — honest fill', () => {
    it('states unconvertible stock beside the tonnage instead of hiding it', () => {
        render(
            <BinDetailClient
                bin={bin({
                    mixedUnits: true,
                    fillPct: null,
                    unconvertible: [
                        { unitKey: 'each', symbol: 'ea', quantity: 40, lotCount: 1 },
                    ],
                })}
                tenantSlug="acme"
                permissions={WRITE}
            />,
        );
        // The "also holds …" line names the quantity that has no tonnage.
        expect(screen.getByText(/40 ea/)).toBeInTheDocument();
        // And the fill is reported as mixed rather than as a partial percentage.
        expect(screen.getByText('Mixed units')).toBeInTheDocument();
    });

    it('marks an ARCHIVED bin as archived', () => {
        // The grain UI cannot change a Location's status, so an archived bin
        // must be visibly archived rather than silently looking live.
        render(
            <BinDetailClient bin={bin({ status: 'ARCHIVED' })} tenantSlug="acme" permissions={WRITE} />,
        );
        expect(screen.getByText('Archived')).toBeInTheDocument();
    });

    it('does not claim archived for a live bin', () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />);
        expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    });

    it('says so when the lot list was truncated', () => {
        // The totals above stay exact (they come from a grouped aggregate), but
        // a capped list must not look complete.
        render(<BinDetailClient bin={bin({ lotsTruncated: true })} tenantSlug="acme" permissions={WRITE} />);
        expect(screen.getByText(/first 200 lots/i)).toBeInTheDocument();
    });

    it('omits the truncation notice when the list is complete', () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />);
        expect(screen.queryByText(/first 200 lots/i)).not.toBeInTheDocument();
    });

    it('renders an empty state when the bin holds nothing', () => {
        render(
            <BinDetailClient
                bin={bin({ lots: [], lotCount: 0, storedTonnes: 0 })}
                tenantSlug="acme"
                permissions={WRITE}
            />,
        );
        expect(screen.getByText(/Nothing stored here yet/i)).toBeInTheDocument();
    });
});

describe('BinDetailClient — permissions and actions', () => {
    it('offers no write actions to a READER', () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={READ} />);
        expect(screen.queryByRole('button', { name: /Edit bin/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Blend$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Delete$/i })).not.toBeInTheDocument();
    });

    it('still lets a READER read the contents', () => {
        // The whole point of the detail page: a row-click used to open the edit
        // form, so a READER got an inert table.
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={READ} />);
        expect(screen.getByText('WHEAT-A1')).toBeInTheDocument();
    });

    it('opens the edit modal from the header', async () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />);
        await userEvent.click(screen.getByRole('button', { name: /Edit bin/i }));
        expect(screen.getByTestId('bin-form-modal')).toBeInTheDocument();
    });

    it('opens the blend modal, and disables it for an empty bin', async () => {
        const { unmount } = render(
            <BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />,
        );
        await userEvent.click(screen.getByRole('button', { name: /^Blend$/i }));
        expect(screen.getByTestId('blend-modal')).toBeInTheDocument();
        unmount();

        render(<BinDetailClient bin={bin({ lots: [] })} tenantSlug="acme" permissions={WRITE} />);
        expect(screen.getByRole('button', { name: /^Blend$/i })).toBeDisabled();
    });

    it('navigates to a lot when its row is clicked', async () => {
        render(<BinDetailClient bin={bin()} tenantSlug="acme" permissions={WRITE} />);
        await userEvent.click(screen.getByText('WHEAT-A1'));
        expect(push).toHaveBeenCalledWith('/t/acme/inventory?lotId=lot-1');
    });
});
