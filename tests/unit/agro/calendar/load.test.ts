/**
 * The agronomic calendar's loader — «Агрономически календар», stage 1.
 *
 * The committed dataset is validated at module load, which proves the loader
 * ACCEPTS a good document and nothing about what it refuses. The refusals are
 * the point: each one fails in the direction that reads as working, so each is
 * driven here with a crafted document.
 */
import {
    CALENDAR,
    calendarCropKeys,
    calendarFor,
    citedSourceUrls,
    validateDataset,
    windowCovers,
    windowWraps,
} from '@/lib/agro/calendar/load';

/** A minimal VALID dataset, mutated per case. */
const good = () => ({
    schemaVersion: 1 as const,
    compiledAt: '2026-11-16',
    conventions: ['every figure checked against its cited page'],
    sources: { s1: { title: 'Guide', publisher: 'МЗХ', url: 'https://example.invalid/g.pdf' } },
    crops: [
        {
            key: 'wheat-bread',
            group: 'field' as const,
            name: { bg: 'Хлебна пшеница' },
            windows: [
                {
                    id: 'w1',
                    kind: 'sowing' as const,
                    band: 'optimal' as const,
                    region: 'both' as const,
                    from: '09-25',
                    to: '10-10',
                    cite: { source: 's1', page: 20 },
                },
            ],
        },
    ],
});

describe('the real dataset', () => {
    it('loads, and is not empty', () => {
        const windows = CALENDAR.crops.flatMap((c) => c.windows);
        console.log(
            `[agro-calendar] ${CALENDAR.crops.length} crop(s), ${windows.length} window(s), `
                + `${Object.keys(CALENDAR.sources).length} source(s)`,
        );
        // Floors. Every query assertion below is satisfied for free over an
        // empty dataset, and an empty one would serve a blank calendar while
        // the route answered 200.
        expect(CALENDAR.crops.length).toBeGreaterThanOrEqual(20);
        expect(windows.length).toBeGreaterThanOrEqual(100);
        expect(Object.keys(CALENDAR.sources).length).toBeGreaterThanOrEqual(5);
        // All three groups the owner asked for are actually present.
        expect(new Set(CALENDAR.crops.map((c) => c.group))).toEqual(
            new Set(['field', 'vegetable', 'perennial']),
        );
    });

    it('carries wrap-around windows, so that path is exercised by real data', () => {
        // Pruning runs 15 December to 30 March. A dataset with none would
        // leave the wrap untested on both sides of the API.
        const wrapped = CALENDAR.crops.flatMap((c) => c.windows).filter(windowWraps);
        expect(wrapped.length).toBeGreaterThan(0);
    });

    it('every window is cited, and every citation resolves', () => {
        // The loader enforces this; asserting it here states the PROPERTY a
        // reader cares about rather than trusting that the enforcement ran.
        for (const crop of CALENDAR.crops) {
            for (const w of crop.windows) {
                expect(w.cite.source).toBeTruthy();
                for (const c of [w.cite, ...(w.alsoCite ?? [])]) {
                    expect(CALENDAR.sources[c.source]).toBeDefined();
                }
            }
        }
    });
});

describe('it REFUSES a dataset that would serve something false', () => {
    it('accepts the crafted good one — the control', () => {
        // Without this, every refusal below could be a validator that throws
        // unconditionally.
        expect(() => validateDataset(good())).not.toThrow();
    });

    it('refuses a citation naming a source that is not there', () => {
        const d = good();
        d.crops[0].windows[0].cite.source = 'nope';
        // The worst of the three: the window LOOKS cited and resolves to
        // nothing, so it is indistinguishable from a sourced one on screen.
        expect(() => validateDataset(d)).toThrow(/not in the sources map/i);
    });

    it('refuses a duplicate window id', () => {
        const d = good();
        d.crops[0].windows.push({ ...d.crops[0].windows[0] });
        // The ids are how stage 2 addresses a correction, so two windows
        // sharing one means a correction lands on whichever came first.
        expect(() => validateDataset(d)).toThrow(/duplicate window id/i);
    });

    it('refuses a sowing window with no band', () => {
        const d = good();
        delete (d.crops[0].windows[0] as { band?: string }).band;
        expect(() => validateDataset(d)).toThrow(/has no band/i);
    });

    it('refuses a date that is not MM-DD, and a year is the likely mistake', () => {
        const d = good();
        d.crops[0].windows[0].from = '2026-09-25';
        expect(() => validateDataset(d)).toThrow(/malformed/i);
    });

    it('refuses a unit outside the closed set — `m²` is the one to catch', () => {
        const d = good();
        (d.crops[0].windows[0] as Record<string, unknown>).seedRate = {
            min: 500,
            max: 600,
            unit: 'seeds/m²',
        };
        // A superscript pasted from a PDF would otherwise be a second unit
        // that renders differently and compares unequal, silently.
        expect(() => validateDataset(d)).toThrow(/malformed/i);
    });

    it('refuses min > max', () => {
        const d = good();
        (d.crops[0].windows[0] as Record<string, unknown>).depth = {
            min: 6,
            max: 4,
            unit: 'cm',
        };
        expect(() => validateDataset(d)).toThrow(/malformed/i);
    });

    it('refuses a crop with no windows', () => {
        const d = good();
        d.crops[0].windows = [];
        expect(() => validateDataset(d)).toThrow(/malformed/i);
    });
});

describe('the query', () => {
    it('returns `both` windows for either region, which is most of them', () => {
        const north = calendarFor({ region: 'north' });
        const south = calendarFor({ region: 'south' });
        expect(north.length).toBeGreaterThan(0);
        expect(south.length).toBeGreaterThan(0);
        // A `both` window belongs to every region — treating it as a third
        // region would serve almost nothing.
        for (const region of ['north', 'south'] as const) {
            const ws = calendarFor({ region }).flatMap((c) => c.windows);
            expect(ws.some((w) => w.region === 'both')).toBe(true);
            // …and never the OTHER region's windows.
            const other = region === 'north' ? 'south' : 'north';
            expect(ws.some((w) => w.region === other)).toBe(false);
        }
    });

    it('normalises cite + alsoCite into ONE ordered list', () => {
        const ws = calendarFor({ region: 'north' }).flatMap((c) => c.windows);
        expect(ws.length).toBeGreaterThan(0);
        for (const w of ws) {
            // `cites` became OPTIONAL with #3095, because a corrected or added
            // window carries `basis` INSTEAD. These are all published — this
            // call passes no overrides — so every one must still have it, and
            // asserting that is now part of the contract rather than implied
            // by the type.
            expect(w.origin).toBeUndefined();
            expect(Array.isArray(w.cites)).toBe(true);
            expect(w.cites ?? []).not.toHaveLength(0);
            // The served shape replaces them; a client should never have to
            // concatenate two fields itself.
            expect(w).not.toHaveProperty('cite');
            expect(w).not.toHaveProperty('alsoCite');
        }
        // Where a window has extras, the primary stays FIRST.
        const multi = CALENDAR.crops
            .flatMap((c) => c.windows)
            .find((w) => (w.alsoCite?.length ?? 0) > 0);
        if (multi) {
            const servedMulti = calendarFor({ region: 'north' })
                .flatMap((c) => c.windows)
                .concat(calendarFor({ region: 'south' }).flatMap((c) => c.windows))
                .find((w) => w.id === multi.id);
            expect(servedMulti?.cites?.[0]).toEqual(multi.cite);
            expect(servedMulti?.cites ?? []).toHaveLength(1 + (multi.alsoCite?.length ?? 0));
        }
    });

    it('filters by group and by crop, and drops a crop left with no windows', () => {
        const perennials = calendarFor({ region: 'north', group: 'perennial' });
        expect(perennials.length).toBeGreaterThan(0);
        expect(perennials.every((c) => c.group === 'perennial')).toBe(true);

        const key = calendarCropKeys()[0];
        const one = calendarFor({ region: 'north', crop: key });
        expect(one.map((c) => c.key)).toEqual([key]);

        // Every returned crop has at least one window: a heading with nothing
        // under it reads as "covered, nothing to say", a different claim.
        for (const c of calendarFor({ region: 'south' })) {
            expect(c.windows.length).toBeGreaterThan(0);
        }
    });
});

describe('the year wrap, which a lexical comparison gets backwards', () => {
    const pruning = { from: '12-15', to: '03-30' };
    const sowing = { from: '09-25', to: '10-10' };

    it('knows which windows wrap', () => {
        expect(windowWraps(pruning)).toBe(true);
        expect(windowWraps(sowing)).toBe(false);
    });

    it('covers the right days on BOTH sides of the New Year', () => {
        // Inside, after December's start…
        expect(windowCovers(pruning, '12-20')).toBe(true);
        expect(windowCovers(pruning, '12-31')).toBe(true);
        // …and inside, before March's end.
        expect(windowCovers(pruning, '01-05')).toBe(true);
        expect(windowCovers(pruning, '03-30')).toBe(true);
        // Outside: the eight months a `from <= day <= to` comparison would
        // have reported as pruning season.
        expect(windowCovers(pruning, '06-15')).toBe(false);
        expect(windowCovers(pruning, '11-30')).toBe(false);
        expect(windowCovers(pruning, '04-01')).toBe(false);
    });

    it('still covers an ordinary window correctly — the control', () => {
        expect(windowCovers(sowing, '09-25')).toBe(true);
        expect(windowCovers(sowing, '10-01')).toBe(true);
        expect(windowCovers(sowing, '10-10')).toBe(true);
        expect(windowCovers(sowing, '09-24')).toBe(false);
        expect(windowCovers(sowing, '10-11')).toBe(false);
        // Without this, `windowCovers` returning true unconditionally would
        // satisfy every wrap assertion above.
        expect(windowCovers(sowing, '01-01')).toBe(false);
    });
});

describe('the watched-source list handed to the discovery job (#639)', () => {
    it('is derived from the windows, with the publisher so the gap is visible', () => {
        const cited = citedSourceUrls();
        console.log(
            `[agro-calendar] ${cited.length} cited source(s): `
                + Object.entries(
                      cited.reduce<Record<string, number>>((a, c) => {
                          a[c.publisher] = (a[c.publisher] ?? 0) + 1;
                          return a;
                      }, {}),
                  )
                      .map(([p, n]) => `${p}=${n}`)
                      .join(' '),
        );
        expect(cited.length).toBeGreaterThanOrEqual(5);
        for (const c of cited) {
            expect(c.url).toMatch(/^https?:\/\//);
            expect(c.publisher).toBeTruthy();
            expect(CALENDAR.sources[c.key]).toBeDefined();
        }
        // The МЗХ job cannot watch everything we cite, and that limit has to be
        // READABLE from the data rather than implied — a watcher covering 12
        // of 13 while reporting "the calendar's sources" is the shape this
        // field exists to prevent.
        expect(new Set(cited.map((c) => c.publisher)).size).toBeGreaterThan(1);
    });

    it('excludes a source no window cites', () => {
        // An unused entry is not something whose revision anybody must act on,
        // and including it would inflate what the watcher reports covering.
        const cited = new Set(citedSourceUrls().map((c) => c.key));
        const used = new Set(
            CALENDAR.crops.flatMap((c) =>
                c.windows.flatMap((w) => [w.cite, ...(w.alsoCite ?? [])].map((x) => x.source)),
            ),
        );
        expect(cited).toEqual(used);
    });
});
