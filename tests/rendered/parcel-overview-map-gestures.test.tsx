/** @jest-environment jsdom */

/**
 * ParcelOverviewMap — the half of it that draws, executed.
 *
 * ── Why this file exists at all ──────────────────────────────────────
 *
 * `parcel-overview-map.test.tsx` covers the DOM half and says, correctly,
 * that jsdom implements no 2D context: `getContext('2d')` returns null, so
 * every drawing and hit-testing path in the component silently no-ops
 * there. That is the exact shape of failure CLAUDE.md warns about — a
 * suite that is green about a branch it has never run. Zoom clamping, the
 * two-finger gestures and the stepper's flight all live in that branch.
 *
 * So this suite installs what jsdom is missing — a recording 2D context, a
 * `Path2D`, a laid-out canvas — and then drives real events. The recorded
 * `setTransform` calls are the view's pan and zoom, in numbers: the
 * component writes them from a ref that nothing outside it can read, and
 * the transform is the only place they become observable. Assertions are
 * therefore on what was PAINTED, which is also what the operator sees.
 *
 * ── Viewport ─────────────────────────────────────────────────────────
 *
 * Left at the project default (a phone, per `tests/rendered/setup.ts`).
 * The component branches on no width media query; it does branch on
 * `prefers-reduced-motion`, and the default stub answers `matches: false`
 * to every query, so the ANIMATED path is the one these tests run. The
 * reduced-motion branch is unreachable under that stub, so the one test
 * that means it installs its own `matchMedia` — the tooltip-touch lesson,
 * applied rather than restated.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ParcelOverview } from '@/app-layer/usecases/parcel-overview';

jest.mock('@/lib/geo/bg-geometry-client', () => ({
    loadBgMapGeometry: () =>
        Promise.resolve({
            W: 1000,
            H: 600,
            // Empty, deliberately: with no oblast paths the ONLY
            // view-bearing `setTransform` in a frame is the parcel layer's,
            // which is what these tests read the view out of.
            oblasti: [],
            outlinePath: '',
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
        }),
    resetBgMapGeometryCache: () => {},
}));

import { ParcelOverviewMap } from '@/components/locations/ParcelOverviewMap';

// ── The bits of a browser jsdom does not have ────────────────────────

const PANE_W = 800;
const PANE_H = 480;
/** What `resize()` computes for this pane and this 1000×600 world. */
const FIT = Math.min(PANE_W / 1000, PANE_H / 600) * 0.98;

type Call = number[];

interface Recorder {
    setTransform: Call[];
    arcs: Array<{ x: number; y: number; r: number }>;
    /** `stroke(path)` — the parcel outlines. `stroke()` bare is a marker. */
    pathStrokes: number;
    fillRects: number;
}

let rec: Recorder;

function makeContext(): CanvasRenderingContext2D {
    const ctx = {
        setTransform: (...a: number[]) => rec.setTransform.push(a),
        fillRect: () => {
            rec.fillRects++;
        },
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        arc: (x: number, y: number, r: number) => rec.arcs.push({ x, y, r }),
        fill: () => {},
        stroke: (p?: unknown) => {
            if (p) rec.pathStrokes++;
        },
        strokeText: () => {},
        fillText: () => {},
        isPointInPath: () => false,
        measureText: () => ({ width: 10 }),
    };
    return ctx as unknown as CanvasRenderingContext2D;
}

/** The last transform that carries the view (the per-frame reset is identity). */
function viewTransform(): { k: number; tx: number; ty: number } | null {
    for (let i = rec.setTransform.length - 1; i >= 0; i--) {
        const [a, b, c, d, e, f] = rec.setTransform[i];
        const identity = a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
        if (!identity) return { k: a, tx: e, ty: f };
    }
    return null;
}

function touch(type: string, points: Array<{ x: number; y: number }>): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'touches', {
        value: points.map((p) => ({ clientX: p.x, clientY: p.y })),
    });
    return e;
}

const originalRaf = global.requestAnimationFrame;
const originalMatchMedia = window.matchMedia;
let rafCalls = 0;

beforeEach(() => {
    rec = { setTransform: [], arcs: [], pathStrokes: 0, fillRects: 0 };
    rafCalls = 0;

    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => makeContext() as unknown as null,
    );
    // A laid-out pane. jsdom reports every box as 0×0, and a zero pane
    // makes `fit` zero, which makes every number below zero.
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        width: PANE_W,
        height: PANE_H,
        top: 0,
        left: 0,
        right: PANE_W,
        bottom: PANE_H,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    } as DOMRect);
    for (const [prop, value] of [
        ['clientWidth', PANE_W],
        ['clientHeight', PANE_H],
    ] as const) {
        Object.defineProperty(HTMLCanvasElement.prototype, prop, {
            configurable: true,
            get: () => value,
        });
    }

    // A Path2D that records nothing: the component only needs the object
    // to exist, and `isPointInPath` is stubbed above.
    (global as unknown as { Path2D: unknown }).Path2D = class {
        moveTo() {}
        lineTo() {}
        closePath() {}
    };

    // One frame, already at the end — a flight completes inside the click
    // that started it, so assertions read a settled view rather than a
    // fraction of one.
    global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafCalls++;
        cb(performance.now() + 1_000_000);
        return 1;
    }) as typeof global.requestAnimationFrame;
    global.cancelAnimationFrame = (() => {}) as typeof global.cancelAnimationFrame;
});

afterEach(() => {
    jest.restoreAllMocks();
    global.requestAnimationFrame = originalRaf;
    window.matchMedia = originalMatchMedia;
    delete (global as unknown as { Path2D?: unknown }).Path2D;
    for (const prop of ['clientWidth', 'clientHeight'] as const) {
        delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)[prop];
    }
});

// ── Fixture ──────────────────────────────────────────────────────────

const PARCEL_POINTS = [
    { id: 'p1', lon: 26.9, lat: 43.11 },
    { id: 'p2', lon: 26.901, lat: 43.111 },
    { id: 'p3', lon: 26.902, lat: 43.112 },
    // The northernmost, and deliberately NOT first in this array — the
    // stepper must reach it first anyway.
    { id: 'p4', lon: 26.7, lat: 43.2 },
];

const NAMES = new Map([
    ['p1', 'Нива 1'],
    ['p2', 'Нива 2'],
    ['p3', 'Нива 3'],
    ['p4', 'Нива 4'],
]);

function square(lon: number, lat: number, d = 0.004) {
    return {
        type: 'MultiPolygon',
        coordinates: [
            [
                [
                    [lon, lat],
                    [lon + d, lat],
                    [lon + d, lat + d],
                    [lon, lat + d],
                    [lon, lat],
                ],
            ],
        ],
    };
}

const SHAPES = PARCEL_POINTS.map((p) => ({ id: p.id, geometry: square(p.lon, p.lat) }));

function makeOverview(over: Partial<ParcelOverview> = {}): ParcelOverview {
    return {
        clusters: [
            {
                id: 'cA',
                lon: 26.9,
                lat: 43.11,
                count: 3,
                parcelIds: ['p1', 'p2', 'p3'],
                totalAreaHa: 45.5,
                label: 'Драгоево',
            },
        ],
        parcels: PARCEL_POINTS,
        bbox: [26.7, 43.09, 26.94, 43.2],
        positionedCount: 4,
        unpositionedCount: 0,
        unpositionedParcelIds: [],
        truncated: false,
        ...over,
    };
}

async function renderMap(
    props: Partial<React.ComponentProps<typeof ParcelOverviewMap>> = {},
) {
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
    // The geometry arrives on a promise; nothing paints before it.
    await waitFor(() => expect(rec.fillRects).toBeGreaterThan(0));
    return {
        onSelect,
        onParcelOpen,
        onZoomTierChange,
        canvas: screen.getByRole('img') as HTMLCanvasElement,
    };
}

function press(name: RegExp) {
    return userEvent.click(screen.getByRole('button', { name }));
}

describe('the canvas branch actually runs here', () => {
    it('paints, and the paint carries the fitted view', async () => {
        // The premise of every other case in this file. Under the project's
        // ordinary jsdom setup this assertion is unreachable: `getContext`
        // returns null and `draw` leaves on its second line.
        await renderMap();
        const v = viewTransform();
        expect(v).not.toBeNull();
        expect(v!.k).toBeCloseTo(FIT, 6);
        // Fit-framed means centred in the pane.
        expect(v!.tx).toBeCloseTo((PANE_W - 1000 * FIT) / 2, 6);
    });
});

describe('two fingers', () => {
    /** Zoom in far enough that the holding is larger than the pane. */
    async function zoomIn(times: number) {
        for (let i = 0; i < times; i++) await press(/zoom in/i);
    }

    // Break: pinch without pan — the operator magnifies a corner and then
    // cannot move away from it, because one finger belongs to the page.
    it('drag together pans the map by the midpoint travel', async () => {
        const { canvas } = await renderMap();
        await zoomIn(3); // content now wider than the pane, so panning is possible
        const before = viewTransform()!;
        rec.setTransform = [];

        await act(async () => {
            canvas.dispatchEvent(
                touch('touchstart', [
                    { x: 300, y: 200 },
                    { x: 400, y: 200 },
                ]),
            );
            // Same spread (100px), midpoint moved by (+40, -30).
            canvas.dispatchEvent(
                touch('touchmove', [
                    { x: 340, y: 170 },
                    { x: 440, y: 170 },
                ]),
            );
        });

        const after = viewTransform()!;
        expect(after.k).toBeCloseTo(before.k, 6); // spread unchanged → no zoom
        expect(after.tx - before.tx).toBeCloseTo(40, 6);
        expect(after.ty - before.ty).toBeCloseTo(-30, 6);
    });

    it('spread apart zooms in about the fingers', async () => {
        const { canvas } = await renderMap();
        const before = viewTransform()!;
        rec.setTransform = [];

        await act(async () => {
            canvas.dispatchEvent(
                touch('touchstart', [
                    { x: 350, y: 240 },
                    { x: 450, y: 240 },
                ]),
            );
            // Midpoint unchanged, spread doubled.
            canvas.dispatchEvent(
                touch('touchmove', [
                    { x: 300, y: 240 },
                    { x: 500, y: 240 },
                ]),
            );
        });

        expect(viewTransform()!.k).toBeCloseTo(before.k * 2, 5);
    });

    it('pinching closed reaches country scale rather than stopping at the old floor', async () => {
        const { canvas } = await renderMap();
        rec.setTransform = [];

        await act(async () => {
            canvas.dispatchEvent(
                touch('touchstart', [
                    { x: 100, y: 240 },
                    { x: 700, y: 240 },
                ]),
            );
            for (const spread of [300, 150, 75, 38, 19, 10, 5, 3, 2]) {
                canvas.dispatchEvent(
                    touch('touchmove', [
                        { x: 400 - spread / 2, y: 240 },
                        { x: 400 + spread / 2, y: 240 },
                    ]),
                );
            }
        });

        // The floor that shipped was `fit * 0.35`; the country needs far
        // more room than that, which is the whole point of the change.
        const v = viewTransform();
        // At country scale the outlines are gone, so there may be no
        // view-bearing transform left at all — either way the assertion
        // below has to hold.
        expect(v === null || v.k < FIT * 0.35).toBe(true);
    });

    // Break: #449 all over again — a preventDefault on the single-touch
    // path kills the page scroll and the tab panel's swipe navigation.
    it('leaves one finger entirely to the browser', async () => {
        const { canvas } = await renderMap();
        const start = touch('touchstart', [{ x: 300, y: 200 }]);
        const move = touch('touchmove', [{ x: 300, y: 260 }]);
        await act(async () => {
            canvas.dispatchEvent(start);
            canvas.dispatchEvent(move);
        });
        expect(start.defaultPrevented).toBe(false);
        expect(move.defaultPrevented).toBe(false);
    });

    it('takes the gesture from the page on two', async () => {
        const { canvas } = await renderMap();
        const start = touch('touchstart', [
            { x: 300, y: 200 },
            { x: 400, y: 200 },
        ]);
        await act(async () => {
            canvas.dispatchEvent(start);
        });
        expect(start.defaultPrevented).toBe(true);
    });
});

describe('the whole country', () => {
    it('one press frames it, and the outlines stop being drawn', async () => {
        await renderMap();
        const holding = viewTransform()!;
        rec = { setTransform: [], arcs: [], pathStrokes: 0, fillRects: 0 };

        await press(/show the whole country/i);

        // Far enough out that the old floor would not have allowed it.
        const v = viewTransform();
        expect(v === null || v.k < holding.k * 0.35).toBe(true);
        // A hundred one-pixel marks over the country outline is not a map
        // of a holding, so the shapes drop out and the clusters carry it.
        expect(rec.pathStrokes).toBe(0);
        expect(rec.arcs.length).toBeGreaterThan(0);
    });

    it('and one press back, to the same framing it opened with', async () => {
        await renderMap();
        const opened = viewTransform()!;

        await press(/show the whole country/i);
        await press(/back to this holding/i);

        const back = viewTransform()!;
        expect(back.k).toBeCloseTo(opened.k, 6);
        expect(back.tx).toBeCloseTo(opened.tx, 6);
        expect(back.ty).toBeCloseTo(opened.ty, 6);
    });

    it('says which way it goes', async () => {
        await renderMap();
        expect(
            screen.getByRole('button', { name: /show the whole country/i }),
        ).toHaveAttribute('aria-pressed', 'false');

        await press(/show the whole country/i);

        const back = screen.getByRole('button', { name: /back to this holding/i });
        expect(back).toHaveAttribute('aria-pressed', 'true');
    });
});

describe('stepping through the parcels', () => {
    // Break: a stepper that walks the order the rows happened to arrive
    // in, which records when a parcel was typed in and nothing about
    // where it is.
    it('goes north first, not first-created', async () => {
        await renderMap();
        await press(/next parcel/i);
        // p4 is the northernmost and the LAST of the four in the payload.
        expect(screen.getByTestId('parcel-step-position')).toHaveTextContent(
            'Нива 4 · 1 of 4, north to south',
        );
    });

    it('walks south and wraps rather than dead-ending', async () => {
        await renderMap();
        for (const expected of ['Нива 4 · 1', 'Нива 3 · 2', 'Нива 2 · 3', 'Нива 1 · 4']) {
            await press(/next parcel/i);
            expect(screen.getByTestId('parcel-step-position')).toHaveTextContent(expected);
        }
        // Break: a button that stops responding at the end, which looks
        // exactly like a broken one.
        await press(/next parcel/i);
        expect(screen.getByTestId('parcel-step-position')).toHaveTextContent('Нива 4 · 1 of 4');
    });

    it('centres and magnifies the parcel it stepped to', async () => {
        await renderMap();
        const before = viewTransform()!;
        await press(/next parcel/i);
        const after = viewTransform()!;
        expect(after.k).toBeGreaterThan(before.k);
    });

    it('walks only the selected group', async () => {
        await renderMap({
            selection: {
                id: 'cA',
                zoomTier: 9,
                parcelIds: ['p1', 'p3'],
                label: 'Драгоево',
                count: 2,
            },
        });
        await press(/next parcel/i);
        // Within the group, still north first: p3 is above p1.
        expect(screen.getByTestId('parcel-step-position')).toHaveTextContent(
            'Нива 3 · 1 of 2, north to south',
        );
    });

    it('offers no stepper when there is nothing to step through', async () => {
        await renderMap({
            overview: makeOverview({ parcels: [], clusters: [], positionedCount: 0 }),
        });
        expect(screen.queryByRole('button', { name: /next parcel/i })).toBeNull();
    });

    it('says nothing about a position before the first press', async () => {
        await renderMap();
        expect(screen.queryByTestId('parcel-step-position')).toBeNull();
    });
});

describe('prefers-reduced-motion', () => {
    // The branch the project-wide `matchMedia` stub makes unreachable: it
    // answers `matches: false` to every query, so every other test in this
    // file runs the animated path and would stay green if the reduced one
    // were deleted.
    it('arrives without a flight', async () => {
        await renderMap();
        window.matchMedia = ((query: string) => ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        })) as unknown as typeof window.matchMedia;

        const before = viewTransform()!;
        rafCalls = 0;
        await press(/next parcel/i);

        expect(rafCalls).toBe(0);
        // Jumped, not stalled — the view still arrived somewhere new.
        expect(viewTransform()!.k).toBeGreaterThan(before.k);
        expect(screen.getByTestId('parcel-step-position')).toHaveTextContent('1 of 4');
    });
});
