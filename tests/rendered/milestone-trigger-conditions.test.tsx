/**
 * Epic 62 — milestone trigger conditions for evidence freshness.
 *
 * Verifies the *integration logic* — the rule the page applies before
 * invoking `celebrate()`. The hook itself is covered in
 * `tests/rendered/use-celebration.test.tsx`; this file proves the page
 * calls it at the right moment and not on the wrong one.
 *
 * Strategy: instead of mounting the heavy evidence client tree (it pulls
 * in many providers), we extract the conditional surface as plain effects
 * in a tiny harness that mirrors the call-site shape — "fire when
 * isAllEvidenceCurrent + no filter + loaded + active tab".
 *
 * The harness uses the real `useCelebration` hook so dedupe behaves
 * end-to-end (including session-storage persistence between
 * re-renders), and since P2.6 that also means the toast copy is resolved
 * from the real `messages/en.json` through the project-wide `next-intl`
 * mock in `tests/rendered/setup.ts`.
 *
 * ── the framework half is gone (P2.6) ──
 *
 * This file also drove a `FrameworkHarness` for the `framework-100`
 * milestone: fire at 100% coverage, dedupe per frameworkKey. The
 * framework page went with the GRC teardown and the milestone went with
 * P2.6, so those six tests were asserting the trigger conditions of a
 * page nobody can reach. The per-resource dedupe property they covered
 * moved to `tests/rendered/scoped-celebration.test.tsx`, which drives it
 * against a live milestone.
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
import {
    isAllEvidenceCurrent,
    type EvidenceFreshnessRow,
} from '@/lib/evidence-freshness';

const NOW = new Date('2026-05-03T00:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

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
    // Comfortably > rain preset's 1000 ms tail (0 / 500 / 1000 ms
    // staggered bursts) so all setTimeout-deferred confetti calls
    // land before the assertion phase. Tests that re-render must
    // also use this default so the previous render's tail doesn't
    // bleed into the next flush window.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

// ─── Evidence harness ───────────────────────────────────────────────

function EvidenceHarness({
    rows,
    isLoading = false,
    anyFilterActive = false,
    retentionFilter = 'active',
    hydratedNow = NOW,
}: {
    rows: EvidenceFreshnessRow[];
    isLoading?: boolean;
    anyFilterActive?: boolean;
    retentionFilter?: 'active' | 'expiring' | 'archived';
    hydratedNow?: Date | null;
}) {
    const { celebrate } = useCelebration();
    React.useEffect(() => {
        if (!hydratedNow) return;
        if (retentionFilter !== 'active') return;
        if (anyFilterActive) return;
        if (isLoading) return;
        if (!isAllEvidenceCurrent(rows, { now: hydratedNow })) return;
        // The MILESTONE shape, exactly as EvidenceClient.tsx calls it —
        // the hook owns the preset, the dedupe key and the translated copy.
        celebrate('evidence-all-current');
    }, [
        rows,
        hydratedNow,
        retentionFilter,
        anyFilterActive,
        isLoading,
        celebrate,
    ]);
    return null;
}

describe('Evidence page — evidence-all-current trigger', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('fires when every active row is fresh', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }, { updatedAt: days(10) }]}
            />,
        );
        await flush();
        // Rain preset = three staggered top-edge bursts.
        expect(calls.length).toBe(3);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        expect(toastSuccessMock.mock.calls[0][0]).toContain('All records are current');
    });

    it('does not fire while the query is loading', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                isLoading={true}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire on the expiring tab', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                retentionFilter="expiring"
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire when a search/status filter is active', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                anyFilterActive={true}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire on first render when hydratedNow is null', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
                hydratedNow={null}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not fire when one row is stale', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }, { updatedAt: days(60) }]}
            />,
        );
        await flush();
        expect(calls.length).toBe(0);
    });

    it('does not re-fire on subsequent renders within the session', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { rerender } = render(
            <EvidenceHarness
                rows={[{ updatedAt: days(2) }]}
            />,
        );
        await flush();
        const firstCount = calls.length;

        rerender(
            <EvidenceHarness
                rows={[{ updatedAt: days(3) }]}
            />,
        );
        await flush();
        expect(calls.length).toBe(firstCount);
    });

    it('does not fire on an empty workspace', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        render(<EvidenceHarness rows={[]} />);
        await flush();
        expect(calls.length).toBe(0);
    });
});
