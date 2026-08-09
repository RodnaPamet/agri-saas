"use client";

/**
 * `<DashboardLayout>` — composition shell for dashboard pages (v2-PR-6).
 *
 * Sits next to `<EntityListPage>` (lists) and `<EntityDetailLayout>`
 * (detail) as the third public layout primitive. Replaces the
 * hand-rolled `<div className="space-y-section ...">` + inline
 * header block that every dashboard page used to spell out.
 *
 * Why the third shell:
 *   Dashboards are NOT lists (no DataTable / FilterToolbar) and NOT
 *   detail pages (no entity, no tab bar). They have their own rhythm:
 *     - title row at top
 *     - stack of metric / chart / list cards in a vertical-section
 *       cadence
 *     - optional final CTA row
 *   Trying to force dashboards through `EntityListPage` would carry
 *   the FilterToolbar slot for nothing; through `EntityDetailLayout`
 *   would carry the tab bar.
 *

 * What the shell carries:
 *   - Outer wrapper with `space-y-section animate-dashboard-rise-in`
 *     (the standard dashboard rhythm — vertical sections + 600ms
 *     ease-out rise-in on first paint).
 *   - Header rendered via `<PageHeader>` (same primitive
 *     `EntityListPage` and `EntityDetailLayout` use), so every page
 *     header in the app reads the same.
 *   - Children passthrough for the body content stack.
 *
 * What stays in the page:
 *   - Section composition (3-up KPI grid, side-by-side charts,
 *     trend section, footer card cluster, etc.).
 *   - Data fetching + state.
 *   - Action wiring (the buttons inside the header `actions` slot).
 *
 * Future polish (v2-PR-10 — Hero metric + 4-zone rhythm) will add
 * formal zone slots ("masthead | story | detail | footer") to this
 * shell. The current API is the minimal viable adoption surface.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

import { PageHeader, type PageHeaderProps } from "./PageHeader";

export interface DashboardLayoutProps {
    /**
     * Header configuration delegated to `<PageHeader>`. Same slot
     * shape (breadcrumbs / back / eyebrow / title / description /
     * meta / actions). `title` is the only required field.
     */
    header: PageHeaderProps;
    /** Body content (the dashboard's sections / cards). */
    children: React.ReactNode;
    /** Layout overrides on the outer wrapper. */
    className?: string;
    /** Forwarded to the outer wrapper for E2E selectors. */
    "data-testid"?: string;
}

export function DashboardLayout({
    header,
    children,
    className,
    "data-testid": dataTestId,
}: DashboardLayoutProps) {
    return (
        <div
            // R17-PR12 — swapped `animate-fadeIn` (150ms bare fade)
            // for `animate-dashboard-rise-in` (600ms ease-out + 8px
            // translateY-from-below). The longer duration + small
            // vertical motion reads as "the dashboard composes
            // itself" rather than "the page popped in." Affects
            // all 7 DashboardLayout consumers (executive dashboard,
            // tests / risks / practices / tasks / vendors dashboards,
            // CoverageClient) — one consistent first-paint feel
            // across every dashboard surface.
            className={cn("space-y-section animate-dashboard-rise-in", className)}
            data-dashboard-layout
            data-testid={dataTestId}
        >
            <PageHeader {...header} />
            {children}
        </div>
    );
}
