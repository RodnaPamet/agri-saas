import {
    Dispatch,
    SetStateAction,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

/**
 * SSR-safe typed `localStorage` hook.
 *
 * Returns a `[value, setValue]` tuple shaped like `useState` so it drops
 * into existing consumers (e.g. {@link useColumnVisibility}) without
 * churn. The persistence layer is transparent to the caller beyond that.
 *
 * ## Why the first render always returns `initialValue`
 *
 * Reading `localStorage` inside the `useState` initializer produces
 * different values on the server (no storage → fallback) and on the
 * client's first render (hydrated from storage). React reconciles by
 * keeping the server's markup, so the client's first render would be
 * *discarded* and cause a hydration-mismatch warning. This hook
 * sidesteps that by returning `initialValue` on the very first render
 * and hydrating from storage inside a `useEffect`. Consumers that show
 * a shimmer / skeleton during the initial render naturally handle the
 * one-tick delay; most of ours just render defaults that flash to the
 * persisted value, which is indistinguishable from a post-hydration
 * user interaction.
 *
 * ## Cross-tab sync
 *
 * The `storage` event fires on other same-origin tabs when a tab writes
 * to `localStorage`. The hook listens for it and re-hydrates so two
 * open tabs agree on the persisted value. A tab never sees its own
 * writes via the `storage` event (spec) — that's fine, the writer
 * already holds the current value in React state.
 *
 * ## Corrupted storage
 *
 * A malformed JSON payload (user edited devtools, an older schema left
 * behind, a storage-quota truncation) is swallowed silently and the
 * `initialValue` wins. Crashing on parse would brick the feature until
 * the user clears storage; a silent fall-through degrades gracefully.
 *
 * ## Custom serializer
 *
 * The default serializer is `JSON.stringify` / `JSON.parse`, which
 * round-trips plain data cleanly. If you store `Date` / `Map` / `Set` /
 * `BigInt` and care about exact shape, pass a custom
 * `{ serialize, deserialize }`. This keeps the common case zero-config.
 *
 * ## Setter API
 *
 * Accepts either a next value OR a functional updater
 * `(prev) => next`, matching `useState`. Writing in functional form
 * guarantees you're merging against the freshest stored state even
 * when a state update is already in flight.
 */

export interface UseLocalStorageOptions<T> {
    /**
     * Serialize a value to the string that goes into storage. Default:
     * `JSON.stringify`. Override if the default would lose fidelity
     * (e.g. `Date` → string, `BigInt` throws on stringify).
     */
    serialize?: (value: T) => string;
    /**
     * Inverse of `serialize`. Default: `JSON.parse`. Must be defensive
     * enough to throw on malformed input — the hook catches and falls
     * back to `initialValue`.
     */
    deserialize?: (raw: string) => T;
    /**
     * Subscribe to the `storage` event and re-read from `localStorage`
     * when another same-origin tab writes to the same key. Default:
     * `true`. Turn off for hot-path hooks where two-tab drift is
     * acceptable and the listener cost is not (rare).
     */
    syncAcrossTabs?: boolean;
}

function readStorage<T>(
    key: string,
    fallback: T,
    deserialize: (raw: string) => T,
): T {
    if (typeof window === "undefined") return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        return deserialize(raw);
    } catch {
        // Either `localStorage` access threw (disabled / privacy mode)
        // or `deserialize` threw (malformed payload). Either way, the
        // caller's `initialValue` is the safest fallback.
        return fallback;
    }
}

export function useLocalStorage<T>(
    key: string,
    initialValue: T,
    options: UseLocalStorageOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
    const {
        serialize = JSON.stringify,
        deserialize = JSON.parse as (raw: string) => T,
        syncAcrossTabs = true,
    } = options;

    // Render with `initialValue` first — NOT a storage read — so the
    // server and client produce identical HTML. Hydration happens in
    // the effect below.
    const [storedValue, setStoredValue] = useState<T>(initialValue);

    // Track the latest value in a ref so the write effect can bail if
    // the hydration effect is about to overwrite with the same value.
    // The "ref-as-mailbox" write-during-render is intentional — the
    // ref is a side channel to async callbacks, not part of the
    // render output, so the React Compiler rule's caution doesn't apply.
    const latestRef = useRef(storedValue);
    // eslint-disable-next-line react-hooks/refs -- ref-as-mailbox: a side channel to the write effect rather than render output, so that effect can bail when hydration is about to set the same value
    latestRef.current = storedValue;

    // Serializer identities matter for the effects below. Wrap in refs
    // so the caller can pass inline `{ serialize, deserialize }` options
    // without triggering a re-hydrate on every render.
    const serializeRef = useRef(serialize);
    const deserializeRef = useRef(deserialize);
    // eslint-disable-next-line react-hooks/refs -- ref-as-mailbox: holds the caller's serializer so an inline options object does not re-trigger hydration on every render
    serializeRef.current = serialize;
    // eslint-disable-next-line react-hooks/refs -- ref-as-mailbox: same for the deserializer — identity stability, not render output
    deserializeRef.current = deserialize;

    // Hydrate from storage on mount and whenever the key changes. The
    // read runs client-only (guarded inside `readStorage`).
    useEffect(() => {
        const hydrated = readStorage(key, initialValue, deserializeRef.current);
        setStoredValue(hydrated);
        // `initialValue` intentionally omitted — callers typically pass
        // it inline (`useLocalStorage('k', {})`) which would thrash the
        // effect. The first render already uses it; storage reads
        // supersede it thereafter.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    // Cross-tab sync. The `storage` event fires on OTHER tabs when ANY
    // tab writes to storage, so we re-read when the event's key matches.
    useEffect(() => {
        if (!syncAcrossTabs) return;
        if (typeof window === "undefined") return;

        const onStorage = (e: StorageEvent) => {
            if (e.storageArea !== window.localStorage) return;
            if (e.key !== key && e.key !== null) return;
            // `e.key === null` means storage was cleared — fall back.
            const next = readStorage(
                key,
                initialValue,
                deserializeRef.current,
            );
            setStoredValue(next);
        };

        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
        // Same reasoning as above re: `initialValue`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, syncAcrossTabs]);

    const setValue = useCallback<Dispatch<SetStateAction<T>>>(
        (next) => {
            setStoredValue((prev) => {
                const resolved =
                    typeof next === "function"
                        ? (next as (p: T) => T)(prev)
                        : next;
                if (typeof window !== "undefined") {
                    try {
                        window.localStorage.setItem(
                            key,
                            serializeRef.current(resolved),
                        );
                    } catch {
                        // Storage quota exceeded, Safari private mode,
                        // or the serializer threw. In-memory state
                        // still updates so the UI stays consistent for
                        // this session — we just can't persist.
                    }
                }
                return resolved;
            });
        },
        [key],
    );

    return [storedValue, setValue];
}
