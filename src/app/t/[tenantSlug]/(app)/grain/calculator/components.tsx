'use client';

/**
 * Presentational pieces of the grain calculator, split out of the island.
 *
 * These render; they do not decide. Every value they show arrives already
 * resolved — the sum's terms and their signs, the cost's composition, the
 * uncertainty state — because `calculator/page.tsx` makes those decisions
 * server-side and `CalculatorClient` only arranges them.
 *
 * They live here rather than inline because the island's job is the PAGE:
 * which surfaces exist, in what order, under what conditions. A sixty-line
 * definition of how one row of a definition list looks is a different
 * concern, and having it in the same file made the page's shape hard to
 * read at a glance.
 *
 * @module grain/calculator/components
 */
import { useTranslations } from 'next-intl';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Heading, TextLink } from '@/components/ui/typography';
import { useExactMoneyFormatter } from '@/lib/tenant-context-provider';

import type { CalculatorExclusions, ExclusionEntry } from './CalculatorClient';

/** One exclusion entry rendered as a readable line. */
function describeEntry(entry: ExclusionEntry): string {
    if (typeof entry === 'string') return entry;
    if ('lotId' in entry) return entry.unitKey ? `${entry.lotId} (${entry.unitKey})` : entry.lotId;
    return `${entry.leaseId} — ${entry.reason}`;
}

// ─── One line of the sum ────────────────────────────────────────────

interface SumLineProps {
    /** Rendered before the amount so the column can be added by eye. */
    sign: '+' | '−';
    label: string;
    /** EXPECTED / ACTUAL — the term's basis, not decoration. */
    badge?: string;
    /**
     * The quantities behind the money (area, tonnes, kg) — a LIST, each
     * rendered as its own node. Joining them into one string would make
     * "125 dca" unfindable as a fact in its own right, by a test or by
     * anything else reading the DOM.
     */
    details?: readonly string[];
    amount: number | null;
    /** Shown instead of the amount when the term exists but could not be priced. */
    unavailableText?: string;
    /**
     * Wraps the amount in the shared bound phrasing when this term is not
     * exact. `atLeast` is the only one a term ever carries — a floor cost.
     * The matching `atMost` rides the RESULT, not a term.
     */
    bound?: 'atLeast';
}

/**
 * One term of `standing + onHand − produceRent − cost = netWorth`.
 *
 * The sign is rendered, not implied by colour or position, because the
 * whole point of the layout is that a reader can add the column
 * themselves and arrive at the figure below it. A minus that exists only
 * as red text is not a minus on a monochrome print-out or to anyone who
 * does not distinguish the hue.
 *
 * `−` is U+2212, not a hyphen: it is the character that aligns with the
 * `+` at the same optical weight in a tabular-nums column.
 */
export function SumLine({ sign, label, badge, details, amount, unavailableText, bound }: SumLineProps) {
    const tc = useTranslations('grain.calculator');
    const money = useExactMoneyFormatter();

    return (
        <div className="flex items-baseline justify-between gap-tight">
            <dt className="flex flex-wrap items-baseline gap-tight text-content-muted">
                <span>{label}</span>
                {badge != null && (
                    <Badge variant="outline" size="sm">
                        {badge}
                    </Badge>
                )}
                {details?.map((d) => (
                    <span key={d} className="tabular-nums text-content-subtle">
                        {d}
                    </span>
                ))}
            </dt>
            <dd className="font-medium tabular-nums text-content-emphasis">
                {unavailableText != null ? (
                    <span className="text-xs font-normal text-content-attention">
                        {unavailableText}
                    </span>
                ) : amount == null ? (
                    // The em-dash every formatter on this page already uses
                    // for a null. Signing it would assert a direction for a
                    // quantity we do not have.
                    money(null)
                ) : bound === 'atLeast' ? (
                    tc('uncertaintyAtLeast', { value: `${sign}${money(amount)}` })
                ) : (
                    `${sign}${money(amount)}`
                )}
            </dd>
        </div>
    );
}

// ─── Exclusions ─────────────────────────────────────────────────────

interface ExclusionsCardProps {
    count: number;
    classes: ReadonlyArray<{
        key: keyof CalculatorExclusions;
        labelKey: string;
        entries: ReadonlyArray<ExclusionEntry>;
        /** Where a farmer fixes this class — see EXCLUSION_CLASSES. */
        destination: { path: string; labelKey: string };
    }>;
    /** Tenant-scoped href builder, passed in so this stays presentational. */
    hrefFor: (path: string) => string;
}

/**
 * The exclusion count is ALWAYS rendered, including when it is zero —
 * "0 records excluded" is a statement; an absent line is not. The
 * accordion is the "which ones" affordance the count is useless
 * without.
 */
export function ExclusionsCard({ count, classes, hrefFor }: ExclusionsCardProps) {
    const tc = useTranslations('grain.calculator');

    return (
        <Card as="section" density="compact" className="space-y-default border-border-subtle">
            <div className="flex flex-wrap items-baseline gap-default">
                <Heading level={3} as="h2" tone="muted">
                    {tc('exclusionsTitle')}
                </Heading>
                {/* PARTIAL, in the vocabulary's one treatment for it —
                    the same badge the header wears when a read limit
                    truncated the scan. The COUNT stays and is still
                    rendered at zero: "0 records excluded" is a statement,
                    an absent line is not. Folded in, not replaced. */}
                {count > 0 && (
                    <Badge variant="warning" size="sm">
                        {tc('uncertaintyPartialBadge')}
                    </Badge>
                )}
                <Badge variant={count > 0 ? 'attention' : 'neutral'} size="md">
                    {tc('exclusionsCount', { count })}
                </Badge>
            </div>
            {count === 0 ? (
                <p className="text-xs text-content-muted">{tc('exclusionsNone')}</p>
            ) : (
                <>
                    <p className="text-xs text-content-muted">{tc('exclusionsHint')}</p>
                    <Accordion type="single" collapsible>
                        {classes.map((cls) => (
                            <AccordionItem key={cls.key} value={cls.key} density="compact">
                                <AccordionTrigger size="sm">
                                    <span className="text-left">
                                        {tc(cls.labelKey)} ({cls.entries.length})
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent size="sm">
                                    <ul className="space-y-tight pt-2 font-mono text-xs text-content-muted">
                                        {cls.entries.map((entry, i) => {
                                            // Only LOTS support a per-entry
                                            // deep link: /inventory?lotId
                                            // opens that lot's detail modal,
                                            // an affordance built for QR
                                            // codes. /rent takes a location
                                            // id and /planning a crop-plan
                                            // id, neither of which these
                                            // entries carry — so those get
                                            // the class destination below
                                            // rather than a link that would
                                            // silently ignore its argument.
                                            //
                                            // Keyed on the CLASS, not the
                                            // entry's shape: lotsUnresolvedUnit
                                            // carries {lotId, unitKey} while
                                            // lotsUnknownCommodity carries a
                                            // bare id string, and a bare lot
                                            // id is indistinguishable from a
                                            // bare planting id. The class
                                            // knows what its entries are.
                                            const lotId = cls.key.startsWith('lots')
                                                ? typeof entry === 'string'
                                                    ? entry
                                                    : 'lotId' in entry
                                                      ? entry.lotId
                                                      : null
                                                : null;
                                            const lotHref =
                                                lotId != null
                                                    ? hrefFor(`/inventory?lotId=${lotId}`)
                                                    : null;
                                            return (
                                                <li key={`${cls.key}-${i}`}>
                                                    {describeEntry(entry)}
                                                    {lotHref != null && (
                                                        <>
                                                            {' '}
                                                            <TextLink
                                                                tone="link"
                                                                href={lotHref}
                                                                className="font-sans"
                                                            >
                                                                {tc('exclOpenLot')}
                                                            </TextLink>
                                                        </>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    {/* The class destination. Present for
                                        every class — EXCLUSION_CLASSES makes
                                        it required — so no diagnosis is a
                                        dead end. It does not soften the
                                        finding: the count and the class name
                                        above are unchanged, this only adds
                                        somewhere to go. */}
                                    <p className="pt-2">
                                        <TextLink
                                            tone="link"
                                            href={hrefFor(cls.destination.path)}
                                            className="text-xs"
                                        >
                                            {tc(cls.destination.labelKey)}
                                        </TextLink>
                                    </p>
                                </AccordionContent>
                            </AccordionItem>
                        ))}
                    </Accordion>
                </>
            )}
        </Card>
    );
}
