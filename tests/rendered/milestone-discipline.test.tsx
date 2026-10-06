/**
 * Epic 62 — end-to-end milestone-discipline contract.
 *
 * Two SHAPES of celebration exist, and both must obey the same rules:
 *   - tenant-wide, by milestone key — the records page fires
 *     `evidence-all-current`, which the hook translates itself.
 *   - per-resource, ad-hoc — a colon-scoped dedupe key so each resource
 *     earns its own celebration in one session.
 *
 * The rules:
 *   1. Re-rendering with the same triggering input does NOT re-fire.
 *   2. The dedupe is per-key, so different scopes each get their own
 *      celebration.
 *   3. Each celebration produces exactly one toast.success per session
 *      per dedupe key.
 *
 * This file walks each shape through the same transition pattern in the
 * same harness. If a future contributor wires a milestone with different
 * semantics, the divergence shows up here as an obvious "everyone else
 * does X but yours doesn't" failure.
 *
 * ── what P2.6 changed here ──
 *
 * It used to drive THREE integrations: a framework page scoped by
 * frameworkKey, an audit-pack page scoped by packId, and the evidence
 * page. The first two pages went with the GRC teardown and their
 * milestones went with P2.6, so the file was asserting discipline for two
 * surfaces nobody can reach. The per-resource SHAPE is what earned its
 * keep, so it stays — driven through the ad-hoc input, which is what a
 * future per-resource caller will use now that `scopedMilestone` is gone.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { act, render } from '@testing-library/react';

const toastSuccessMock = jest.fn();
jest.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccessMock(...args),
    },
}));

import {
    useCelebration,
    __setConfettiForTest,
} from '@/components/ui/hooks/use-celebration';
import { MILESTONES, type CelebrateInput } from '@/lib/celebrations';
import {
    isAllEvidenceCurrent,
    type EvidenceFreshnessRow,
} from '@/lib/evidence-freshness';

interface ConfettiCall {
    options: import('canvas-confetti').Options | undefined;
}
function makeConfettiStub() {
    const calls: ConfettiCall[] = [];
    const stub: (opts?: import('canvas-confetti').Options) => Promise<null> = (
        opts,
    ) => {
        calls.push({ options: opts });
        return Promise.resolve(null);
    };
    return { stub, calls };
}
async function flush(ms = 1300) {
    // Comfortably > rain preset's 1000ms tail.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

// ─── Generic harness ───────────────────────────────────────────────
//
// Each integration is reduced to "what would you celebrate, if
// anything, given this prop bundle?" — exactly mirroring the
// useEffect bodies in the real pages.

type Trigger = () => CelebrateInput | null;

function MilestoneHarness({ trigger }: { trigger: Trigger }) {
    const { celebrate } = useCelebration();
    const input = trigger();
    // Stable key for the dependency array — celebrate wraps the
    // input by value, but `JSON.stringify` of `input` is enough to
    // re-run when the trigger output materially changes. We
    // deliberately depend on the serialised form rather than the
    // live `input` reference (identity changes every trigger()).
    const inputKey = JSON.stringify(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (input === null) return; celebrate(input); }, [inputKey, celebrate]);
    return null;
}

const NOW = new Date('2026-05-03T00:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// ─── Triggers — one per integration, mirroring the page ───────────

function evidenceTrigger(args: { rows: EvidenceFreshnessRow[] }): Trigger {
    // The MILESTONE shape — the hook resolves preset, dedupe key, glyph
    // and translated copy from the registry + the `celebrations.*`
    // catalogue. This mirrors EvidenceClient.tsx exactly.
    return () => {
        if (!isAllEvidenceCurrent(args.rows, { now: NOW })) return null;
        return 'evidence-all-current';
    };
}

/**
 * The per-resource shape: one registered milestone, one colon-scoped
 * dedupe key, caller-supplied copy. `spray-job-complete` is the live
 * milestone whose natural scope is a resource id (the spray job).
 */
function sprayJobTrigger(args: { jobId: string; done: boolean }): Trigger {
    return () => {
        if (!args.done) return null;
        const def = MILESTONES['spray-job-complete'];
        return {
            preset: def.preset,
            key: `${def.key}:${args.jobId}`,
            message: `Spray job complete ${def.glyph}`,
        };
    };
}

// ─── Discipline tests ──────────────────────────────────────────────

describe('Milestone discipline — three integrations behave the same', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    const cases: Array<{
        name: string;
        triggerOff: Trigger;
        triggerOn: Trigger;
        triggerOnAlt: Trigger;
    }> = [
        {
            name: 'spray-job-complete (per-resource scope)',
            triggerOff: sprayJobTrigger({ jobId: 'job_1', done: false }),
            triggerOn: sprayJobTrigger({ jobId: 'job_1', done: true }),
            triggerOnAlt: sprayJobTrigger({ jobId: 'job_2', done: true }),
        },
    ];

    for (const { name, triggerOff, triggerOn, triggerOnAlt } of cases) {
        describe(`${name} discipline`, () => {
            it('off → on fires exactly one toast', async () => {
                const { stub } = makeConfettiStub();
                __setConfettiForTest(stub);
                const { rerender } = render(
                    <MilestoneHarness trigger={triggerOff} />,
                );
                await flush();
                expect(toastSuccessMock).not.toHaveBeenCalled();

                rerender(<MilestoneHarness trigger={triggerOn} />);
                await flush();
                expect(toastSuccessMock).toHaveBeenCalledTimes(1);
            });

            it('on → on (same scope) does NOT fire a second toast', async () => {
                const { stub } = makeConfettiStub();
                __setConfettiForTest(stub);
                const { rerender } = render(
                    <MilestoneHarness trigger={triggerOn} />,
                );
                await flush();
                rerender(<MilestoneHarness trigger={triggerOn} />);
                await flush();
                expect(toastSuccessMock).toHaveBeenCalledTimes(1);
            });

            it('on (scope A) → on (scope B) DOES fire a second toast', async () => {
                const { stub } = makeConfettiStub();
                __setConfettiForTest(stub);
                const { rerender } = render(
                    <MilestoneHarness trigger={triggerOn} />,
                );
                await flush();
                rerender(<MilestoneHarness trigger={triggerOnAlt} />);
                await flush();
                expect(toastSuccessMock).toHaveBeenCalledTimes(2);
            });
        });
    }

    // Tenant-wide milestone (no scope) — only fires once per session
    // total, regardless of subsequent state changes.
    describe('evidence-all-current discipline (tenant-wide)', () => {
        it('off → on fires exactly one toast', async () => {
            const { stub } = makeConfettiStub();
            __setConfettiForTest(stub);
            const { rerender } = render(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(1) }, { updatedAt: days(60) }],
                    })}
                />,
            );
            await flush();
            expect(toastSuccessMock).not.toHaveBeenCalled();

            rerender(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(1) }],
                    })}
                />,
            );
            await flush();
            expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        });

        it('on → on (still all current) does NOT fire a second toast', async () => {
            const { stub } = makeConfettiStub();
            __setConfettiForTest(stub);
            const { rerender } = render(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(1) }],
                    })}
                />,
            );
            await flush();
            rerender(
                <MilestoneHarness
                    trigger={evidenceTrigger({
                        rows: [{ updatedAt: days(2) }, { updatedAt: days(3) }],
                    })}
                />,
            );
            await flush();
            expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        });
    });
});
