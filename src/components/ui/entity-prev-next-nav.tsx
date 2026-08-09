'use client';

/**
 * EntityPrevNextNav (B5, 2026-06-07) — a vertical up/down pair that walks
 * to the previous / next entity in a list, rendered beside the entity name
 * on a detail page.
 *
 * The "new pattern": a detail page is usually a dead-end — you go back to the
 * list to open the next row. This gives a keyboard/pointer shortcut to step
 * through the list order without leaving the detail view. The caller supplies
 * the ORDERED ids (the same order the list shows) + an href builder; the
 * component finds the current id's neighbours and disables the ends.
 *
 * Reusable across Asset / Risk / Practice / … detail pages — pass that
 * entity's ordered id list + `hrefFor`.
 */
import { useRouter } from 'next/navigation';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

export interface EntityPrevNextNavProps {
    /** Ordered entity ids, in the same order the list page shows them. */
    ids: ReadonlyArray<string>;
    /** The id of the entity currently open. */
    currentId: string;
    /** Build the tenant-prefixed href for a neighbour id. */
    hrefFor: (id: string) => string;
    /** Noun for the a11y labels / tooltips (e.g. "asset"). */
    labelSingular?: string;
    className?: string;
}

function Chevron({ dir }: { dir: 'up' | 'down' }) {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {dir === 'up' ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
        </svg>
    );
}

export function EntityPrevNextNav({
    ids,
    currentId,
    hrefFor,
    labelSingular = 'item',
    className,
}: EntityPrevNextNavProps) {
    const router = useRouter();
    const idx = ids.indexOf(currentId);
    // Nothing to step through (single item, or the current id isn't in the
    // loaded window) → render nothing.
    if (idx < 0 || ids.length <= 1) return null;

    const prevId = idx > 0 ? ids[idx - 1] : null;
    const nextId = idx < ids.length - 1 ? ids[idx + 1] : null;

    const step = (id: string | null, dir: 'up' | 'down', label: string) => {
        const button = (
            <button
                type="button"
                disabled={!id}
                onClick={() => id && router.push(hrefFor(id))}
                aria-label={label}
                data-testid={`entity-nav-${dir === 'up' ? 'prev' : 'next'}`}
                className={cn(
                    // #75 — smaller, borderless: bare chevron buttons (no box,
                    // no background); just a subtle colour shift on hover.
                    'flex h-3.5 w-4 items-center justify-center text-content-subtle transition-colors',
                    'hover:text-content-emphasis',
                    'disabled:pointer-events-none disabled:opacity-50',
                    'focus-visible:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring',
                )}
            >
                <Chevron dir={dir} />
            </button>
        );
        // A disabled button swallows pointer events, so only the enabled
        // end gets a tooltip — the disabled end needs none.
        return id ? <Tooltip content={label}>{button}</Tooltip> : button;
    };

    return (
        <div
            // #75 — no bordered/filled box; just the bare chevron column.
            className={cn('inline-flex flex-col -my-1', className)}
            data-testid="entity-prev-next-nav"
        >
            {step(prevId, 'up', `Previous ${labelSingular}`)}
            {step(nextId, 'down', `Next ${labelSingular}`)}
        </div>
    );
}
