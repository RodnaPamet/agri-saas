/**
 * ParcelOverviewMap — the half of it a screen reader can reach.
 *
 * ── Which branch these exercise ──────────────────────────────────────
 *
 * jsdom implements no 2D canvas context: `getContext('2d')` returns
 * null, so every drawing and hit-testing path in this component
 * silently no-ops here. That is not a gap these tests can close — it is
 * why the component was split. The arithmetic is executed in
 * `tests/unit/locations/parcel-overview-model.test.ts`; what is
 * asserted below is the DOM half, which is also the half that has to
 * work for keyboard and screen-reader users.
 *
 * ── Viewport ─────────────────────────────────────────────────────────
 *
 * Pinned to `desktop`. This component branches on no media query at all,
 * so the choice changes nothing — it is stated (and pinned) so the next
 * reader does not have to work that out, and so a future viewport-
 * dependent branch cannot appear untested under the phone default.
 *
 * Every `it()` names the production break it catches.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import enMessages from '../../messages/en.json';
import { setViewport, restoreViewport } from './viewport';
import type { ParcelOverview } from '@/app-layer/usecases/parcel-overview';

// The geometry is a 100 KB static asset fetched at runtime; jsdom has no
// server to fetch it from. Resolve it to the minimum the component reads.
jest.mock('@/lib/geo/bg-geometry-client', () => ({
    loadBgMapGeometry: () =>
        Promise.resolve({
            W: 1000,
            H: 600,
            proj: {
                minX: 22.3482,
                maxX: 28.60972,
                minY: 41.23384,
                maxY: 44.21002,
                cos: 0.734655,
                ox: 51.769,
                oy: 10,
                s: 194.8807,
            },
            oblasti: [],
            outlinePath: '',
        }),
    resetBgMapGeometryCache: () => {},
}));

import { ParcelOverviewMap } from '@/components/locations/ParcelOverviewMap';

const COPY = enMessages.locations.detail;

function makeOverview(over: Partial<ParcelOverview> = {}): ParcelOverview {
    return {
        clusters: [
            {
                id: 'cA',
                lon: 26.9,
                lat: 43.11,
                count: 12,
                parcelIds: ['p1', 'p2', 'p3'],
                totalAreaHa: 45.5,
                label: 'Драгоево',
            },
            {
                id: 'cB',
                lon: 26.7,
                lat: 43.2,
                count: 1,
                parcelIds: ['p4'],
                totalAreaHa: 3.1,
                label: null,
            },
        ],
        parcels: [
            { id: 'p1', lon: 26.9, lat: 43.11 },
            { id: 'p2', lon: 26.901, lat: 43.111 },
            { id: 'p3', lon: 26.902, lat: 43.112 },
            { id: 'p4', lon: 26.7, lat: 43.2 },
        ],
        bbox: [26.7, 43.09, 26.94, 43.2],
        positionedCount: 4,
        unpositionedCount: 0,
        unpositionedParcelIds: [],
        truncated: false,
        ...over,
    };
}

const NAMES = new Map([
    ['p1', 'Нива 1'],
    ['p2', 'Нива 2'],
    ['p3', 'Нива 3'],
    ['p4', 'Нива 4'],
]);

// Real outlines, as the page hands them over. jsdom implements no
// `Path2D`, so these are never rasterised here — the geometry maths that
// consumes them is executed in the model unit tests instead.
const SHAPES = [
    {
        id: 'p1',
        geometry: {
            type: 'MultiPolygon',
            coordinates: [[[[26.9, 43.11], [26.91, 43.11], [26.91, 43.12], [26.9, 43.12], [26.9, 43.11]]]],
        },
    },
    { id: 'p2', geometry: null },
];

function renderMap(props: Partial<React.ComponentProps<typeof ParcelOverviewMap>> = {}) {
    const onSelect = jest.fn();
    const onParcelOpen = jest.fn();
    const onZoomTierChange = jest.fn();
    render(
        <ParcelOverviewMap
            overview={makeOverview()}
            loading={false}
            error={false}
            parcelNames={NAMES}
            parcelShapes={SHAPES}
            selection={null}
            onSelect={onSelect}
            onParcelOpen={onParcelOpen}
            zoomTier={9}
            onZoomTierChange={onZoomTierChange}
            {...props}
        />,
    );
    return { onSelect, onParcelOpen, onZoomTierChange };
}

beforeEach(() => setViewport('desktop'));
afterEach(restoreViewport);

describe('ParcelOverviewMap — the non-canvas path', () => {
    // Break: the map being the ONLY route to the cluster filter, which
    // locks every keyboard and screen-reader user out of the feature.
    it('lists every cluster as a real button, not just canvas pixels', () => {
        renderMap();
        const list = screen.getByRole('list', { name: COPY.clusterListLabel });
        const buttons = within(list).getAllByRole('button');
        expect(buttons).toHaveLength(2);
        expect(buttons[0]).toHaveAccessibleName('Драгоево · 12 parcels');
        // A cluster the settlement lookup could not name still has to be
        // selectable — a null label must not render as "null" or vanish.
        expect(buttons[1]).toHaveAccessibleName(`${COPY.clusterUnnamed} · 1 parcel`);
    });

    // Break: clicking a group filtering the table to a LIVE re-lookup by
    // id, which stops matching the moment the grid pitch changes.
    it('hands back the member ids snapshotted at click time', async () => {
        const user = userEvent.setup();
        const { onSelect } = renderMap();
        await user.click(screen.getByRole('button', { name: 'Драгоево · 12 parcels' }));
        expect(onSelect).toHaveBeenCalledWith({
            id: 'cA',
            zoomTier: 9,
            parcelIds: ['p1', 'p2', 'p3'],
            label: 'Драгоево',
            count: 12,
        });
    });

    it('marks the active group pressed and clears it on a second click', async () => {
        const user = userEvent.setup();
        const selection = {
            id: 'cA',
            zoomTier: 9,
            parcelIds: ['p1', 'p2', 'p3'],
            label: 'Драгоево',
            count: 12,
        };
        const { onSelect } = renderMap({ selection });

        const active = screen.getByRole('button', { name: 'Драгоево · 12 parcels' });
        expect(active).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: `${COPY.clusterUnnamed} · 1 parcel` })).toHaveAttribute(
            'aria-pressed',
            'false',
        );

        await user.click(active);
        expect(onSelect).toHaveBeenCalledWith(null);
    });

    it('offers an explicit way back to the whole holding', async () => {
        const user = userEvent.setup();
        const { onSelect } = renderMap({
            selection: { id: 'cA', zoomTier: 9, parcelIds: ['p1'], label: 'Драгоево', count: 12 },
        });
        await user.click(screen.getByRole('button', { name: COPY.clusterClear }));
        expect(onSelect).toHaveBeenCalledWith(null);
    });

    // Break: a farm with un-geocoded parcels seeing a map of its holding
    // that quietly omits them — the silent data loss the endpoint's
    // unpositioned count exists to prevent, undone at the last step.
    it('surfaces unpositioned parcels as a reachable group', async () => {
        const user = userEvent.setup();
        const { onSelect } = renderMap({
            overview: makeOverview({
                unpositionedCount: 2,
                unpositionedParcelIds: ['p8', 'p9'],
            }),
        });

        const chip = screen.getByRole('button', { name: '2 parcels without a location' });
        await user.click(chip);
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'unpositioned', parcelIds: ['p8', 'p9'], count: 2 }),
        );
    });

    it('says nothing about unpositioned parcels when there are none', () => {
        renderMap();
        expect(screen.queryByText(/without a location/)).not.toBeInTheDocument();
    });

    // Break: a 2500-parcel holding getting a map of its first 2000 with
    // nothing on screen admitting it.
    it('admits when the read hit its bound', () => {
        renderMap({ overview: makeOverview({ truncated: true, positionedCount: 2000 }) });
        expect(screen.getByText('Only the first 2000 parcels are shown on the map.')).toBeInTheDocument();
    });

    it('names the canvas for assistive tech', () => {
        renderMap();
        expect(screen.getByRole('img', { name: COPY.overviewMapAria })).toBeInTheDocument();
    });

    it('reports a failed read instead of an empty map', () => {
        renderMap({ error: true, overview: null });
        expect(screen.getByText(COPY.overviewMapError)).toBeInTheDocument();
    });

    // Break: "no parcel has coordinates" and "this holding has no
    // parcels" rendering identically.
    it('distinguishes "nothing to place" from a failure', () => {
        renderMap({
            overview: makeOverview({ clusters: [], parcels: [], bbox: null, positionedCount: 0 }),
        });
        expect(screen.getByText(COPY.overviewMapEmpty)).toBeInTheDocument();
        expect(screen.queryByText(COPY.overviewMapError)).not.toBeInTheDocument();
    });
});
