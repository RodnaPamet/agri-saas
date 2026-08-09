/**
 * @jest-environment jsdom
 */
/**
 * PR-D polish — Behavioural coverage for `useTenantPractices`'s
 * polling mode. Locked invariants:
 *
 *   1. The initial fetch fires once on mount; subsequent
 *      revalidations only fire when `pollMs > 0`.
 *   2. Each tick re-fetches and updates the cache + state.
 *   3. A transient revalidation failure preserves the last-good
 *      state (doesn't blank `options` or set `error`).
 *   4. Unmount cancels the interval (no orphan polls).
 *
 * Uses jest's fake timers so the test runs in milliseconds.
 * `useTenantRisks` + `useTenantAssets` share the same shape; the
 * structural ratchet pins parity, so one behavioural file is enough.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import {
    useTenantPractices,
    __resetTenantPracticesCacheForTests,
} from "@/lib/processes/use-tenant-practices";

const originalFetch = globalThis.fetch;

function mockFetchOnce(
    response: { id: string; ref: string | null; title: string; status: string }[],
) {
    globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => response,
    })) as unknown as typeof fetch;
}

function mockFetchError() {
    globalThis.fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
    })) as unknown as typeof fetch;
}

describe("useTenantPractices — polling mode", () => {
    beforeEach(() => {
        __resetTenantPracticesCacheForTests();
        jest.useFakeTimers();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.useRealTimers();
    });

    it("re-fetches at the pollMs cadence and updates options + status", async () => {
        // Initial fetch — practice with status DONE.
        mockFetchOnce([
            { id: "c1", ref: "AC-1", title: "Access Control", status: "DONE" },
        ]);

        const { result } = renderHook(() =>
            useTenantPractices("acme", { pollMs: 30_000 }),
        );

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.options[0]?.status).toBe("DONE");

        // Second fetch — status flips to IN_PROGRESS. The next poll
        // tick should pick this up.
        mockFetchOnce([
            {
                id: "c1",
                ref: "AC-1",
                title: "Access Control",
                status: "IN_PROGRESS",
            },
        ]);
        await act(async () => {
            jest.advanceTimersByTime(30_000);
        });
        await waitFor(() =>
            expect(result.current.options[0]?.status).toBe("IN_PROGRESS"),
        );
    });

    it("preserves last-good state on a revalidation failure", async () => {
        mockFetchOnce([
            { id: "c1", ref: null, title: "Originally DONE", status: "DONE" },
        ]);

        const { result } = renderHook(() =>
            useTenantPractices("acme", { pollMs: 10_000 }),
        );
        await waitFor(() => expect(result.current.options).toHaveLength(1));

        // Mid-flight revalidation fails — last-good options must
        // remain in place and `error` must stay null.
        mockFetchError();
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });

        expect(result.current.options).toHaveLength(1);
        expect(result.current.options[0]?.status).toBe("DONE");
        expect(result.current.error).toBeNull();
    });

    it("does NOT poll when pollMs is unset (backward compatibility)", async () => {
        const fetchSpy = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => [
                { id: "c1", ref: null, title: "Test", status: "DONE" },
            ],
        }));
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        renderHook(() => useTenantPractices("acme"));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        // Advance time well past any reasonable poll cadence — no
        // additional fetches should happen.
        await act(async () => {
            jest.advanceTimersByTime(120_000);
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("unmount stops the polling interval", async () => {
        const fetchSpy = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => [
                { id: "c1", ref: null, title: "Test", status: "DONE" },
            ],
        }));
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        const { result, unmount } = renderHook(() =>
            useTenantPractices("acme", { pollMs: 5_000 }),
        );
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        const callsBeforeUnmount = fetchSpy.mock.calls.length;

        unmount();
        await act(async () => {
            jest.advanceTimersByTime(30_000);
        });

        expect(fetchSpy.mock.calls.length).toBe(callsBeforeUnmount);
    });
});
