/**
 * Corrections and additions to the published calendar — #3095.
 *
 * ## The property that matters most is the one about ABSENCE
 *
 * With no overrides the served bytes must be IDENTICAL to before. That is not
 * tidiness: `/api/agro-calendar` is ETagged, every farm shares one answer, and
 * the phone caches it. If merging changed the payload even when there is
 * nothing to merge, every farm would re-download the calendar on the deploy
 * that shipped this feature, for no benefit.
 *
 * ## And the one that matters most for CORRECTNESS is mutual exclusivity
 *
 * `cites` and `basis` must never appear together. The owner's rule is basis
 * INSTEAD of the citation, because an override changes the value while the
 * published citation still points at a page that no longer supports it. The
 * TYPES permit a both-present object; only the merge refuses to build one, so
 * it is asserted on real output.
 */
import { CALENDAR, calendarFor } from '@/lib/agro/calendar/load';
import {
    applyOverrides,
    parseOverrideWindow,
    type LiveOverride,
    type MergeableWindow,
} from '@/lib/agro/calendar/overrides';

/** A published window to correct, taken from the real dataset. */
function aPublishedWindow(region: 'north' | 'south' = 'north') {
    for (const c of CALENDAR.crops) {
        for (const w of c.windows) {
            if (w.region === region || w.region === 'both') return { crop: c.key, window: w };
        }
    }
    throw new Error('no published window found');
}

const basis = { bg: 'По-ранна сеитба заради сушата.' };

function correction(cropKey: string, windowId: string, over: Record<string, unknown> = {}): LiveOverride {
    const { window } = aPublishedWindow();
    const w = parseOverrideWindow({ ...window, cite: undefined, alsoCite: undefined, id: windowId, ...over });
    if (!w) throw new Error('fixture window did not parse');
    return { windowId, cropKey, origin: 'corrected', window: w, basis };
}

describe('§1 absence changes nothing', () => {
    it('[calendar-overrides] with no overrides the bytes are IDENTICAL', () => {
        const before = JSON.stringify(calendarFor({ region: 'north' }));
        const after = JSON.stringify(calendarFor({ region: 'north' }, []));
        console.log(`[calendar-overrides] baseline payload ${before.length} chars`);
        expect(after).toBe(before);
        expect(before.length).toBeGreaterThan(1000);
    });

    it('no published window carries override fields', () => {
        for (const w of calendarFor({ region: 'south' }).flatMap((c) => c.windows)) {
            expect(w.origin).toBeUndefined();
            expect(w.basis).toBeUndefined();
            expect(w.supersedes).toBeUndefined();
            expect(w.cites ?? []).not.toHaveLength(0);
        }
    });
});

describe('§2 a CORRECTION replaces the window and drops its citation', () => {
    it('serves basis and supersedes, and NO cites', () => {
        const { crop, window } = aPublishedWindow();
        const o = correction(crop, window.id, { from: '09-01', to: '09-20' });
        const got = calendarFor({ region: 'north' }, [o])
            .flatMap((c) => c.windows)
            .find((w) => w.id === window.id);

        expect(got).toBeDefined();
        expect(got!.origin).toBe('corrected');
        expect(got!.basis).toEqual(basis);
        expect(got!.from).toBe('09-01');
        expect(got!.to).toBe('09-20');
        // The whole point.
        expect(got!.cites).toBeUndefined();
        // The original is kept, under a name no renderer can mistake for a
        // live citation.
        expect(got!.supersedes?.from).toBe(window.from);
        expect(got!.supersedes?.to).toBe(window.to);
        expect(got!.supersedes?.cites?.[0]).toEqual(window.cite);
    });

    it('[calendar-overrides] cites and basis are NEVER both present', () => {
        const { crop, window } = aPublishedWindow();
        const o = correction(crop, window.id, { from: '09-01', to: '09-20' });
        const all = calendarFor({ region: 'north' }, [o]).flatMap((c) => c.windows);
        const both = all.filter((w) => w.cites !== undefined && w.basis !== undefined);
        const neither = all.filter((w) => w.cites === undefined && w.basis === undefined);
        console.log(
            `[calendar-overrides] ${all.length} window(s): ${both.length} with BOTH, `
            + `${neither.length} with NEITHER`,
        );
        expect(both).toEqual([]);
        // And neither is also impossible: a window has one or the other.
        expect(neither).toEqual([]);
    });

    it('leaves every OTHER window untouched', () => {
        const { crop, window } = aPublishedWindow();
        const o = correction(crop, window.id, { from: '09-01', to: '09-20' });
        const plain = calendarFor({ region: 'north' }).flatMap((c) => c.windows);
        const merged = calendarFor({ region: 'north' }, [o]).flatMap((c) => c.windows);
        expect(merged).toHaveLength(plain.length);
        for (const p of plain) {
            if (p.id === window.id) continue;
            expect(merged.find((w) => w.id === p.id)).toEqual(p);
        }
    });

    it('does not mutate the shared dataset — a later request is unaffected', () => {
        // CALENDAR is a module-level constant shared by every request. A
        // mutation here would leak the correction into requests that passed no
        // overrides at all.
        const { crop, window } = aPublishedWindow();
        const before = JSON.stringify(calendarFor({ region: 'north' }));
        calendarFor({ region: 'north' }, [correction(crop, window.id, { from: '01-01', to: '01-02' })]);
        expect(JSON.stringify(calendarFor({ region: 'north' }))).toBe(before);
    });
});

describe('§3 an ADDITION appends a window that МЗХ does not publish', () => {
    const added = (cropKey: string, region: 'north' | 'south' | 'both'): LiveOverride => {
        const w = parseOverrideWindow({
            id: 'garlic.sow.optimal.north.added',
            kind: 'sowing',
            band: 'optimal',
            region,
            from: '10-05',
            to: '10-25',
        });
        if (!w) throw new Error('added fixture did not parse');
        return { windowId: w.id, cropKey, origin: 'added', window: w, basis };
    };

    it('appears with origin added, a basis, and NO supersedes', () => {
        const crop = CALENDAR.crops[0].key;
        const got = calendarFor({ region: 'north' }, [added(crop, 'north')])
            .flatMap((c) => c.windows)
            .find((w) => w.id === 'garlic.sow.optimal.north.added');
        expect(got).toBeDefined();
        expect(got!.origin).toBe('added');
        expect(got!.basis).toEqual(basis);
        expect(got!.cites).toBeUndefined();
        // Nothing preceded it, so there is nothing it supersedes. A `{}` here
        // would read as "it replaced a window with empty dates".
        expect(got!.supersedes).toBeUndefined();
    });

    it('is REGION-FILTERED like any other window', () => {
        const crop = CALENDAR.crops[0].key;
        const south = calendarFor({ region: 'south' }, [added(crop, 'north')])
            .flatMap((c) => c.windows)
            .find((w) => w.id === 'garlic.sow.optimal.north.added');
        expect(south).toBeUndefined();
    });
});

describe('§4 the merge runs BEFORE the region filter, and the order is load-bearing', () => {
    it('a correction that MOVES a window between regions takes effect', () => {
        /*
         * Filtering first would drop the published window before the override
         * could be applied, so moving a window from `north` to `south` would
         * silently not appear in the south. Merging first means the OVERRIDE's
         * region decides, which is what an operator editing that field means.
         */
        const north = aPublishedWindow('north');
        const moved = correction(north.crop, north.window.id, { region: 'south' });

        const inSouth = calendarFor({ region: 'south' }, [moved])
            .flatMap((c) => c.windows)
            .find((w) => w.id === north.window.id);
        const inNorth = calendarFor({ region: 'north' }, [moved])
            .flatMap((c) => c.windows)
            .find((w) => w.id === north.window.id);

        if (north.window.region === 'both') {
            // A `both` window narrowed to `south` must leave the north.
            expect(inSouth?.origin).toBe('corrected');
            expect(inNorth).toBeUndefined();
        } else {
            expect(inSouth?.origin).toBe('corrected');
            expect(inNorth).toBeUndefined();
        }
    });
});

describe('§5 refusals, each degrading to the published answer', () => {
    it('an unmatched correction is IGNORED and reported, not appended', () => {
        // The base dataset changed under a correction — a window renamed or
        // removed. Appending it would resurrect a window МЗХ no longer
        // publishes, under a basis written about a different one.
        const crop = CALENDAR.crops[0].key;
        const stale = correction(crop, 'this.window.does.not.exist');
        const base: MergeableWindow[] = [
            { id: 'real', region: 'north', from: '01-01', to: '01-02', cites: [{ source: 's', page: 1 }] },
        ];
        const { windows, unmatchedCorrections } = applyOverrides(crop, base, [stale]);
        expect(windows).toHaveLength(1);
        expect(windows[0].id).toBe('real');
        expect(unmatchedCorrections).toEqual(['this.window.does.not.exist']);
    });

    it('a windowJson the schema rejects yields null, so ONE override stops applying', () => {
        // A dataset-level fault should fail at boot; a single bad override must
        // not take the whole surface down. The published window shows through.
        expect(parseOverrideWindow({ id: 'x' })).toBeNull();
        expect(parseOverrideWindow({ id: 'x', kind: 'sowing', region: 'north', from: 'nope', to: '10-10' })).toBeNull();
        expect(parseOverrideWindow(null)).toBeNull();
    });

    it('an override carrying a citation is REFUSED by the schema', () => {
        // `OverrideWindowSchema` omits `cite`, and the schema is strict about
        // what it builds: an override must not be able to assert a source.
        const w = parseOverrideWindow({
            id: 'x', kind: 'sowing', band: 'optimal', region: 'north',
            from: '10-05', to: '10-25', cite: { source: 'mzh-ip-2024', page: 20 },
        });
        // It parses, but the citation is STRIPPED rather than carried.
        expect(w).not.toBeNull();
        expect(w as unknown as Record<string, unknown>).not.toHaveProperty('cite');
    });

    it('an override for a DIFFERENT crop does not touch this one', () => {
        const crop = CALENDAR.crops[0].key;
        const other = correction('some-other-crop', 'real');
        const base: MergeableWindow[] = [
            { id: 'real', region: 'north', from: '01-01', to: '01-02', cites: [{ source: 's', page: 1 }] },
        ];
        const { windows } = applyOverrides(crop, base, [other]);
        expect(windows[0].cites).toBeDefined();
        expect(windows[0].origin).toBeUndefined();
    });
});
