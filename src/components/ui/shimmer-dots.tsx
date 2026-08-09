/**
 * Epic 64 — `<ShimmerDots>`.
 *
 * Lightweight, design-token-aligned dot-grid loading affordance. A
 * higher-fidelity alternative to `<Skeleton>`'s solid blocks for
 * surfaces where a textured "something is loading" feel suits better
 * (chart placeholders, sheet bodies, modal content, dashboard
 * tiles).
 *
 *   <ShimmerDots rows={4} cols={12} />
 *   <ShimmerDots rows={6} cols={20} className="h-32" />
 *
 * Why CSS instead of WebGL: a portable WebGL noise field looks great
 * but doesn't honour `prefers-reduced-motion`, can't hook into the
 * `--content-*` token system, and isn't testable under jsdom. The CSS
 * grid form below renders the same "polished, textured loading"
 * feel via a per-cell `animation-delay` wave, costs almost nothing
 * to render, and degrades cleanly when motion is reduced.
 *
 * Token integration:
 *   - dot fill uses `bg-content-muted` so the dots pick up the
 *     theme's muted text colour (light mode + dark mode flip in
 *     lockstep with the rest of the app)
 *   - container itself is transparent — drop into any surface
 *
 * Accessibility:
 *   - `role="progressbar"` + `aria-busy="true"` so screen readers
 *     announce the surface as loading; `aria-label` defaults to
 *     "Loading" but can be overridden for context
 *   - `motion-reduce:animate-none` on every dot so the wave halts
 *     for users with `prefers-reduced-motion: reduce`
 */
import { cn } from '@/lib/cn';

export interface ShimmerDotsProps {
    /** Number of dot rows. Defaults to 4. */
    rows?: number;
    /** Number of dot columns. Defaults to 16. */
    cols?: number;
    /** Tailwind size class for each dot. Defaults to "size-1" (4×4). */
    dotSize?: string;
    /** Override the accessible label. Defaults to "Loading". */
    'aria-label'?: string;
    /** Class on the outer wrapper — control the bounding box height/width. */
    className?: string;
    /** Optional `data-testid` on the outer wrapper. */
    'data-testid'?: string;
}

/**
 * Wave delay in ms per (row, col) cell. Tuned so a 16-column grid
 * sweeps in roughly one animation cycle (~1.6 s). Diagonal so the
 * wave doesn't read as a vertical or horizontal scan.
 */
const PER_CELL_DELAY_MS = 60;

export function ShimmerDots({
    rows = 4,
    cols = 16,
    dotSize = 'size-1',
    'aria-label': ariaLabel = 'Loading',
    className,
    'data-testid': testId,
}: ShimmerDotsProps) {
    const total = Math.max(0, Math.floor(rows)) * Math.max(0, Math.floor(cols));
    const safeCols = Math.max(1, Math.floor(cols));

    return (
        <div
            role="progressbar"
            aria-busy="true"
            aria-label={ariaLabel}
            data-testid={testId}
            data-shimmer-dots
            className={cn(
                'grid w-full place-items-center gap-1.5',
                className,
            )}
            style={{
                gridTemplateColumns: `repeat(${safeCols}, minmax(0, 1fr))`,
            }}
        >
            {Array.from({ length: total }, (_, i) => {
                const row = Math.floor(i / safeCols);
                const col = i % safeCols;
                // Diagonal sweep — each cell is offset by row + col,
                // wrapped to one animation cycle so the wave loops
                // smoothly without a visible reset.
                const delay = ((row + col) * PER_CELL_DELAY_MS) % 1600;
                return (
                    <span
                        key={i}
                        aria-hidden="true"
                        data-shimmer-dot
                        className={cn(
                            'rounded-full bg-content-muted/30',
                            'animate-shimmer-pulse motion-reduce:animate-none',
                            dotSize,
                        )}
                        style={{ animationDelay: `${delay}ms` }}
                    />
                );
            })}
        </div>
    );
}

export default ShimmerDots;
