/** @jest-environment jsdom */
/**
 * Offline with no basemap pack, the map showed an EMPTY RECTANGLE — and not
 * merely a missing backdrop: NO PARCELS EITHER.
 *
 * `activeStyle` swapped to an offline style only when a pack template was
 * passed, and exactly one call site passes one (the Location detail page). The
 * two OPERATOR surfaces — /field/[taskId] (the 60vh map) and
 * /farm-tasks/[taskId] — pass nothing, so offline they fell through to the
 * cross-origin style URL. The style DOCUMENT never loads, so MapLibre mounts
 * no layers at all and the parcel geometry has nothing to draw into.
 *
 * The pack template is tenant+location-scoped, so those routes structurally
 * cannot supply one. Flat ground with real parcels is the honest ceiling.
 *
 * Why this file has its OWN Map stub: the existing map test doubles render
 * `({children}) => <div>` and DISCARD `mapStyle` entirely — so every assertion
 * about which style is chosen was, until now, unobservable.
 */
import { render, screen, act } from '@testing-library/react';

const styles: unknown[] = [];

jest.mock('react-map-gl/maplibre', () => {
    const React = require('react');
    return {
        __esModule: true,
        // Captures mapStyle — the whole point of this file.
        default: ({ children, mapStyle }: { children?: React.ReactNode; mapStyle: unknown }) => {
            styles.push(mapStyle);
            return React.createElement('div', { 'data-testid': 'map' }, children);
        },
        Source: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
        Layer: () => null,
        Marker: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
    };
});
jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { MapCanvas } from '@/components/ui/map/MapCanvas';

const PARCELS = [{ id: 'p1', name: 'Block A', areaHa: 3, geometry: null }];

function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}
const json = (v: unknown) => JSON.stringify(v ?? null);

beforeEach(() => { styles.length = 0; setOnline(true); });
afterEach(() => setOnline(true));

describe('offline with no pack: fields on flat ground, never an empty rectangle', () => {
    it('uses a style that makes ZERO network requests', async () => {
        setOnline(false);
        await act(async () => { render(<MapCanvas parcels={PARCELS} />); });

        const last = styles[styles.length - 1];
        // No URL of any kind — the hermeticity property, asserted not assumed.
        expect(json(last)).not.toContain('://');
        // And it is a real style object with a layer, so parcels have
        // something to mount into. A bare string URL would be the old bug.
        expect(typeof last).toBe('object');
        expect(json(last)).toContain('background');
    });

    it('says why the backdrop is missing', async () => {
        setOnline(false);
        await act(async () => { render(<MapCanvas parcels={PARCELS} />); });
        expect(screen.getByTestId('map-no-basemap')).toBeInTheDocument();
    });

    it('NEVER pre-empts a pack the operator deliberately downloaded', async () => {
        // The regression that matters most. A downloaded pack is the
        // operator's own work; falling back over it would discard it.
        setOnline(false);
        await act(async () => {
            render(<MapCanvas parcels={PARCELS} offlineBasemapTileUrl="/api/t/acme/locations/loc-1/basemap/{z}/{x}/{y}" />);
        });

        expect(json(styles[styles.length - 1])).toContain('/basemap/');
        expect(screen.queryByTestId('map-no-basemap')).not.toBeInTheDocument();
    });

    it('CONTROL: online is untouched', async () => {
        // Without this the assertions above hold for a build that shows flat
        // ground to everyone, permanently, including in the office.
        await act(async () => { render(<MapCanvas parcels={PARCELS} />); });

        expect(json(styles[styles.length - 1])).not.toContain('background');
        expect(screen.queryByTestId('map-no-basemap')).not.toBeInTheDocument();
    });

    it('reuses ONE fallback style object across signal flapping', async () => {
        // react-map-gl diffs mapStyle by REFERENCE, so a fresh object means a
        // full setStyle() on a phone.
        //
        // Note what this does NOT test: plain re-renders. useMemo already
        // holds the reference steady while its deps are unchanged, so a
        // version building the style inline passes that — I know, because the
        // first version of this test did. The const only earns its keep when
        // the deps CHANGE AND CHANGE BACK, which on rural LTE is not a corner
        // case: it is the normal condition.
        setOnline(false);
        await act(async () => { render(<MapCanvas parcels={PARCELS} />); });
        const firstOffline = styles[styles.length - 1];

        await act(async () => { window.dispatchEvent(new Event('online')); });
        await act(async () => { window.dispatchEvent(new Event('offline')); });
        const secondOffline = styles[styles.length - 1];

        expect(secondOffline).toBe(firstOffline);
    });
});
