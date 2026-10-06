/**
 * Epic 62 — per-resource (scoped) celebration trigger conditions.
 *
 * This file was `audit-pack-celebration.test.tsx` until P2.6. Its subject
 * — the `audit-pack-complete` milestone and the audit-pack page — went
 * with the GRC teardown and with P2.6's registry cull, so the FILE was
 * asserting the trigger conditions of a surface nobody can reach.
 *
 * What it was actually proving is worth keeping: that a celebration scoped
 * to ONE resource fires once per resource, survives a real status
 * transition without re-firing, and does not leak its dedupe across
 * resources. That contract now belongs to the ad-hoc input shape (the
 * `scopedMilestone` helper that used to build it had no production callers
 * left, so it went too), and the live milestone whose natural scope is a
 * resource id is `spray-job-complete`: a spray job spans several parcels,
 * and each JOB deserves its own moment.
 *
 * "Complete" for a spray job maps onto `DONE` and the terminal
 * `VERIFIED` — both render the same finished state, and both deserve the
 * celebration, which is the same two-terminal-status shape the audit pack
 * had (FROZEN / EXPORTED) and the reason the dedupe test below is the
 * load-bearing one.
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
import { MILESTONES } from '@/lib/celebrations';

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
async function flush(ms = 800) {
    // Longest preset stagger is fireworks at 0 / 250 / 500 ms — 800 ms
    // gives every burst a chance to land before the assertion.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

/**
 * Mirror of what a page's effect would do: one registered milestone, one
 * colon-scoped dedupe key, caller-supplied copy.
 *
 * The colon separator is the convention — see the "Per-resource scoping"
 * note in `src/lib/celebrations.ts` and the sessionStorage behaviour
 * pinned in `tests/unit/celebrations.test.ts`.
 */
function SprayJobHarness({
    jobId,
    jobStatus,
    fieldName,
}: {
    jobId: string;
    jobStatus: string | undefined;
    fieldName?: string;
}) {
    const { celebrate } = useCelebration();
    const jobComplete = jobStatus === 'DONE' || jobStatus === 'VERIFIED';
    React.useEffect(() => {
        if (!jobComplete) return;
        const def = MILESTONES['spray-job-complete'];
        celebrate({
            preset: def.preset,
            key: `${def.key}:${jobId}`,
            message: `Spray job complete ${def.glyph}`,
            description: fieldName
                ? `${fieldName} — every parcel on the job is done.`
                : undefined,
        });
    }, [jobComplete, jobId, fieldName, celebrate]);
    return null;
}

describe('Per-resource celebration — spray-job scope', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('does not fire while the job is IN_PROGRESS', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<SprayJobHarness jobId="job_1" jobStatus="IN_PROGRESS" />);
        await flush();
        expect(calls.length).toBe(0);
        expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    it('does not fire while the job is loading (status undefined)', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<SprayJobHarness jobId="job_1" jobStatus={undefined} />);
        await flush();
        expect(calls.length).toBe(0);
    });

    it('fires once on DONE', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <SprayJobHarness jobId="job_1" jobStatus="IN_PROGRESS" />,
        );
        await flush();
        expect(calls.length).toBe(0);

        rerender(<SprayJobHarness jobId="job_1" jobStatus="DONE" />);
        await flush();
        // `spray-job-complete` is the burst preset = one confetti call.
        expect(calls.length).toBe(1);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        expect(toastSuccessMock.mock.calls[0][0]).toContain('Spray job complete');
    });

    it('also treats VERIFIED as complete', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<SprayJobHarness jobId="job_1" jobStatus="VERIFIED" />);
        await flush();
        expect(calls.length).toBe(1);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire when the same job re-renders complete', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <SprayJobHarness jobId="job_1" jobStatus="DONE" />,
        );
        await flush();
        const firstCount = calls.length;

        rerender(<SprayJobHarness jobId="job_1" jobStatus="VERIFIED" />);
        await flush();
        // Same job, same dedupe key — no second celebration even though
        // DONE → VERIFIED is a real status transition.
        expect(calls.length).toBe(firstCount);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    });

    it('two different jobs each get their own celebration', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <SprayJobHarness jobId="job_1" jobStatus="DONE" />,
        );
        await flush();
        const firstCount = calls.length;
        expect(firstCount).toBeGreaterThan(0);

        rerender(<SprayJobHarness jobId="job_2" jobStatus="DONE" />);
        await flush();
        expect(calls.length).toBeGreaterThan(firstCount);
        expect(toastSuccessMock).toHaveBeenCalledTimes(2);
    });

    it('embeds the field name in the toast description when provided', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <SprayJobHarness
                jobId="job_1"
                jobStatus="DONE"
                fieldName="Блок 7 — пшеница"
            />,
        );
        await flush();
        const [, opts] = toastSuccessMock.mock.calls[0] as [
            string,
            { description?: string },
        ];
        expect(opts.description).toContain('Блок 7 — пшеница');
    });
});
