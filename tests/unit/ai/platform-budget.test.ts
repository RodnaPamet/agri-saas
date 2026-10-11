/**
 * The platform's own AI spend ceiling (#1423).
 *
 * Three global jobs spend real money with no tenant to charge, so no
 * per-tenant budget can cover them and until this existed they had no ceiling
 * of any kind. The operator's only lever was removing `ANTHROPIC_API_KEY`,
 * which also disables every tenant's AI.
 *
 * The cases below are mostly about which DIRECTION each failure falls in,
 * because this is a cost control wrapped around three FAIL-SAFE callers. Every
 * one of them returns `null` or `[]` rather than throwing, so a refusal is
 * invisible unless something says so — which makes "refuse" the dangerous
 * default here and "allow, and log" the safe one. Getting those backwards
 * would silently switch off three working features.
 */
const aggregate = jest.fn();
const create = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { platformAiUsageEvent: { aggregate, create } },
}));

const warn = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a), error: jest.fn() },
}));

const envValue: { PLATFORM_AI_TOKENS_MONTHLY?: string } = {};
jest.mock('@/env', () => ({
    get env() {
        return envValue;
    },
}));

import {
    isPlatformAiSpendAllowed,
    recordPlatformAiUsage,
    getPlatformAiBudgetStatus,
    getPlatformAiTokensUsedThisMonth,
    PLATFORM_AI_JOBS,
} from '@/app-layer/ai/platform-budget';

beforeEach(() => {
    jest.clearAllMocks();
    delete envValue.PLATFORM_AI_TOKENS_MONTHLY;
    aggregate.mockResolvedValue({ _sum: { totalTokens: 0 } });
    create.mockResolvedValue({});
});

describe('the cap is opt-in', () => {
    it('ALLOWS when no cap is configured, without even reading usage', async () => {
        // The production state the day this shipped: the var is unset. A
        // default-deny would have switched off three features invisibly, and
        // not reading usage means an unconfigured deployment pays no query
        // cost per call either.
        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(true);
        expect(aggregate).not.toHaveBeenCalled();
    });

    it('allows under the cap, and refuses at or over it', async () => {
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '1000';

        aggregate.mockResolvedValue({ _sum: { totalTokens: 999 } });
        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(true);

        // AT the limit refuses, not just over it: `used >= limit`. A cap that
        // allowed the call landing exactly on the limit would overshoot by one
        // call's worth every month, which for a 1000-token job is the whole
        // margin.
        aggregate.mockResolvedValue({ _sum: { totalTokens: 1000 } });
        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(false);

        aggregate.mockResolvedValue({ _sum: { totalTokens: 1001 } });
        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(false);
    });

    it('a refusal is LOGGED, because the caller cannot say it for us', async () => {
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '10';
        aggregate.mockResolvedValue({ _sum: { totalTokens: 50 } });

        await isPlatformAiSpendAllowed('news-event-extraction');

        const [msg, fields] = warn.mock.calls[0];
        expect(String(msg)).toMatch(/budget EXCEEDED/i);
        // The job, so a reader knows WHICH of the three stopped.
        expect(fields).toEqual(expect.objectContaining({ job: 'news-event-extraction', used: 50, limit: 10 }));
    });

    it('warns on the approach without blocking', async () => {
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '100';
        aggregate.mockResolvedValue({ _sum: { totalTokens: 80 } });

        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(true);
        expect(info).toHaveBeenCalled();
    });
});

describe('an unusable cap is treated as NO cap, and says so', () => {
    it.each(['', 'lots', '0', '-5', 'NaN'])('%p does not become a zero cap', async (raw) => {
        // A typo in a deploy variable must not silently disable three jobs.
        // Zero would refuse everything — the exact invisible failure this whole
        // module is arranged to avoid.
        envValue.PLATFORM_AI_TOKENS_MONTHLY = raw;
        aggregate.mockResolvedValue({ _sum: { totalTokens: 10_000_000 } });

        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(true);
    });

    it('logs the value it could not use', async () => {
        envValue.PLATFORM_AI_TOKENS_MONTHLY = 'lots';
        await isPlatformAiSpendAllowed('field-briefing');

        const [msg, fields] = warn.mock.calls[0];
        expect(String(msg)).toMatch(/unusable/i);
        // The VALUE, not a redaction: "unusable" is unactionable without it,
        // and an operator-set token count carries no secret.
        expect(fields).toEqual(expect.objectContaining({ configured: 'lots' }));
    });

    it('accepts a fractional cap by flooring it', async () => {
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '100.9';
        aggregate.mockResolvedValue({ _sum: { totalTokens: 100 } });

        // Floored to 100, so 100 used is at the limit and refuses.
        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(false);
    });
});

describe('a database failure falls OPEN, and is visible', () => {
    it('allows the call when usage cannot be read', async () => {
        // The ledger is a cost control, not a safety one. Letting an advisory
        // job run because the count could not be read is the lesser error
        // against disabling three features whenever the database hiccups.
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '1';
        aggregate.mockRejectedValue(new Error('connection reset'));

        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(true);
        expect(String(warn.mock.calls[0][0])).toMatch(/could not read usage/i);
    });

    it('a failed RECORD never throws at the caller', async () => {
        // These callers would swallow a throw and report "no briefing today"
        // for a bookkeeping problem. Losing a ledger row is the lesser error —
        // which does mean the ledger is a FLOOR, so repeated warnings here are
        // the signal that a cap is being compared against an under-count.
        create.mockRejectedValue(new Error('disk full'));

        await expect(
            recordPlatformAiUsage({
                job: 'field-briefing',
                model: 'claude-x',
                promptTokens: 1,
                completionTokens: 2,
            }),
        ).resolves.toBeUndefined();
        expect(String(warn.mock.calls[0][0])).toMatch(/failed to record/i);
    });
});

describe('what gets recorded', () => {
    it('sums the two token counts rather than trusting a caller total', async () => {
        await recordPlatformAiUsage({
            job: 'support-scheme-extraction',
            model: 'claude-x',
            promptTokens: 120,
            completionTokens: 30,
        });

        expect(create).toHaveBeenCalledWith({
            data: {
                job: 'support-scheme-extraction',
                model: 'claude-x',
                promptTokens: 120,
                completionTokens: 30,
                totalTokens: 150,
                costMicros: 0,
            },
        });
    });

    it('every job name in the ledger is one the module declares', () => {
        // The `job` column is a plain string, so the vocabulary lives here. A
        // fourth global job that forgot to register would still compile.
        expect([...PLATFORM_AI_JOBS]).toEqual([
            'field-briefing',
            'news-event-extraction',
            'support-scheme-extraction',
        ]);
    });
});

describe('the monthly window', () => {
    it('counts from the start of the current UTC month', async () => {
        await getPlatformAiTokensUsedThisMonth();

        const where = aggregate.mock.calls[0][0].where;
        const from: Date = where.createdAt.gte;
        // UTC, not local: a cap that reset at local midnight would reset at a
        // different instant from the per-tenant budget it mirrors.
        expect(from.getUTCDate()).toBe(1);
        expect(from.getUTCHours()).toBe(0);
        expect(from.getUTCMinutes()).toBe(0);
        expect(from.getUTCFullYear()).toBe(new Date().getUTCFullYear());
        expect(from.getUTCMonth()).toBe(new Date().getUTCMonth());
    });

    it('reads zero rather than null from an empty month', async () => {
        aggregate.mockResolvedValue({ _sum: { totalTokens: null } });
        expect(await getPlatformAiTokensUsedThisMonth()).toBe(0);
    });
});

describe('the status mirrors the per-tenant budget’s shape', () => {
    it('reports null limit and null remaining when uncapped', async () => {
        aggregate.mockResolvedValue({ _sum: { totalTokens: 42 } });

        expect(await getPlatformAiBudgetStatus()).toEqual({
            used: 42,
            limit: null,
            remaining: null,
            softWarn: false,
        });
    });

    it('never reports negative remaining', async () => {
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '100';
        aggregate.mockResolvedValue({ _sum: { totalTokens: 250 } });

        const s = await getPlatformAiBudgetStatus();
        expect(s.remaining).toBe(0);
        expect(s.softWarn).toBe(true);
    });
});
