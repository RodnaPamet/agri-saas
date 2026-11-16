/**
 * #2944 — the card-health signal, executed rather than asserted about.
 *
 * This decides whether an alert fires, so a guard over its source would be the
 * wrong tool: `green-is-not-the-same-as-executed`, and the coverage gate
 * itself is the worked example of a gate guarded only structurally.
 *
 * Every negative is paired with its positive, because the shape to beat is a
 * capability that reports a problem for every input or none — and the probe's
 * whole purpose is telling "nothing short" from "could not look".
 */
import {
    CARD_HEALTH_RECORD_KEY,
    CARD_HEALTH_STALE_AFTER_MINUTES,
    parseCardHealthRecord,
    recordCardHealth,
    type CardHealthRecord,
} from '@/lib/channels/card-health-record';
import { cardHealthCapability } from '@/lib/channels/card-health-capability';
import { createServer, type Server } from 'http';
import { execFile } from 'child_process';
import { join } from 'path';

const NOW = new Date('2026-11-16T05:30:00.000Z');

function kind(over: Partial<{ channels: number; eligible: number; withContent: number; created: number; dormant: boolean }> = {}) {
    return { channels: 15, eligible: 15, withContent: 3, created: 3, dormant: false, ...over };
}

function record(over: Partial<CardHealthRecord> = {}): CardHealthRecord {
    return {
        at: '2026-11-16T03:00:00.000Z',
        day: '2026-11-16',
        byKind: { NEWS: kind(), LISTING: kind({ channels: 28, eligible: 28, withContent: 1, created: 1 }) },
        ...over,
    } as CardHealthRecord;
}

/** A reader that answers one stored string. */
const reader = (raw: string | null) => ({ get: async (k: string) => (k === CARD_HEALTH_RECORD_KEY ? raw : null) });

describe('recordCardHealth', () => {
    it('writes the key with no TTL, so absence stays distinguishable from staleness', async () => {
        const calls: Array<[string, string]> = [];
        await recordCardHealth(
            { set: async (k: string, v: string) => { calls.push([k, v]); return 'OK'; } },
            NOW, '2026-11-16',
            { NEWS: { channels: 15, eligible: 15, withContent: 3, created: 2, dormant: false } },
        );
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe(CARD_HEALTH_RECORD_KEY);
        const stored = JSON.parse(calls[0][1]);
        expect(stored.day).toBe('2026-11-16');
        expect(stored.byKind.NEWS).toEqual({ channels: 15, eligible: 15, withContent: 3, created: 2, dormant: false });
    });

    it('NEVER THROWS — the cards are already written by the time it runs', async () => {
        await expect(recordCardHealth(
            { set: async () => { throw new Error('redis gone'); } },
            NOW, '2026-11-16', { NEWS: { channels: 1, eligible: 1, withContent: 0, created: 0, dormant: false } },
        )).resolves.toBeUndefined();
    });

    it('is a no-op with no client, rather than inventing a record', async () => {
        await expect(recordCardHealth(null, NOW, '2026-11-16', {})).resolves.toBeUndefined();
    });
});

describe('parseCardHealthRecord validates the SHAPE', () => {
    it('round-trips a real record — the control for every refusal below', () => {
        expect(parseCardHealthRecord(JSON.stringify(record()))).toEqual(record());
    });

    it.each([
        ['null', null],
        ['empty', ''],
        ['not JSON', '{nope'],
        ['not an object', '42'],
        ['no at', JSON.stringify({ day: '2026-11-16', byKind: { NEWS: kind() } })],
        ['unparseable at', JSON.stringify({ at: 'whenever', day: '2026-11-16', byKind: { NEWS: kind() } })],
        ['no day', JSON.stringify({ at: NOW.toISOString(), byKind: { NEWS: kind() } })],
        ['no byKind', JSON.stringify({ at: NOW.toISOString(), day: '2026-11-16' })],
        ['EMPTY byKind', JSON.stringify({ at: NOW.toISOString(), day: '2026-11-16', byKind: {} })],
        ['a missing count', JSON.stringify({ at: NOW.toISOString(), day: '2026-11-16', byKind: { NEWS: { channels: 1, eligible: 1, created: 1, dormant: false } } })],
        ['a non-numeric count', JSON.stringify({ at: NOW.toISOString(), day: '2026-11-16', byKind: { NEWS: { ...kind(), withContent: 'three' } } })],
        ['a negative count', JSON.stringify({ at: NOW.toISOString(), day: '2026-11-16', byKind: { NEWS: { ...kind(), created: -1 } } })],
        ['a non-boolean dormant', JSON.stringify({ at: NOW.toISOString(), day: '2026-11-16', byKind: { NEWS: { ...kind(), dormant: 'no' } } })],
    ])('refuses %s', (_label, raw) => {
        expect(parseCardHealthRecord(raw as string | null)).toBeNull();
    });

    it('WHY the missing-count case matters: undefined > undefined is false', () => {
        // A half-parsed record would make the verdict's inequality read as
        // clean from numbers that are not there. This is the whole reason the
        // parser validates rather than casts.
        expect((undefined as unknown as number) > (undefined as unknown as number)).toBe(false);
    });
});

describe('cardHealthCapability', () => {
    it('ok when every kind got what it was due', async () => {
        const cap = await cardHealthCapability(reader(JSON.stringify(record())), NOW);
        expect(cap.state).toBe('ok');
        expect(cap.shortfall).toBe(0);
        expect(cap.kindsConsidered).toBe(2);
        expect(cap.shortKinds).toEqual([]);
    });

    it('cards_missing — and NAMES the kind, so the finding is actionable', async () => {
        const cap = await cardHealthCapability(
            reader(JSON.stringify(record({ byKind: { NEWS: kind({ withContent: 5, created: 2 }), LISTING: kind() } }))),
            NOW,
        );
        expect(cap.state).toBe('cards_missing');
        expect(cap.shortfall).toBe(3);
        expect(cap.shortKinds).toEqual(['NEWS']);
    });

    it('a surplus kind does NOT offset a short one', async () => {
        // Floored per kind. Summed signed, a kind that wrote more cards than
        // it had content for would hide a kind that wrote fewer, and one short
        // kind is the finding regardless of its neighbours.
        const cap = await cardHealthCapability(
            reader(JSON.stringify(record({ byKind: {
                NEWS: kind({ withContent: 5, created: 2 }),
                LISTING: kind({ withContent: 1, created: 9 }),
            } }))),
            NOW,
        );
        expect(cap.state).toBe('cards_missing');
        expect(cap.shortfall).toBe(3);
    });

    it('a DORMANT kind is not a shortfall, and is counted so the zero is readable', async () => {
        const cap = await cardHealthCapability(
            reader(JSON.stringify(record({ byKind: {
                NEWS: kind(),
                EVENT: kind({ channels: 15, eligible: 0, withContent: 0, created: 0, dormant: true }),
            } }))),
            NOW,
        );
        expect(cap.state).toBe('ok');
        expect(cap.kindsDormant).toBe(1);
        expect(cap.kindsConsidered).toBe(2);
    });

    it('stale is judged BEFORE the shortfall', async () => {
        // A stale record's numbers describe a day that is over, so reporting
        // `ok` from them asserts something about today that nothing measured.
        const old = new Date(NOW.getTime() - (CARD_HEALTH_STALE_AFTER_MINUTES + 60) * 60_000);
        const cap = await cardHealthCapability(reader(JSON.stringify(record({ at: old.toISOString() }))), NOW);
        expect(cap.state).toBe('stale');
    });

    it('and a record just INSIDE the window is not stale — the boundary control', async () => {
        const fresh = new Date(NOW.getTime() - (CARD_HEALTH_STALE_AFTER_MINUTES - 60) * 60_000);
        const cap = await cardHealthCapability(reader(JSON.stringify(record({ at: fresh.toISOString() }))), NOW);
        expect(cap.state).toBe('ok');
    });

    it('never_recorded with no key, which must differ from stale', async () => {
        expect((await cardHealthCapability(reader(null), NOW)).state).toBe('never_recorded');
    });

    it('unknown when there is no client, and when the read throws', async () => {
        expect((await cardHealthCapability(null, NOW)).state).toBe('unknown');
        expect((await cardHealthCapability({ get: async () => { throw new Error('down'); } }, NOW)).state).toBe('unknown');
    });

    it('reports the window constants, so a reader need not guess them', async () => {
        const cap = await cardHealthCapability(reader(null), NOW);
        expect(cap.staleAfterMinutes).toBe(CARD_HEALTH_STALE_AFTER_MINUTES);
    });
});

/**
 * The probe is SPAWNED, not imported.
 *
 * `coverage-scripts.test.ts` set this pattern and the reason applies here with
 * extra force: the contract is **the exit code** — "exit 0 only on clean" — and
 * importing the module tests a return value while leaving the thing CI acts on
 * unexercised. A `process.exit(0)` on the unaudited branch would pass every
 * assertion about the returned verdict.
 *
 * `execFile` rather than `spawnSync`, because `spawnSync` blocks the event loop
 * and the fixture server would never answer the child's request.
 */
describe('the probe collapses five states to three verdicts (spawned, so the EXIT CODE is the assertion)', () => {
    const SCRIPT = join(__dirname, '../../scripts/ci/check-card-health.mjs');
    let server: Server;
    let origin = '';
    let payload: unknown = {};
    let status = 200;

    beforeAll(async () => {
        server = createServer((_req, res) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no port');
        origin = `http://127.0.0.1:${addr.port}/api/readyz`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** Runs the real CLI and returns its exit code with both streams. */
    function probe(): Promise<{ code: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            execFile('node', [SCRIPT, '--url', origin], (err, stdout, stderr) => {
                const code = err && typeof (err as { code?: number }).code === 'number'
                    ? (err as { code: number }).code
                    : err ? 1 : 0;
                resolve({ code, stdout: String(stdout), stderr: String(stderr) });
            });
        });
    }

    const body = (cardHealth: unknown, over: Record<string, unknown> = {}) => ({
        service: 'agri-saas', status: 'ready', capabilities: { cardHealth }, ...over,
    });

    beforeEach(() => { status = 200; });

    it('EXIT 0 only on clean', async () => {
        payload = body({ state: 'ok', kindsConsidered: 4, kindsDormant: 1, shortfall: 0, day: '2026-11-16' });
        const r = await probe();
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('[card-health] clean');
    });

    it('EXIT 1 and UNAUDITED when ok carries no kinds — the vacuous pass', async () => {
        // "No kind was short" over no kinds is the empty-population failure
        // the third verdict exists for. `check-release-sboms` is the
        // precedent: zero missing releases and a broken query read alike.
        payload = body({ state: 'ok', kindsConsidered: 0, shortfall: 0 });
        const r = await probe();
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('UNAUDITED');
    });

    it('EXIT 1 and MISSING on cards_missing, naming the kind', async () => {
        payload = body({ state: 'cards_missing', kindsConsidered: 4, shortfall: 3, shortKinds: ['NEWS'], day: '2026-11-16' });
        const r = await probe();
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('MISSING');
        expect(r.stderr).toContain('NEWS');
    });

    it.each(['stale', 'never_recorded', 'unknown'])('EXIT 1 and UNAUDITED on %s', async (state) => {
        payload = body({ state, kindsConsidered: 4, ageMinutes: 9999, staleAfterMinutes: 4140 });
        const r = await probe();
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('UNAUDITED');
    });

    it('EXIT 1 on a state it does not recognise, never 0', async () => {
        // A capability may gain a state before this script learns it, and
        // defaulting to clean would make that a silent downgrade.
        payload = body({ state: 'something_new', kindsConsidered: 4 });
        expect((await probe()).code).toBe(1);
    });

    it('EXIT 1 when the capability is absent — an older image', async () => {
        payload = { service: 'agri-saas', capabilities: {} };
        expect((await probe()).code).toBe(1);
    });

    it('EXIT 1 when it is somebody ELSE\'s readyz — #1117/#1143', async () => {
        // Another app served this hostname for ~6h emitting the same
        // `"status":"ready"`. A probe that skips this reports cheerfully about
        // an app with no channels at all.
        payload = body({ state: 'ok', kindsConsidered: 4 }, { service: 'inflect-compliance' });
        const r = await probe();
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('not agri-saas');
    });

    it('EXIT 0 on a 503 whose cardHealth is ok — capabilities sit outside checks', async () => {
        // readyz 503s on a dependency failure and `capabilities` is not part
        // of `checks`, so a 503 says nothing about the cards either way. The
        // availability failure is the GCP uptime check's job, not this one's.
        status = 503;
        payload = body({ state: 'ok', kindsConsidered: 4, day: '2026-11-16' });
        expect((await probe()).code).toBe(0);
    });

    it('EXIT 1 when the body is not JSON', async () => {
        payload = '<html>502 Bad Gateway</html>';
        const r = await probe();
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('UNAUDITED');
    });

    it('EXIT 1 when the host is unreachable', async () => {
        const saved = origin;
        // Port 1 is reserved and nothing listens; a refused connection must be
        // unaudited rather than clean.
        origin = 'http://127.0.0.1:1/api/readyz';
        const r = await probe();
        origin = saved;
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('UNAUDITED');
    });
});
