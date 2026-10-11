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

/** Every warning message logged so far, in no particular order. */
const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

describe('a database failure falls OPEN, and is visible', () => {
    it('allows the call when usage cannot be read', async () => {
        // The ledger is a cost control, not a safety one. Letting an advisory
        // job run because the count could not be read is the lesser error
        // against disabling three features whenever the database hiccups.
        envValue.PLATFORM_AI_TOKENS_MONTHLY = '1';
        aggregate.mockRejectedValue(new Error('connection reset'));

        expect(await isPlatformAiSpendAllowed('field-briefing')).toBe(true);
        expect(warnings()).toContainEqual(expect.stringMatching(/could not read usage/i));
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
        // Over ALL warnings, not `calls[0]`. Recording now derives the cost,
        // and the estimator warns about an un-priced model (`claude-x` here) —
        // so the record-failure warning is no longer first. The order of two
        // unrelated warnings was never the property under test; coupling to it
        // made this fail on a change that did not affect what it checks.
        expect(warnings()).toContainEqual(expect.stringMatching(/failed to record/i));
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
                // `claude-x` matches no key in the price table, so 0 is the
                // CORRECT cost here — and that is exactly why the next case
                // exists. This assertion doubles as the negative control for
                // it: on its own, a `costMicros: 0` expectation is satisfied
                // both by a working estimator and by the bug #1631 reported.
                costMicros: 0,
            },
        });
    });

    it('derives a NON-ZERO cost for a priced model (#1631)', async () => {
        // The defect: `costMicros` was 0 on every row. The parameter existed,
        // all four callers omitted it, and `?? 0` turned four omissions into a
        // confident zero — so `SUM("costMicros")` answered "nothing" to "what
        // has the platform's AI cost".
        //
        // 1M prompt + 1M completion on Haiku list prices ($1 in / $5 out per
        // 1M) is $6, and the column is MICRO-dollars, so 6_000_000. Asserting
        // the exact figure rather than `> 0` because the unit is the part worth
        // pinning: a factor-of-1000 slip would read as plausible spend.
        await recordPlatformAiUsage({
            job: 'field-briefing',
            model: 'claude-haiku-4-5',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
        });

        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({ costMicros: 6_000_000 }),
        });
    });

    it('prices a DATED model id the same as its base id', async () => {
        // `support-scheme-extractor` pins `claude-haiku-4-5-20251001` while the
        // other three pin `claude-haiku-4-5`. The table is matched by longest
        // substring, so both resolve — but that is a property of `lookupPrice`
        // that this module depends on and does not own, so it is pinned here:
        // a table keyed on exact ids would price the dated one at 0 and
        // under-state one job of four with nothing saying so.
        await recordPlatformAiUsage({
            job: 'support-scheme-extraction',
            model: 'claude-haiku-4-5-20251001',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
        });

        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({ costMicros: 6_000_000 }),
        });
    });

    it('an UN-PRICED model records 0 and says so', async () => {
        // The other half of #1631. A model missing from the price table still
        // records 0 — correctly, since nothing is known about its cost — but it
        // is now LOUD instead of silent. That matters because a silent 0 is
        // indistinguishable from the bug this fixed: the operator reading
        // `SUM("costMicros")` needs to know the total excludes a model, and the
        // warning is the only thing that can tell them.
        await recordPlatformAiUsage({
            job: 'field-briefing',
            model: 'some-new-model-nobody-priced',
            promptTokens: 1_000,
            completionTokens: 1_000,
        });

        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({ costMicros: 0 }),
        });
        expect(warnings()).toContainEqual(expect.stringMatching(/no price entry/i));
    });

    it('an explicit costMicros still wins over the estimate', async () => {
        // The parameter survives as an override for a figure the estimator
        // cannot produce — a provider-reported charge. Zero is deliberately NOT
        // the test value: `0` would pass whether the override is honoured or
        // silently replaced by an estimate of 0.
        await recordPlatformAiUsage({
            job: 'notice-score',
            model: 'claude-haiku-4-5',
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
            costMicros: 42,
        });

        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({ costMicros: 42 }),
        });
    });

    it('every job name in the ledger is one the module declares', () => {
        // The `job` column is a plain string, so the vocabulary lives here. A
        // fourth global job that forgot to register would still compile.
        //
        // That fourth job arrived: `notice-score` (P5.5b, #1596) shadow-scores
        // DSA notices. It is the first entry whose VOLUME is set by the public
        // rather than by a schedule over data we already hold — a notice
        // arrives because somebody filed one on an endpoint that needs no
        // credential — so it is the first for which this ceiling is
        // load-bearing rather than prudent.
        expect([...PLATFORM_AI_JOBS]).toEqual([
            'field-briefing',
            'news-event-extraction',
            'support-scheme-extraction',
            'notice-score',
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
