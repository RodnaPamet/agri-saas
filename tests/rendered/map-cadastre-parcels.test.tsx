/**
 * Rendered test — MapCanvas cadastre (КККР) VECTOR parcels overlay.
 *
 * MapLibre/WebGL doesn't run under jsdom, so `react-map-gl/maplibre` is mocked
 * with lightweight components that expose the `<Source>` / `<Layer>` tree as
 * inspectable DOM. The mocked <Map> never wires a real map ref, so the viewport
 * fetch no-ops (getMap() → undefined) — this test asserts the load-bearing
 * wiring: passing `cadastreParcels` mounts the `cadastre-parcels` GeoJSON source
 * (+ its line layer); removing it unmounts them; an empty url renders nothing.
 */
import { render } from '@testing-library/react';
import * as React from 'react';

jest.mock('next-intl', () => ({
    // P2.1c — `useLocale` is part of this module and these mocks did not
    // provide it, so the first component to call it threw
    // "useLocale is not a function". The mock was incomplete relative to the
    // module, not wrong about this suite: `useDateFormat()` needs the active
    // locale, and a partial barrel mock turns a new dependency into a crash
    // across every suite that stubs it.
    useLocale: () => 'en',
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/components/ui/hooks', () => ({
    useReducedMotion: () => false,
}));

jest.mock('react-map-gl/maplibre', () => {
    const React = require('react');
    return {
        __esModule: true,
        default: ({ children }: { children?: React.ReactNode }) =>
            React.createElement('div', { 'data-testid': 'map' }, children),
        Map: ({ children }: { children?: React.ReactNode }) =>
            React.createElement('div', { 'data-testid': 'map' }, children),
        Source: ({ id, children }: { id: string; children?: React.ReactNode }) =>
            React.createElement('div', { 'data-source-id': id }, children),
        Layer: ({ id }: { id: string }) => React.createElement('div', { 'data-layer-id': id }),
        Marker: ({ children }: { children?: React.ReactNode }) =>
            React.createElement('div', null, children),
    };
});

import { MapCanvas } from '@/components/ui/map/MapCanvas';

const PARCELS_URL = '/api/t/acme/cadastre/parcels';

beforeEach(() => {
    // Defensive: the mocked map ref means the viewport fetch is never actually
    // reached (getMap() → undefined), but stub `fetch` so an accidental call
    // can't hit the network. jsdom has no `Response`, so return a plain shape.
    global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ type: 'FeatureCollection', features: [] }),
    }) as unknown as typeof fetch;
});

describe('MapCanvas cadastre vector parcels overlay', () => {
    it('renders no parcels source when the overlay is absent', () => {
        const { container } = render(<MapCanvas parcels={[]} />);
        expect(container.querySelector('[data-source-id="cadastre-parcels"]')).toBeNull();
    });

    it('mounts the parcels GeoJSON source + line layer when the overlay is passed', () => {
        const { container } = render(<MapCanvas parcels={[]} cadastreParcels={{ url: PARCELS_URL }} />);
        expect(container.querySelector('[data-source-id="cadastre-parcels"]')).not.toBeNull();
        expect(container.querySelector('[data-layer-id="cadastre-parcels-line"]')).not.toBeNull();
    });

    it('does not mount the source when the url is empty', () => {
        const { container } = render(<MapCanvas parcels={[]} cadastreParcels={{ url: '' }} />);
        expect(container.querySelector('[data-source-id="cadastre-parcels"]')).toBeNull();
    });

    it('unmounts the parcels source when the overlay is toggled off', () => {
        const { container, rerender } = render(
            <MapCanvas parcels={[]} cadastreParcels={{ url: PARCELS_URL }} />,
        );
        expect(container.querySelector('[data-source-id="cadastre-parcels"]')).not.toBeNull();
        rerender(<MapCanvas parcels={[]} cadastreParcels={null} />);
        expect(container.querySelector('[data-source-id="cadastre-parcels"]')).toBeNull();
    });
});
