"use client";

/**
 * `<NextBestActionCard>` — state-driven recommendation card (v2-PR-11).
 *
 * Replaces the Quick-Actions 6-button grid (the previous "here are
 * six things you could do" pattern) with a SINGLE decisive
 * recommendation: "here's what you should do next."
 *
 * Why this is a feature
 *   The 6-button grid presented all actions as co-equal — no
 *   hierarchy, no situational awareness. Premium products tell users
 *   what to do next based on current state. Linear surfaces "fix
 *   broken builds" when a build is failing; Stripe surfaces
 *   "verify your bank account" when payments are pending. IC's
 *   compliance equivalent is the readiness chain.
 *
 * Priority chain (first hit wins):
 *   1. Overdue evidence → "Refresh overdue evidence"
 *   2. Overdue tasks    → "Resolve overdue tasks"
 *   3. High-severity risks (count > 0) → "Review high-severity risks"
 *   4. Coverage < 80%   → "Improve practice coverage"
 *   5. Default          → "Run readiness check"
 *
 * Below the primary CTA: a quiet 3-link "quick adds" row in muted
 * text — preserves the most useful "create" affordances without the
 * 6-button noise.
 *
 * Pairs with:
 *   - <DashboardLayout> (v2-PR-6) — typical placement is the footer
 *     of the dashboard composition.
 *   - <HeroMetric> (v2-PR-10) — the hero shows the verdict; this
 *     card shows the action that improves the verdict.
 */

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

import { Card } from "./card";
import { Heading } from "./typography";
import { Button } from "./button";
import { BadgeCheck } from "./icons/nucleo/badge-check";
import {
    resolveNextBestAction,
    type NextBestAction,
    type NextBestActionInput,
} from "./next-best-action-logic";

// ─── R17-PR10 — Urgency-tinted glow ──────────────────────────────────
//
// The next-best-action card carries one of five action.ids. Each
// represents a different urgency tier:
//
//   • overdue-evidence + overdue-tasks → URGENT. Something is
//     already past its deadline. Warm red-orange tint pulls the
//     eye in the same emotional register as a Stripe "verify
//     bank account" prompt — "this is the next thing you should
//     fix."
//   • high-risks                       → ATTENTION. Severity is
//     elevated but no SLA has been missed yet. Warmer amber tint.
//   • low-coverage                     → INFORMATIONAL. Coverage
//     is below target but it's a marathon, not a sprint. Cool
//     info-blue tint that reads as "here's the long road."
//   • readiness-check                  → CALM. Nothing urgent;
//     suggest a low-cost confirmation action. Brand-default tint
//     ties this state to the rest of the dashboard's resting
//     warmth.
//
// The glow is always a corner radial wash (240px) anchored at
// the upper-right — opposite to MetricCard's upper-left glow,
// so the eye reads "this card has its OWN visual identity, not
// a sibling tile." Static, no breath; the mast-head is the only
// breathing surface.
const URGENCY_GLOW_BY_ID: Record<NextBestAction["id"], string> = {
    "overdue-evidence":
        "before:bg-[radial-gradient(circle_240px_at_95%_5%,var(--bg-error)_0%,transparent_55%)]",
    "overdue-tasks":
        "before:bg-[radial-gradient(circle_240px_at_95%_5%,var(--bg-error)_0%,transparent_55%)]",
    "high-risks":
        "before:bg-[radial-gradient(circle_240px_at_95%_5%,var(--bg-warning)_0%,transparent_55%)]",
    "low-coverage":
        "before:bg-[radial-gradient(circle_240px_at_95%_5%,var(--bg-info)_0%,transparent_55%)]",
    "readiness-check":
        "before:bg-[radial-gradient(circle_240px_at_95%_5%,var(--brand-subtle)_0%,transparent_55%)]",
};

export {
    resolveNextBestAction,
    type NextBestAction,
    type NextBestActionInput,
};

export interface QuickAdd {
    label: string;
    href: string;
}

export interface NextBestActionCardProps {
    input: NextBestActionInput;
    tenantHref: (path: string) => string;
    /**
     * Optional muted "quick adds" row rendered below the primary
     * CTA. Capped at 3 entries — more than that defeats the purpose
     * of the card. Pages should pick the highest-frequency creates.
     */
    quickAdds?: QuickAdd[];
    className?: string;
}

export function NextBestActionCard({
    input,
    tenantHref,
    quickAdds,
    className,
}: NextBestActionCardProps) {
    const action = resolveNextBestAction(input, tenantHref);

    return (
        <Card
            className={cn(
                "relative isolate overflow-hidden",
                // R17-PR10 — urgency-tinted corner glow. The radial
                // wash colour comes from the action.id → token map
                // above; the layering classes are stable across all
                // ids so the only thing that varies between urgency
                // tiers is the tone.
                "before:content-[''] before:absolute before:inset-0 before:-z-10 before:pointer-events-none",
                URGENCY_GLOW_BY_ID[action.id],
                className,
            )}
            data-next-best-action
            data-next-best-action-id={action.id}
            data-next-best-action-urgency-glow
        >
            <Heading level={3} className="mb-1">
                {/*
                    R17-PR11 — small celebration affordance on the
                    "all clear" state. The readiness-check action.id
                    fires only when overdue evidence + overdue tasks
                    + high risks are all zero AND coverage ≥ 80%.
                    Showing a green check next to the heading at that
                    moment is the dashboard's "you did it" feedback —
                    Stripe-style positive reinforcement without
                    being saccharine. Other action.ids (urgency or
                    attention tiers) intentionally skip this — the
                    check would conflict with the urgency glow.
                */}
                {action.id === "readiness-check" && (
                    <BadgeCheck
                        className="inline-block w-5 h-5 text-content-success mr-2 align-text-bottom"
                        aria-hidden="true"
                        data-next-best-action-clear-check
                    />
                )}
                {action.label}
            </Heading>
            <p
                className="text-sm text-content-muted mb-4"
                data-next-best-action-description
            >
                {action.description}
            </p>
            <Link href={action.href}>
                <Button
                    variant="primary"
                    size="md"
                    data-testid="next-best-action-cta"
                >
                    {action.label}
                </Button>
            </Link>
            {quickAdds && quickAdds.length > 0 && (
                <div
                    className="mt-4 pt-3 border-t border-border-subtle flex flex-wrap items-center gap-tight text-xs text-content-subtle"
                    data-next-best-action-quick-adds
                >
                    <span className="font-medium text-content-muted">
                        Quick add:
                    </span>
                    {quickAdds.slice(0, 3).map((qa, i) => (
                        <React.Fragment key={qa.href}>
                            {i > 0 && <span aria-hidden="true">·</span>}
                            <Link
                                href={qa.href}
                                className="text-content-muted hover:text-content-emphasis transition-colors duration-150 ease-out"
                            >
                                {qa.label}
                            </Link>
                        </React.Fragment>
                    ))}
                </div>
            )}
        </Card>
    );
}
