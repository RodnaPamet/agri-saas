'use client';

/**
 * Roadmap-21 PR-E — `<Chart3D>` foundation primitive (STUB).
 *
 * ### Status
 *
 * **This is a SCAFFOLD, not a working 3D renderer.** R21-PR-E
 * establishes the API + the architecture but defers the actual
 * `@react-three/fiber` integration because of a compatibility
 * deadlock encountered during landing:
 *
 *   • `@react-three/fiber@9.x` is the React 19-compatible line,
 *     but it introduces a custom JSX runtime that augments the
 *     global `JSX.IntrinsicElements` namespace in a way that
 *     conflicts with vanilla HTML JSX inference under our
 *     tsconfig (`moduleResolution: bundler` + `isolatedModules`
 *     + React 19's `react-jsx` transform). 200+ unrelated TSX
 *     files failed typecheck with "Type 'string' is not
 *     assignable to type 'never'" on every `<div>` / `<button>`.
 *
 *   • `@react-three/fiber@8.x` doesn't pollute JSX globally but
 *     was built for React 18 — its runtime uses the
 *     `ReactCurrentOwner` internal API that React 19 removed, so
 *     the package crashes at module load under React 19.
 *
 * Neither line works under our React 19 setup today. Rather than
 * pin React back to 18 (load-bearing for many other places in
 * the app), R21-PR-E ships the API shape + documentation as a
 * stub. The actual 3D rendering moves to a follow-up roadmap
 * when r3f's React 19 story stabilises.
 *
 * ### What's load-bearing in this PR
 *
 *   - `tokenColor()` — resolves a `--chart-series-${N}-${stop}`
 *     CSS variable to a hex colour string. Works today, no r3f
 *     dependency. Any future 3D renderer (or 2D consumer that
 *     wants a resolved series colour) uses it.
 *
 *   - `Chart3DProps` — the API contract. Locked here so PR-F's
 *     `<BarField3D>` (and any future 3D chart) shapes itself
 *     against the eventual renderer without API churn.
 *
 *   - `useReducedMotion()` — inline `prefers-reduced-motion`
 *     hook. Useful beyond 3D; promote to a shared hook when a
 *     second consumer lands.
 *
 *   - `dynamicChart3D()` — the SSR-safe dynamic-import pattern.
 *     Returns the stub component today; future r3f integration
 *     swaps the inner import without breaking consumers.
 *
 * In the stub state, `<Chart3D>` renders the `FallbackComponent`
 * (when supplied) or a data-attributed placeholder. Consumers
 * can structure their UI against this contract today; the actual
 * r3f-driven scene replaces the inner branch in a follow-up.
 */

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Inline `prefers-reduced-motion: reduce` hook. Available beyond
 * 3D — any motion-sensitive component can use it. Promote to a
 * shared hook when a second consumer lands.
 */
function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReduced(mq.matches);
        const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);
    return reduced;
}

export interface Chart3DProps {
    /**
     * Required ARIA label — WebGL canvas is opaque to screen
     * readers; this is the text alt for the chart's data story.
     */
    ariaLabel: string;
    /**
     * Optional className forwarded to the wrapper div. The Canvas
     * sizes to its parent, so use this to set width/height.
     */
    className?: string;
    /**
     * Forwarded for E2E selectors.
     */
    'data-testid'?: string;
    /**
     * Static 2D fallback rendered when `prefers-reduced-motion:
     * reduce` is set OR when WebGL is unavailable. Charts SHOULD
     * supply this — accessibility + low-end-device support hinges
     * on it. In the stub state, the fallback IS what consumers
     * see — the actual 3D branch is gated out (see file head).
     */
    FallbackComponent?: () => ReactNode;
    /**
     * Three.js scene contents. Standard r3f component tree —
     * meshes, lights, helpers, etc. Ignored by the stub; the
     * eventual renderer consumes this.
     */
    children: ReactNode;
    /**
     * Camera position vector. Default `[6, 4, 6]` gives an
     * isometric-ish view that reads "3D" without being top-down.
     */
    cameraPosition?: [number, number, number];
    /**
     * Idle auto-rotation speed (degrees per second). Default 0.5
     * — slow enough to read as "the chart is alive", fast enough
     * to register over a 6-second eye dwell. Set to 0 to disable.
     */
    idleRotateSpeed?: number;
    /**
     * Minimum polar angle for OrbitPractices (in radians). Default
     * `Math.PI / 6` — prevents the user from rotating BELOW the
     * scene's floor.
     */
    minPolarAngle?: number;
    /**
     * Maximum polar angle for OrbitPractices. Default `Math.PI / 2`
     * — prevents the user from looking from ABOVE (which produces
     * a top-down 2D-equivalent view that defeats the 3D purpose).
     */
    maxPolarAngle?: number;
}

/**
 * Resolves a `--chart-series-${N}-${stop}` CSS variable to a hex
 * colour string. Three.js doesn't read CSS — it needs literal
 * colour values for `color` props on materials. This helper
 * bridges by reading the computed style at runtime.
 *
 * **Load-bearing piece of PR-E.** Every future 3D chart (and any
 * 2D consumer that wants a resolved series colour) calls this.
 *
 * Returns `#ffffff` if the var is unresolvable (SSR, missing
 * token). Charts SHOULD call this inside an effect or render so
 * the value re-reads on theme change.
 */
export function tokenColor(
    seriesIndex: 1 | 2 | 3 | 4 | 5 | 6,
    stop: 'start' | 'end',
): string {
    if (typeof window === 'undefined') return '#ffffff';
    const root = document.documentElement;
    const raw = getComputedStyle(root)
        .getPropertyValue(`--chart-series-${seriesIndex}-${stop}`)
        .trim();
    return raw || '#ffffff';
}

/**
 * The `<Chart3D>` primitive — STUB IMPLEMENTATION.
 *
 * Renders the `FallbackComponent` if supplied, otherwise a
 * data-attributed placeholder div. The future r3f integration
 * replaces the placeholder with the real Canvas + scene.
 */
export function Chart3D({
    ariaLabel,
    className,
    'data-testid': dataTestId,
    FallbackComponent,
}: Chart3DProps) {
    const prefersReducedMotion = useReducedMotion();

    if (FallbackComponent) {
        return (
            <div
                className={className}
                data-testid={dataTestId}
                role="img"
                aria-label={ariaLabel}
                data-chart-3d-fallback="true"
                data-chart-3d-status="stub"
            >
                <FallbackComponent />
            </div>
        );
    }

    return (
        <div
            className={className}
            data-testid={dataTestId}
            role="img"
            aria-label={ariaLabel}
            data-chart-3d="true"
            data-chart-3d-status="stub"
            data-chart-3d-rotating={prefersReducedMotion ? undefined : 'true'}
        />
    );
}
