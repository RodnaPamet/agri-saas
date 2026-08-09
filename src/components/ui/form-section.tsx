'use client';

/**
 * `<FormSection>` — Roadmap-2 PR-6.
 *
 * Forms in the product had been bare `<fieldset>` + `space-y-default`.
 * Multi-field groups (likelihood × impact for risk scoring,
 * applicability + justification for practices, file + retention for
 * evidence upload) lived unframed — the user had to discover field
 * dependencies from context. Premium forms group fields under
 * eyebrow labels so the structure is visible before the fields
 * are read.
 *
 * Composition (top → bottom inside the section):
 *
 *   1. eyebrow      — small uppercase label naming the group
 *                      (e.g. "Scoring", "Linkage", "Justification").
 *                      Optional but RECOMMENDED — without it the
 *                      section reads as a flat divider, defeating
 *                      the purpose.
 *   2. title        — optional `<Heading level={3}>` for sections
 *                      that double as collapsible regions or that
 *                      carry their own narrative.
 *   3. description  — optional one-line helper sentence below the
 *                      title (or eyebrow if no title). Muted body
 *                      copy — explains WHY these fields matter,
 *                      not what each does (per-field hints belong
 *                      on `<FormField>`).
 *   4. children     — the fields themselves. The section sets the
 *                      vertical rhythm via `space-y-default` so
 *                      callers don't restate it.
 *
 * Spacing rhythm:
 *   • eyebrow → title       — 4 px (`mb-1` on Eyebrow).
 *   • title   → description — 4 px (`mt-1` on Caption).
 *   • description → fields  — 16 px (`mt-default` on the fields
 *                              container).
 *   • section → next section — 32 px (`space-y-section` set on
 *                                the parent, NOT here — multiple
 *                                sections compose into a `<form>`
 *                                that owns the inter-section gap).
 *
 * Why no internal collapse / expand state:
 *   Forms shouldn't hide fields by default. Collapsibility is a
 *   different primitive (`<Accordion>`). If a section is
 *   genuinely optional, mark it with the eyebrow + a "Optional"
 *   tag inline, not by hiding the rows.
 */
import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Caption, Eyebrow, Heading } from '@/components/ui/typography';

export interface FormSectionProps {
    /** Small uppercase label naming the group. */
    eyebrow?: ReactNode;
    /** Optional `<Heading level={3}>` for narrative sections. */
    title?: ReactNode;
    /** Muted helper sentence below the eyebrow / title. */
    description?: ReactNode;
    /** The fields themselves. */
    children: ReactNode;
    /** Layout overrides on the outer `<section>` element. */
    className?: string;
    /** Forwarded to the outer element (E2E selectors). */
    'data-testid'?: string;
}

export function FormSection({
    eyebrow,
    title,
    description,
    children,
    className,
    'data-testid': dataTestId,
}: FormSectionProps) {
    return (
        <section
            className={className}
            data-testid={dataTestId ?? 'form-section'}
        >
            {(eyebrow || title || description) && (
                <header className="mb-default">
                    {eyebrow && (
                        <Eyebrow data-testid="form-section-eyebrow">
                            {eyebrow}
                        </Eyebrow>
                    )}
                    {title && (
                        <Heading
                            level={3}
                            className={cn(
                                'text-content-emphasis',
                                eyebrow && 'mt-1',
                            )}
                            data-testid="form-section-title"
                        >
                            {title}
                        </Heading>
                    )}
                    {description && (
                        <Caption
                            className={cn((eyebrow || title) && 'mt-1')}
                            data-testid="form-section-description"
                        >
                            {description}
                        </Caption>
                    )}
                </header>
            )}
            <div className="space-y-default">{children}</div>
        </section>
    );
}
