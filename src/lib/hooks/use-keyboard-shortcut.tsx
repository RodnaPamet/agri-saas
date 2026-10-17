'use client';

/**
 * Epic 57 — shared keyboard shortcut system.
 *
 * Single canonical hook for every app-wide or component-local shortcut.
 * One `window.keydown` listener per provider; registrations are held in
 * a ref map so registration / unregistration does not re-render the
 * tree. Exactly one listener fires per keystroke — priority ties are
 * broken by most-recently-registered (LIFO), so a modal's Escape wins
 * against a page's Escape without either side having to know about the
 * other.
 *
 *   import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
 *
 *   useKeyboardShortcut('mod+k', () => openPalette(), {
 *       description: 'Open command palette',
 *   });
 *
 *   useKeyboardShortcut(['Escape'], closeModal, {
 *       scope: 'overlay',        // only fires while a modal/sheet is open
 *       priority: 10,            // beats any global Escape binding
 *   });
 *
 * Safety:
 *   - Ignores events from editable targets (INPUT, TEXTAREA, SELECT,
 *     contenteditable, role=textbox|combobox|searchbox) unless the
 *     consumer opts in with `allowInInputs: true`. Preserves normal
 *     typing behaviour in forms, filters, and the palette's own input.
 *   - Distinguishes "global" (no overlay open) from "overlay" scope so
 *     a modal's bindings don't fight the underlying page.
 *   - `preventDefault` + `stopImmediatePropagation` are on by default;
 *     opt out per shortcut when the browser default is required.
 *
 * The provider must be mounted once, near the root, inside
 * `src/app/providers.tsx`. Without it the hook is a no-op (we log a
 * warning in development so misuse surfaces immediately).
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
    type ReactNode,
} from 'react';

import {
    matchShortcut,
    parseShortcut,
    type ParsedShortcut,
} from './keyboard-shortcut-internals';

// ─── Public API types ──────────────────────────────────────────────────

export type ShortcutInput = string | string[];

export type ShortcutHandler = (
    event: KeyboardEvent,
    context: { matched: string },
) => void;

export type ShortcutScope = 'global' | 'overlay';

export interface UseKeyboardShortcutOptions {
    /** Whether this shortcut is active. Defaults to `true`. */
    enabled?: boolean;
    /** Higher values win. Defaults to `0`. */
    priority?: number;
    /** Call `event.preventDefault()` when matched. Defaults to `true`. */
    preventDefault?: boolean;
    /** Call `event.stopImmediatePropagation()` when matched. Defaults to `true`. */
    stopPropagation?: boolean;
    /** Fire even when the event target is editable (INPUT / TEXTAREA / …). Defaults to `false`. */
    allowInInputs?: boolean;
    /** Fire even while a modal / sheet / popover overlay is open. Defaults to `false`. */
    allowWhenOverlayOpen?: boolean;
    /**
     * `'global'` shortcuts fire only when *no* overlay is open.
     * `'overlay'` shortcuts fire only when an overlay *is* open.
     * Combine with `allowWhenOverlayOpen` for "fire either way".
     * Defaults to `'global'`.
     */
    scope?: ShortcutScope;
    /** Free-form label surfaced by the forthcoming command palette. */
    description?: string;

    /**
     * @deprecated Legacy alias kept for incremental migration.
     *             `modal: true` maps to `scope: 'overlay'`.
     */
    modal?: boolean;
    /**
     * @deprecated Legacy alias kept for incremental migration.
     *             `sheet: true` maps to `scope: 'overlay'`.
     */
    sheet?: boolean;
}

export interface RegisteredShortcut {
    id: string;
    keys: string[];
    priority: number;
    scope: ShortcutScope;
    description?: string;
}

// ─── Internal types ────────────────────────────────────────────────────

interface ResolvedOptions {
    enabled: boolean;
    priority: number;
    preventDefault: boolean;
    stopPropagation: boolean;
    allowInInputs: boolean;
    allowWhenOverlayOpen: boolean;
    scope: ShortcutScope;
    description?: string;
}

interface ShortcutEntry {
    id: string;
    parsed: ParsedShortcut[];
    handler: ShortcutHandler;
    options: ResolvedOptions;
    /** Monotonic registration order — higher = more recent. */
    order: number;
}

interface RegistryApi {
    register: (entry: ShortcutEntry) => void;
    unregister: (id: string) => void;
    /** Snapshot of current registrations — for the command palette. */
    snapshot: () => RegisteredShortcut[];
    /** Subscribe for `useSyncExternalStore`. Returns an unsubscribe fn. */
    subscribe: (fn: () => void) => () => void;
    /** `true` when a real provider is mounted. Gates the development warning. */
    mounted: boolean;
}

// ─── Registry constants & helpers ──────────────────────────────────────

let globalOrderCounter = 0;
const nextOrder = (): number => ++globalOrderCounter;

const OVERLAY_SELECTOR = [
    // Radix Dialog (modal), used by Modal on desktop.
    '[role="dialog"][data-state="open"]',
    // Vaul Drawer (Modal on mobile, Sheet on desktop + mobile).
    '[data-vaul-drawer][data-state="open"]',
    // Legacy/app-level markers.
    '[data-sheet-overlay]',
    '[data-modal-overlay]',
].join(', ');

function isOverlayOpen(): boolean {
    if (typeof document === 'undefined') return false;
    return document.querySelector(OVERLAY_SELECTOR) !== null;
}

const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox']);

function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).getAttribute !== 'function') {
        return false;
    }
    const el = target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    // `isContentEditable` is a computed property that jsdom does not
    // evaluate against CSS, so it can return `false` for
    // `<div contentEditable />`. Fall back to the attribute — any
    // non-"false" value counts as editable.
    if (el.isContentEditable) return true;
    const editable = el.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') return true;
    const role = el.getAttribute('role');
    if (role && INPUT_ROLES.has(role)) return true;
    return false;
}

// Fallback registry used when the hook renders outside of a provider.
// All ops are no-ops — shortcuts are inert until the provider mounts.
// Misuse surfaces naturally: the keystroke simply does nothing, which
// is the quickest signal that the provider is missing from the tree.
const noopRegistry: RegistryApi = {
    register: () => {},
    unregister: () => {},
    snapshot: () => [],
    subscribe: () => () => {},
    mounted: false,
};

const KeyboardShortcutContext = createContext<RegistryApi>(noopRegistry);

// ─── Provider ──────────────────────────────────────────────────────────

/**
 * Mount once near the root of the app. Installs a single
 * `window.keydown` listener and routes each event to the
 * highest-priority registered handler.
 */
export function KeyboardShortcutProvider({
    children,
}: {
    children: ReactNode;
}) {
    const listenersRef = useRef<Map<string, ShortcutEntry>>(new Map());
    const subscribersRef = useRef<Set<() => void>>(new Set());

    const notify = useCallback(() => {
        for (const fn of subscribersRef.current) fn();
    }, []);

    const register = useCallback(
        (entry: ShortcutEntry) => {
            listenersRef.current.set(entry.id, entry);
            notify();
        },
        [notify],
    );

    const unregister = useCallback(
        (id: string) => {
            if (listenersRef.current.delete(id)) notify();
        },
        [notify],
    );

    const snapshot = useCallback((): RegisteredShortcut[] => {
        const out: RegisteredShortcut[] = [];
        for (const entry of listenersRef.current.values()) {
            out.push({
                id: entry.id,
                keys: entry.parsed.map((p) => p.raw),
                priority: entry.options.priority,
                scope: entry.options.scope,
                description: entry.options.description,
            });
        }
        return out;
    }, []);

    const subscribe = useCallback((fn: () => void) => {
        subscribersRef.current.add(fn);
        return () => {
            subscribersRef.current.delete(fn);
        };
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (listenersRef.current.size === 0) return;

            const overlayOpen = isOverlayOpen();
            const editableTarget = isEditableTarget(event.target);

            let best: { entry: ShortcutEntry; matched: string } | null = null;

            for (const entry of listenersRef.current.values()) {
                const opts = entry.options;
                if (!opts.enabled) continue;
                if (editableTarget && !opts.allowInInputs) continue;
                if (
                    overlayOpen &&
                    opts.scope === 'global' &&
                    !opts.allowWhenOverlayOpen
                ) {
                    continue;
                }
                if (!overlayOpen && opts.scope === 'overlay') continue;

                let matchedKey: string | null = null;
                for (const parsed of entry.parsed) {
                    if (matchShortcut(event, parsed)) {
                        matchedKey = parsed.raw;
                        break;
                    }
                }
                if (matchedKey === null) continue;

                if (
                    best === null ||
                    opts.priority > best.entry.options.priority ||
                    (opts.priority === best.entry.options.priority &&
                        entry.order > best.entry.order)
                ) {
                    best = { entry, matched: matchedKey };
                }
            }

            if (best === null) return;

            const opts = best.entry.options;
            if (opts.preventDefault) event.preventDefault();
            if (opts.stopPropagation) event.stopImmediatePropagation();
            best.entry.handler(event, { matched: best.matched });
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    const api = useMemo<RegistryApi>(
        () => ({
            register,
            unregister,
            snapshot,
            subscribe,
            mounted: true,
        }),
        [register, unregister, snapshot, subscribe],
    );

    return (
        <KeyboardShortcutContext.Provider value={api}>
            {children}
        </KeyboardShortcutContext.Provider>
    );
}

// ─── Public hook ───────────────────────────────────────────────────────

function resolveOptions(options: UseKeyboardShortcutOptions): ResolvedOptions {
    const legacyWantsOverlay = options.modal === true || options.sheet === true;
    return {
        enabled: options.enabled !== false,
        priority: options.priority ?? 0,
        preventDefault: options.preventDefault !== false,
        stopPropagation: options.stopPropagation !== false,
        allowInInputs: options.allowInInputs === true,
        allowWhenOverlayOpen: options.allowWhenOverlayOpen === true,
        scope: options.scope ?? (legacyWantsOverlay ? 'overlay' : 'global'),
        description: options.description,
    };
}

export function useKeyboardShortcut(
    keys: ShortcutInput,
    handler: ShortcutHandler,
    options: UseKeyboardShortcutOptions = {},
): void {
    const api = useContext(KeyboardShortcutContext);

    // Stable id for this hook instance. Replaces `useId()` because Jest's
    // jsdom project renders several instances per test and `useId()` can
    // collide across strict-mode double-invokes in older React builds.
    const idRef = useRef<string | null>(null);
    // One-shot lazy initialiser — runs at most once on first render.

    if (idRef.current === null) {
        // One-shot lazy init: Math.random() runs once per hook instance, not per render.
        // Stored in a ref so the value survives. Both rules fire on this line:
        // /refs (writing ref.current during render), /purity (Math.random()).
        // eslint-disable-next-line react-hooks/purity
        idRef.current = Math.random().toString(36).slice(2) + '-' + nextOrder();
    }
    // eslint-disable-next-line react-hooks/refs -- reads the id written by the one-shot lazy initialiser directly above; the WRITE is the purity mute on that line, this is only the read
    const id = idRef.current;

    const handlerRef = useRef<ShortcutHandler>(handler);
    // "ref-as-mailbox" — keep the global keydown dispatcher reading the latest handler
    // without re-binding the document listener every render.
    // eslint-disable-next-line react-hooks/refs -- ref-as-mailbox: the global keydown dispatcher reads the latest handler without re-binding the document listener every render
    handlerRef.current = handler;

    const keyList = useMemo(
        () => (Array.isArray(keys) ? keys : [keys]),
        // `keys` identity changes every render for inline arrays — stabilise
        // on the joined string so re-renders don't thrash the registry.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [Array.isArray(keys) ? keys.join('\x00') : keys],
    );

    const parsed = useMemo(() => keyList.map(parseShortcut), [keyList]);

    const resolved = useMemo(
        () => resolveOptions(options),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the option FIELDS, not the `options` object, so a caller passing a fresh literal each render does not re-resolve. The rule wants `options`; depending on its identity is what this is avoiding (#1730)
        [
            options.enabled,
            options.priority,
            options.preventDefault,
            options.stopPropagation,
            options.allowInInputs,
            options.allowWhenOverlayOpen,
            options.scope,
            options.modal,
            options.sheet,
            options.description,
        ],
    );

    useEffect(() => {
        const entry: ShortcutEntry = {
            id,
            parsed,
            handler: (event, ctx) => handlerRef.current(event, ctx),
            options: resolved,
            order: nextOrder(),
        };
        api.register(entry);
        return () => {
            api.unregister(id);
        };
    }, [api, id, parsed, resolved]);
}

// ─── Introspection hook (for the command palette) ──────────────────────

/**
 * Subscribe to the current set of registered shortcuts. Re-renders when
 * shortcuts come or go. Safe to call outside the provider — returns an
 * empty array.
 */
export function useRegisteredShortcuts(): RegisteredShortcut[] {
    const api = useContext(KeyboardShortcutContext);
    const subscribe = useCallback(
        (onStoreChange: () => void) => api.subscribe(onStoreChange),
        [api],
    );
    const getSnapshot = useCallback(() => api.snapshot(), [api]);
    // useSyncExternalStore's getSnapshot must return a stable identity
    // between changes, otherwise React rebails. Cache by ref.
    const cacheRef = useRef<RegisteredShortcut[]>([]);
    const getStable = useCallback(() => {
        const next = getSnapshot();
        const prev = cacheRef.current;
        if (
            prev.length === next.length &&
            prev.every((p, i) => {
                const n = next[i];
                return (
                    p.id === n.id &&
                    p.priority === n.priority &&
                    p.scope === n.scope &&
                    p.description === n.description &&
                    p.keys.length === n.keys.length &&
                    p.keys.every((k, j) => k === n.keys[j])
                );
            })
        ) {
            return prev;
        }
        cacheRef.current = next;
        return next;
    }, [getSnapshot]);
    return useSyncExternalStore(subscribe, getStable, () => cacheRef.current);
}
