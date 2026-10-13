'use client';

/**
 * useReducedMotion — public hook for JS-driven motion (map flyTo easing,
 * haptics, RAF loops) to honour `prefers-reduced-motion`. CSS animations
 * already degrade globally (tokens.css flattens animation-duration under the
 * media query); this hook is for the cases CSS can't reach.
 *
 * SSR-safe: defaults to `false` (motion on) so the server markup matches the
 * first client render, then resolves on mount and stays live via the
 * matchMedia change event.
 */
import { useState, useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Subscribe to the media query itself.
 *
 * This is the case `useSyncExternalStore` was added for, and the one place in
 * this repo where the subscription is REAL rather than a formality: a reader
 * can turn reduced-motion on while the page is open, and the charts must
 * follow. The previous implementation did follow it — via
 * `mq.addEventListener('change', …)` plus `setReduced` — and carried an
 * `eslint-disable react-hooks/set-state-in-effect` for the post-mount sync,
 * which is a suppression rather than a fix (#1471).
 */
function subscribe(onChange: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
    }
    const mq = window.matchMedia(QUERY);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
}

/** A boolean, so React's value comparison makes this snapshot stable. */
function getSnapshot(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(QUERY).matches;
}

/**
 * The server has no media queries, so it cannot know — and `false` is the
 * right answer there for the same reason the old `useState(false)` was: markup
 * that assumes motion is allowed, corrected on the client if it is not.
 */
function getServerSnapshot(): boolean {
    return false;
}

export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Imperative one-shot check (for non-React modules like haptics). */
export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(QUERY).matches;
}
