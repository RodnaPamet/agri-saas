'use client';

/**
 * R11-PR10 — <ChecklistCard>: onboarding / progress-aware checklist.
 *
 * The canonical surface for guided multi-step flows. Use cases:
 *
 *   - **Empty-tenant onboarding** — first-time tenant lands on the
 *     dashboard with zero data. A ChecklistCard guides them: install
 *     a framework, add a risk, link a practice, upload evidence.
 *
 *   - **Feature-readiness gates** — pages that require prerequisites
 *     (e.g. "Before you can run access reviews, configure SSO + add
 *     5+ team members") render their preconditions through this.
 *
 *   - **Multi-step settings** — admin pages with sequential setup
 *     (notification channels, integrations) display their step
 *     progress through this primitive.
 *
 * Design contract:
 *
 *   - Each step has a `done` flag, a label, and an optional CTA. The
 *     primitive renders a check icon when done, a dashed circle when not.
 *   - The card shows a progress count ("3 of 5 complete") in the
 *     header. When all steps are done, the card collapses to a
 *     success state.
 *   - CTAs render as inline `<Button>` so they pick up R11-PR4's
 *     press-feedback microinteraction automatically.
 *
 * Pairs with `<EmptyState>` for empty-tenant flows: EmptyState
 * shows "you have no data yet"; ChecklistCard shows "here's how to
 * change that."
 */

import { cn } from '@/lib/cn';
import { AppIcon } from '@/components/icons/AppIcon';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import type { ReactNode } from 'react';
import { Button } from './button';

export interface ChecklistStep {
    /** Unique identifier — used for keying + data-testid. */
    id: string;
    /** Human-readable step label. */
    label: string;
    /** Optional secondary line under the label. */
    description?: ReactNode;
    /** Whether this step has been completed. */
    done: boolean;
    /** Optional CTA — renders as a small Button next to the step. */
    action?: {
        label: string;
        href?: string;
        onClick?: () => void;
    };
}

export interface ChecklistCardProps {
    /** Card header title (e.g. "Get started"). */
    title: string;
    /** Optional description below the title. */
    description?: ReactNode;
    /** The ordered list of steps. */
    steps: ChecklistStep[];
    /** Optional override for the "all done" copy. */
    completedLabel?: string;
    /** Forwarded to outer wrapper. */
    className?: string;
    /** Forwarded to outer wrapper for E2E selectors. */
    'data-testid'?: string;
}

export function ChecklistCard({
    title,
    description,
    steps,
    completedLabel = 'All set — you\'re ready to roll.',
    className,
    'data-testid': dataTestId = 'checklist-card',
}: ChecklistCardProps) {
    const total = steps.length;
    const completed = steps.filter((s) => s.done).length;
    const allDone = total > 0 && completed === total;

    return (
        <Card
            className={cn('p-6', className)}
            data-testid={dataTestId}
            data-checklist-complete={allDone ? 'true' : 'false'}
        >
            <div className="flex items-start justify-between gap-default mb-4">
                <div>
                    <Heading level={3} className="text-base">
                        {title}
                    </Heading>
                    {description && (
                        <p className="text-sm text-content-muted mt-1">
                            {description}
                        </p>
                    )}
                </div>
                <span
                    className="text-xs text-content-muted whitespace-nowrap font-mono tabular-nums"
                    data-testid={`${dataTestId}-progress`}
                >
                    {completed} of {total}
                </span>
            </div>

            {allDone ? (
                <p className="text-sm text-content-success font-medium flex items-center gap-tight">
                    <AppIcon name="checkCircle" size={16} aria-hidden="true" />
                    {completedLabel}
                </p>
            ) : (
                <ul className="space-y-tight" role="list">
                    {steps.map((step) => (
                        <li
                            key={step.id}
                            className="flex items-start gap-compact"
                            data-testid={`${dataTestId}-step-${step.id}`}
                            data-step-done={step.done ? 'true' : 'false'}
                        >
                            <span
                                className={cn(
                                    'flex-shrink-0 mt-0.5 flex items-center justify-center size-5 rounded-full transition-colors duration-150 ease-out',
                                    step.done
                                        ? 'bg-bg-success text-content-success'
                                        : 'bg-bg-muted text-content-muted',
                                )}
                                aria-hidden="true"
                            >
                                <AppIcon
                                    name={step.done ? 'checkCircle' : 'circleDashed'}
                                    size={12}
                                />
                            </span>
                            <div className="flex-1 min-w-0">
                                <span
                                    className={cn(
                                        'text-sm block',
                                        step.done
                                            ? 'text-content-muted line-through'
                                            : 'text-content-default',
                                    )}
                                >
                                    {step.label}
                                </span>
                                {step.description && (
                                    <span className="text-xs text-content-subtle mt-0.5 block">
                                        {step.description}
                                    </span>
                                )}
                            </div>
                            {step.action && !step.done && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={step.action.onClick}
                                    data-testid={`${dataTestId}-step-${step.id}-action`}
                                >
                                    {step.action.label}
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}
