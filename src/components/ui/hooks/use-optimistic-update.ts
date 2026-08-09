/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Framework-agnostic optimistic UI helper.
 *
 * Wraps a "committed" value (typically from a fetcher — SWR, React
 * Query, a server component prop, or plain `useState`) with a local
 * optimistic overlay that reflects a pending mutation. On mutation
 * failure the overlay rolls back; on success the overlay stays until
 * the caller's `value` prop changes (their data source has re-synced),
 * at which point the overlay clears and the display returns to the
 * source of truth.
 *
 * This hook intentionally does NOT know about any data-fetching
 * library. It doesn't fetch, it doesn't revalidate, it doesn't wrap
 * toasts. The caller drives the mutation inside `commit` and is
 * responsible for refetching (or otherwise producing a fresh `value`)
 * before or during the commit. That keeps this hook usable from SWR,
 * React Query, RSC revalidation, or hand-rolled `fetch` code without
 * duplicating dependencies.
 *
 * ## Lifecycle
 *
 * ```
 *             ┌──────────────────────────────────────────────┐
 *             │                                              │
 *   [idle] ──▶│update(optimistic, commit)──▶ overlay=optimistic
 *             │  isPending=true                              │
 *             │                                              ▼
 *             │                                       commit() resolves?
 *             │                                        │         │
 *             │                              success   │         │  reject
 *             │                                        ▼         ▼
 *             │                       overlay kept until value   overlay=null
 *             │                       reference changes; then    isPending=false
 *             │                       overlay=null               error re-thrown
 *             │                       isPending=false             │
 *             └──────────────────────────────────────────────────┘
 * ```
 *
 * ## Why overlay-until-value-changes instead of overlay-until-success
 *
 * When a commit resolves, the server's authoritative value hasn't
 * always propagated back to our `value` prop yet — the caller may
 * invalidate a fetch inside `commit` and the refetch may land on the
 * next tick. Clearing the overlay the instant `commit` resolves would
 * briefly show the old value (UI flicker). Clearing when `value`'s
 * reference changes hides that seam — the caller refetches, produces a
 * new reference, the effect fires, the overlay drops in one render.
 *
 * For callers that DON'T refresh their data source after `commit`, the
 * overlay stays visible for the session. That's a bug in the caller,
 * but it's a visibly-correct one: the user sees the value they just
 * set, which is what they expect.
 *
 * ## Sequential / concurrent updates
 *
 * If two `update` calls are in flight at once, the second overlay wins
 * (last-write-wins) and `isPending` stays true until all commits
 * resolve. If the first commit fails AFTER the second succeeds, the
 * overlay rolls back to the `value` prop — which is probably not what
 * you want. Callers that care about this should disable the practice
 * while `isPending` is true.
 *
 * ## Usage
 *
 * ```tsx
 * const { data: risk, refetch } = useRisk(id);
 * const { value, isPending, update } = useOptimisticUpdate(risk);
 *
 * async function markRemediated() {
 *   await update({ ...value, status: 'remediated' }, async () => {
 *     await fetch(`/api/risks/${id}`, { method: 'PATCH', body: ... });
 *     await refetch(); // produces a new `risk` reference → overlay clears
 *   });
 * }
 * ```
 */

export interface UseOptimisticUpdateOptions<T> {
    /**
     * Called on rollback. Receives the thrown error and the value we
     * rolled back to (the pre-optimistic committed value). Useful for
     * showing toasts, pushing error events, etc. Not called on
     * success — the caller already knows their `commit` resolved.
     */
    onError?: (error: unknown, rolledBackValue: T) => void;
}

export interface UseOptimisticUpdateResult<T> {
    /** The value to render. Optimistic if a commit is in flight, else
     *  the caller-supplied `value`. */
    value: T;
    /** `true` while at least one `commit` is in flight. */
    isPending: boolean;
    /**
     * Apply an optimistic overlay and run the commit. Throws whatever
     * `commit` throws, after the internal rollback has finished — so
     * callers can `try { await update(...) } catch { ... }` and the
     * rollback state is already visible when the `catch` runs.
     *
     * `optimistic` can be either a next value or a functional updater
     * `(prev) => next`, matching `useState`.
     */
    update: <R>(
        optimistic: T | ((prev: T) => T),
        commit: () => Promise<R>,
    ) => Promise<R>;
}

export function useOptimisticUpdate<T>(
    value: T,
    options: UseOptimisticUpdateOptions<T> = {},
): UseOptimisticUpdateResult<T> {
    const { onError } = options;

    // A discriminated cell so `undefined`/`null` can themselves be
    // valid optimistic values — a plain `T | null` sentinel collapses
    // those cases.
    const [overlay, setOverlay] = useState<{ value: T } | null>(null);
    const [pendingCount, setPendingCount] = useState(0);

    // Track the latest committed value + overlay in refs so functional
    // updaters and the rollback path resolve against the freshest state
    // rather than a closed-over snapshot from when `update` was built.
    // The "ref-as-mailbox" pattern: write-during-render is intentional
    // (we want the next async callback to see the most recent value,
    // not what it was when the closure captured) and matches the
    // pattern called out in React docs as the legitimate use of refs.
    const valueRef = useRef(value);
    // eslint-disable-next-line react-hooks/refs
    valueRef.current = value;
    const overlayRef = useRef(overlay);
    // eslint-disable-next-line react-hooks/refs
    overlayRef.current = overlay;

    // When the committed value reference changes, the caller's data
    // source has re-synced — safe to drop the overlay. Running this as
    // an effect keeps the render output deterministic (we don't try to
    // read-and-compare during render).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setOverlay(null);
    }, [value]);

    // Keep the latest onError in a ref so `update`'s identity stays
    // stable even when callers pass an inline arrow. Same
    // "ref-as-mailbox" pattern as the value/overlay refs above.
    const onErrorRef = useRef(onError);
    // eslint-disable-next-line react-hooks/refs
    onErrorRef.current = onError;

    const update = useCallback(
        async <R>(
            optimistic: T | ((prev: T) => T),
            commit: () => Promise<R>,
        ): Promise<R> => {
            const rollbackTarget = valueRef.current;
            // Functional updaters resolve against the visible value —
            // prior optimistic overlay if one is in flight, otherwise
            // the committed value. Matches the user's mental model:
            // "toggle what I currently see".
            const current = overlayRef.current?.value ?? valueRef.current;
            const nextOptimistic =
                typeof optimistic === "function"
                    ? (optimistic as (p: T) => T)(current)
                    : optimistic;

            setOverlay({ value: nextOptimistic });
            setPendingCount((n) => n + 1);

            try {
                const result = await commit();
                // Success: leave the overlay in place. The `useEffect`
                // above will clear it when the caller's refetched
                // `value` propagates. If the caller doesn't refetch,
                // the user still sees the value they just set — a
                // stale-but-consistent view rather than a flicker.
                return result;
            } catch (err) {
                setOverlay(null);
                onErrorRef.current?.(err, rollbackTarget);
                throw err;
            } finally {
                setPendingCount((n) => n - 1);
            }
        },
        // `value` intentionally out of deps — it's read through
        // `valueRef` so `update` keeps a stable identity for memoised
        // children.

        [],
    );

    return {
        value: overlay ? overlay.value : value,
        isPending: pendingCount > 0,
        update,
    };
}
