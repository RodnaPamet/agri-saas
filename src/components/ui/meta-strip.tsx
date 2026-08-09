/**
 * Polish PR-5 — `<MetaStrip>` primitive.
 *
 * A horizontal grid of label-on-top, value-below pairs that lives
 * between the page header and the tab bar on every entity detail
 * page. Standardises the "entity facts at a glance" surface so a
 * user crossing detail pages — Risk → Practice → Task → Vendor —
 * always sees status / owner / dates / framework in the same
 * typographic register, in the same place.
 *
 * Why a primitive
 *   Until this PR each detail page jammed entity facts into the
 *   PageHeader's free-form `meta` slot:
 *     - risks/[id] used a hardcoded STATUS_VARIANT object literal
 *       inside the page
 *     - practices/[id] rendered a 5-cell info grid as part of an
 *       overview card
 *     - tasks/[id] rendered owner + dates inline next to the title
 *     - vendors/[id], policies/[id], audits/[id] each invented their
 *       own shape
 *   Result: opening a Risk, a Practice, and a Task felt like reading
 *   three pages of three different products.
 *
 * Composition contract
 *   - The strip wraps in a single horizontal grid (md:grid-cols-N
 *     based on item count; flex-wrap on mobile).
 *   - Every item renders an Eyebrow-style label (text-xs uppercase
 *     muted) on top of a typographic value (text-sm content-default).
 *   - Status values pass `kind: 'status'` + `variant: StatusBadgeVariant`
 *     and render via `<StatusBadge size="sm">`.
 *   - Numeric values pass `kind: 'metric'` + optional `tone` and
 *     render via `<KPIStat size="sm">` from `@/components/ui/metric`.
 *   - Plain text / link values render as Eyebrow + text or
 *     anchor.
 *
 * Editorial cap
 *   Strip MUST NOT wrap to two rows on desktop. The convention is
 *   ≤ 5 items. Page authors should pick what deserves the strip;
 *   secondary facts belong inside tab content.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { KPIStat, type MetricTone } from '@/components/ui/metric';

// ─── Item shapes ─────────────────────────────────────────────────────

interface MetaItemBase {
    /** Eyebrow label rendered above the value. */
    label: React.ReactNode;
    /** Optional href — wraps the entire item in a hover-tinted Link. */
    href?: string;
    /**
     * Optional DOM id placed on the value element (status badge for
     * `kind: 'status'`, value span for text/metric). Preserves long-
     * lived E2E test anchors.
     */
    id?: string;
}

interface MetaItemText extends MetaItemBase {
    kind?: 'text';
    /** Plain text or rich element. */
    value: React.ReactNode;
    tone?: MetricTone;
}

interface MetaItemStatus extends MetaItemBase {
    kind: 'status';
    /** Status badge label — what the badge says. */
    value: React.ReactNode;
    /** Status badge variant. */
    variant: StatusBadgeVariant;
}

interface MetaItemMetric extends MetaItemBase {
    kind: 'metric';
    /** Numeric value. */
    value: React.ReactNode;
    tone?: MetricTone;
}

export type MetaItem = MetaItemText | MetaItemStatus | MetaItemMetric;

// ─── Component ───────────────────────────────────────────────────────

export interface MetaStripProps {
    items: ReadonlyArray<MetaItem>;
    className?: string;
    'data-testid'?: string;
}

export function MetaStrip({
    items,
    className,
    'data-testid': testId = 'meta-strip',
}: MetaStripProps) {
    if (items.length === 0) return null;
    return (
        <div
            className={cn(
                'flex flex-wrap gap-x-section gap-y-default',
                className,
            )}
            data-testid={testId}
        >
            {items.map((item, idx) => (
                <MetaItemRender key={idx} item={item} />
            ))}
        </div>
    );
}

function MetaItemRender({ item }: { item: MetaItem }) {
    const labelClass =
        'text-[11px] font-medium uppercase tracking-wide text-content-muted';

    if (item.kind === 'status') {
        const inner = (
            <div className="flex flex-col gap-0.5">
                <span className={labelClass}>{item.label}</span>
                <StatusBadge variant={item.variant} size="sm" id={item.id}>
                    {item.value}
                </StatusBadge>
            </div>
        );
        return wrapHref(inner, item.href);
    }

    if (item.kind === 'metric') {
        const inner = (
            <KPIStat
                id={item.id}
                value={item.value}
                label={item.label}
                tone={item.tone}
                size="sm"
            />
        );
        return wrapHref(inner, item.href);
    }

    // Default = text
    const inner = (
        <div className="flex flex-col gap-0.5 min-w-0">
            <span className={labelClass}>{item.label}</span>
            <span
                id={item.id}
                className={cn(
                    'text-sm tabular-nums truncate',
                    item.tone === 'success' && 'text-content-success',
                    item.tone === 'attention' && 'text-content-warning',
                    item.tone === 'critical' && 'text-content-error',
                    !item.tone && 'text-content-default',
                )}
            >
                {item.value}
            </span>
        </div>
    );
    return wrapHref(inner, item.href);
}

function wrapHref(node: React.ReactNode, href?: string): React.ReactElement {
    if (!href) return <>{node}</>;
    return (
        <a
            href={href}
            className="block rounded-md transition-colors duration-150 ease-out hover:bg-bg-muted/50 -m-1 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
            {node}
        </a>
    );
}
