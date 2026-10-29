/**
 * Executing tests for the canary's durable record (#2467).
 *
 * These EXECUTE both halves rather than asserting about their source, because
 * the property at stake is behavioural: a key that is written with a TTL, or
 * written only on success, or read back as fresh when it is a day old, all
 * look identical in a structural scan. The wiring that calls them is held
 * separately by `tests/guards/mail-canary-records-its-run.test.ts`.
 *
 * The round-trip test is the load-bearing one. The writer and the reader are
 * two modules agreeing on a key name and a JSON shape, and nothing else in the
 * repo would notice them drifting apart — a seam, in the sense of
 * `a-seam-is-a-new-collector`.
 */
import {
    MAIL_CANARY_PERIOD_MINUTES,
    MAIL_CANARY_RECORD_KEY,
    MAIL_CANARY_STALE_AFTER_MINUTES,
    parseMailCanaryRecord,
    recordMailCanaryRun,
} from '@/lib/email/mail-canary-record';
import { mailCanaryCapability } from '@/lib/email/mail-canary-capability';
import type { MailCanaryResult } from '@/app-layer/jobs/mail-canary';

/** Minimal in-memory stand-in for the two commands these modules use. */
function fakeRedis() {
    const store = new Map<string, string>();
    const setCalls: unknown[][] = [];
    return {
        store,
        setCalls,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set: jest.fn(async (...args: any[]) => {
            setCalls.push(args);
            store.set(String(args[0]), String(args[1]));
            return 'OK';
        }),
        get: jest.fn(async (k: string) => store.get(k) ?? null),
    };
}

const sent: MailCanaryResult = { outcome: 'SENT', provider: 'ResendProvider' };
const at = (iso: string) => () => new Date(iso);

describe('recordMailCanaryRun', () => {
    it('writes the record under the shared key', async () => {
        const r = fakeRedis();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordMailCanaryRun(r as any, sent, at('2026-10-30T06:00:00.000Z'));
        expect(r.store.get(MAIL_CANARY_RECORD_KEY)).toBe(
            JSON.stringify({
                at: '2026-10-30T06:00:00.000Z',
                outcome: 'SENT',
                provider: 'ResendProvider',
            }),
        );
    });

    it('sets NO expiry, so absence keeps meaning "never ran"', async () => {
        const r = fakeRedis();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await recordMailCanaryRun(r as any, sent);
        // Exactly key + value. A third argument would be 'EX'/'PX'/'KEEPTTL',
        // and a TTL here collapses `never_recorded` into `stale` — the single
        // confusion #2467 exists to remove.
        expect(r.setCalls).toHaveLength(1);
        expect(r.setCalls[0]).toHaveLength(2);
        expect(r.setCalls[0].join(' ')).not.toMatch(/\bEX\b|\bPX\b|KEEPTTL/i);
    });

    it.each(['SENT', 'SKIPPED_NO_RECIPIENT', 'NOT_CONFIGURED', 'FAILED'] as const)(
        'records the %s outcome too, not just successes',
        async (outcome) => {
            const r = fakeRedis();
            await recordMailCanaryRun(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                r as any,
                { outcome, provider: 'ResendProvider', detail: 'boom' },
            );
            const stored = parseMailCanaryRecord(r.store.get(MAIL_CANARY_RECORD_KEY) ?? null);
            expect(stored?.outcome).toBe(outcome);
        },
    );

    it('persists no recipient and no provider detail', async () => {
        const r = fakeRedis();
        await recordMailCanaryRun(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            r as any,
            {
                outcome: 'FAILED',
                provider: 'ResendProvider',
                detail: 'Resend API error 403: key revoked for someone@example.test',
            },
        );
        const raw = r.store.get(MAIL_CANARY_RECORD_KEY) ?? '';
        // /api/readyz is probed unauthenticated from six regions, so this
        // value is effectively public. The enum is the signal; the detail
        // stays in the log.
        expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['at', 'outcome', 'provider']);
        expect(raw).not.toMatch(/example\.test/);
        expect(raw).not.toMatch(/revoked/);
    });

    it('never throws when the write fails', async () => {
        const r = {
            set: jest.fn(async () => {
                throw new Error('READONLY You cannot write against a read only replica');
            }),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(recordMailCanaryRun(r as any, sent)).resolves.toBeUndefined();
    });
});

describe('parseMailCanaryRecord', () => {
    it('reads a record it wrote', () => {
        const raw = JSON.stringify({ at: '2026-10-30T06:00:00.000Z', outcome: 'SENT', provider: 'P' });
        expect(parseMailCanaryRecord(raw)).toEqual({
            at: '2026-10-30T06:00:00.000Z',
            outcome: 'SENT',
            provider: 'P',
        });
    });

    it.each([
        ['absent', null],
        ['empty', ''],
        ['not JSON', '{nope'],
        ['not an object', '42'],
        ['null', 'null'],
        ['no timestamp', JSON.stringify({ outcome: 'SENT', provider: 'P' })],
        ['unparseable timestamp', JSON.stringify({ at: 'soon', outcome: 'SENT', provider: 'P' })],
        ['unknown outcome', JSON.stringify({ at: '2026-10-30T06:00:00Z', outcome: 'WAT', provider: 'P' })],
        ['no provider', JSON.stringify({ at: '2026-10-30T06:00:00Z', outcome: 'SENT' })],
    ])('reads %s as null rather than throwing', (_label, raw) => {
        expect(parseMailCanaryRecord(raw)).toBeNull();
    });
});

describe('mailCanaryCapability', () => {
    const write = async (r: ReturnType<typeof fakeRedis>, outcome: MailCanaryResult['outcome'], when: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recordMailCanaryRun(r as any, { outcome, provider: 'ResendProvider' }, at(when));

    it('reports unknown when Redis is unconfigured', async () => {
        const c = await mailCanaryCapability(null);
        expect(c.state).toBe('unknown');
        expect(c.outcome).toBeNull();
        expect(c.lastRunAt).toBeNull();
    });

    it('reports unknown — not stale — when the read fails', async () => {
        const r = { get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any);
        // Collapsing this into `stale` would send an operator to the mail
        // subsystem during a Redis incident.
        expect(c.state).toBe('unknown');
    });

    it('reports never_recorded when no key exists', async () => {
        const c = await mailCanaryCapability(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fakeRedis() as any,
        );
        expect(c.state).toBe('never_recorded');
    });

    it('round-trips a fresh SENT run to ok', async () => {
        const r = fakeRedis();
        await write(r, 'SENT', '2026-10-30T06:00:00.000Z');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any, at('2026-10-30T07:30:00.000Z'));
        expect(c).toEqual({
            state: 'ok',
            outcome: 'SENT',
            lastRunAt: '2026-10-30T06:00:00.000Z',
            ageMinutes: 90,
            expectedEveryMinutes: MAIL_CANARY_PERIOD_MINUTES,
            staleAfterMinutes: MAIL_CANARY_STALE_AFTER_MINUTES,
        });
    });

    it.each(['SKIPPED_NO_RECIPIENT', 'NOT_CONFIGURED', 'FAILED'] as const)(
        'reports a fresh %s as not_sending, distinctly from stale',
        async (outcome) => {
            const r = fakeRedis();
            await write(r, outcome, '2026-10-30T06:00:00.000Z');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const c = await mailCanaryCapability(r as any, at('2026-10-30T07:00:00.000Z'));
            expect(c.state).toBe('not_sending');
            expect(c.outcome).toBe(outcome);
        },
    );

    it('tolerates ONE missed run', async () => {
        const r = fakeRedis();
        await write(r, 'SENT', '2026-10-30T00:00:00.000Z');
        // 7h later: one run (06:00) has been missed, and that must not shout.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any, at('2026-10-30T07:00:00.000Z'));
        expect(c.state).toBe('ok');
        expect(c.ageMinutes).toBe(420);
    });

    it('reports stale once the record outlives the threshold', async () => {
        const r = fakeRedis();
        await write(r, 'SENT', '2026-10-29T00:00:00.000Z');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any, at('2026-10-30T00:00:00.000Z'));
        expect(c.state).toBe('stale');
        expect(c.ageMinutes).toBe(24 * 60);
        // The outcome is still reported: "it was fine, 24h ago" and "it failed,
        // 24h ago" are different situations.
        expect(c.outcome).toBe('SENT');
    });

    it('reports stale even when the stale record says SENT', async () => {
        const r = fakeRedis();
        await write(r, 'SENT', '2026-10-01T00:00:00.000Z');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any, at('2026-10-30T00:00:00.000Z'));
        // Staleness outranks the outcome — a month-old success is not "ok",
        // which is the whole defect: an erased record and a passing canary
        // must not read alike.
        expect(c.state).toBe('stale');
    });

    it('treats a malformed stored value as never_recorded', async () => {
        const r = fakeRedis();
        r.store.set(MAIL_CANARY_RECORD_KEY, '{truncated');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any);
        expect(c.state).toBe('never_recorded');
    });

    it('clamps a future timestamp instead of reporting a negative age', async () => {
        const r = fakeRedis();
        await write(r, 'SENT', '2026-10-30T12:00:00.000Z');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = await mailCanaryCapability(r as any, at('2026-10-30T06:00:00.000Z'));
        expect(c.ageMinutes).toBe(0);
        expect(c.state).toBe('ok');
    });

    it('states the window it judged against', async () => {
        // Without these two the age is a number with no scale, and a reader
        // has to open the source to know whether 420 minutes is a problem.
        const c = await mailCanaryCapability(null);
        expect(c.expectedEveryMinutes).toBe(360);
        expect(c.staleAfterMinutes).toBeGreaterThan(c.expectedEveryMinutes * 2);
    });
});
