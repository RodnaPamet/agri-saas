/**
 * #3081 — the handoff reader's verdicts.
 *
 * The file between the two halves exists because Playwright cannot be in this
 * product's image, and it introduces failure modes the ingest alone does not
 * have: the file may be absent, truncated, or left over from yesterday. Every
 * one of those is `unaudited` rather than `clean`, and each carries a distinct
 * `reason` so the log says WHICH.
 *
 * The staleness case is the subtle one. Re-ingesting yesterday's document
 * would be harmless to the DATA — points are keyed on their own row dates and
 * upserted — so it would look like a successful run. It would be reporting
 * `clean` about a fetch that never happened, which is precisely what the
 * verdict exists to prevent, and with the owner's full-precedence ruling these
 * figures drive the grain calculator.
 */
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ingestMock = jest.fn();
jest.mock('@/app-layer/jobs/zarnoborsa-ingest', () => ({
    ...(jest.requireActual('@/app-layer/jobs/zarnoborsa-ingest') as object),
    ingestZarnoBorsaRows: (...a: unknown[]) => ingestMock(...a),
}));

import { runZarnoBorsaPull, ZARNOBORSA_MAX_AGE_HOURS } from '@/app-layer/jobs/zarnoborsa-pull';

let dir = '';
const NOW = new Date('2026-11-16T06:20:00Z');

function handoff(body: unknown, ageMinutes = 5): string {
    const p = join(dir, 'latest.json');
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const when = new Date(NOW.getTime() - ageMinutes * 60_000);
    utimesSync(p, when, when);
    return p;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zb-'));
    ingestMock.mockReset();
    ingestMock.mockResolvedValue({
        verdict: 'clean', received: 2, kept: 2, mapped: 2,
        seriesTouched: 2, pointsWritten: 2, unmappedProducts: [],
    });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('#3081 — a MISSING handoff is unaudited, not clean', () => {
    it('reports no-file and does not call the ingest at all', async () => {
        const r = await runZarnoBorsaPull(NOW, join(dir, 'absent.json'));
        expect(r.verdict).toBe('unaudited');
        expect(r.reason).toBe('no-file');
        // The ingest is never reached, so it cannot report a verdict about a
        // file that does not exist.
        expect(ingestMock).not.toHaveBeenCalled();
    });
});

describe('#3081 — a STALE handoff is refused', () => {
    it('refuses a document older than the window', async () => {
        const p = handoff({ fetchedAt: '2026-11-15T06:00:00Z', locked: false, rows: [{}] },
            ZARNOBORSA_MAX_AGE_HOURS * 60 + 1);
        const r = await runZarnoBorsaPull(NOW, p);
        // Re-ingesting would have been harmless to the DATA and would have
        // reported `clean` about a fetch that never happened.
        expect(r.verdict).toBe('unaudited');
        expect(r.reason).toBe('stale');
        expect(ingestMock).not.toHaveBeenCalled();
        // The age is reported, so the log says HOW stale rather than just that
        // it was.
        expect(r.handoffAgeMinutes).toBeGreaterThan(ZARNOBORSA_MAX_AGE_HOURS * 60);
    });

    it('ACCEPTS one inside the window — the control', async () => {
        // Without this the staleness test passes just as well when the reader
        // refuses everything.
        const p = handoff({ locked: false, rows: [{}, {}] }, ZARNOBORSA_MAX_AGE_HOURS * 60 - 1);
        const r = await runZarnoBorsaPull(NOW, p);
        expect(r.reason).toBe('ok');
        expect(ingestMock).toHaveBeenCalledTimes(1);
    });
});

describe('#3081 — a TRUNCATED handoff is unreadable, not empty', () => {
    it('reports unreadable rather than zero rows', async () => {
        // The fetch container killed mid-write. Reporting it as zero rows
        // would be a claim about the MARKET rather than about the file.
        const p = handoff('{"locked": false, "rows": [{"mark');
        const r = await runZarnoBorsaPull(NOW, p);
        expect(r.verdict).toBe('unaudited');
        expect(r.reason).toBe('unreadable');
        expect(ingestMock).not.toHaveBeenCalled();
    });
});

describe('#3081 — a good handoff is passed through', () => {
    it('hands the rows AND the lock flag to the ingest', async () => {
        const rows = [{ marketId: 1044, productId: 1007 }];
        const p = handoff({ fetchedAt: NOW.toISOString(), locked: false, rows, skipped: 3 });
        const r = await runZarnoBorsaPull(NOW, p);

        expect(r.reason).toBe('ok');
        expect(r.verdict).toBe('clean');
        // The lock verdict TRAVELS with the rows — only the fetch half can
        // see the banner, and no property of the data distinguishes a
        // paywalled page from a quiet market.
        expect(ingestMock).toHaveBeenCalledWith(rows, { locked: false });
    });

    it('forwards a LOCKED flag rather than deciding for itself', async () => {
        const p = handoff({ locked: true, rows: [{ marketId: 1044 }] });
        await runZarnoBorsaPull(NOW, p);
        expect(ingestMock).toHaveBeenCalledWith([{ marketId: 1044 }], { locked: true });
    });

    it('treats a MISSING locked field as not locked, not as locked', async () => {
        // `locked === true` rather than truthiness: an older fetch bundle that
        // omits the field must not have its rows discarded, because the field
        // was added with the reader. Absence means "this fetch did not report
        // a paywall", which is what an older bundle means by saying nothing.
        const p = handoff({ rows: [{ marketId: 1044 }] });
        await runZarnoBorsaPull(NOW, p);
        expect(ingestMock).toHaveBeenCalledWith([{ marketId: 1044 }], { locked: false });
    });

    it('a handoff with no rows key hands an empty array, not undefined', async () => {
        const p = handoff({ locked: false });
        await runZarnoBorsaPull(NOW, p);
        expect(ingestMock).toHaveBeenCalledWith([], { locked: false });
    });
});
