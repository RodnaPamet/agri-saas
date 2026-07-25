"use client";

import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value.
 *
 * Returns `value` unchanged on first render, then re-emits it only once
 * it has been stable for `delayMs`. The canonical use is a live search
 * box whose query drives a SERVER request: without this, every keystroke
 * is a round trip.
 *
 * Deliberately debounces the VALUE, not a callback. A callback debouncer
 * has to be memoised at every call site or it resets its own timer each
 * render — a value hook cannot be misused that way.
 *
 * @example
 *   const debounced = useDebounce(search, 300);
 *   const params = useMemo(() => build(debounced), [debounced]);
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        // Always via a timer, even at delayMs === 0: a synchronous
        // setState inside an effect is a cascading render, and a 0ms
        // timeout already lands on the next tick with the same
        // semantics.
        const timer = setTimeout(() => setDebounced(value), Math.max(0, delayMs));
        // Clearing on every change is what makes this a debounce rather
        // than a throttle: only a pause longer than `delayMs` emits.
        return () => clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
}
