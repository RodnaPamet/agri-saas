/**
 * R25-PR-A — WorkspaceShell.
 *
 * Canvas-centric page shell. Sibling of `<ListPageShell>` and
 * `<EntityDetailLayout>`; differs because canvas pages want the
 * surface to dominate the viewport (Alteryx layout language):
 *
 *   ┌─────────────────────────────────────────┐
 *   │  Toolbar (minimal, slim)                │  flex-shrink-0
 *   ├─────────────────────────────────────────┤
 *   │                                         │
 *   │             Canvas body                 │  flex-1 min-h-0
 *   │                                         │
 *   │                                         │
 *   └─────────────────────────────────────────┘
 *
 * Differences from `<ListPageShell>`:
 *   • No filter toolbar slot — canvas pages don't filter rows.
 *   • No table-internal scroll — canvas pages own pan/zoom inside
 *     the body.
 *   • The toolbar is OPTIONAL — pages that want an immersive
 *     canvas with just the global chrome can omit it.
 *   • The body is `overflow-hidden` because the canvas (xyflow,
 *     d3, etc.) handles its own pan/scroll.
 *
 * Same mobile fallback as `<ListPageShell>`: below `md` the shell
 * is a no-op vertical flex so touch scrolling behaves normally.
 *
 * Use this shell for: process canvases, dashboards-as-canvas,
 * org charts, any page where a single interactive surface is the
 * primary content and standard list chrome would compromise it.
 *
 * Do NOT use this shell for: list pages (use `<ListPageShell>`),
 * detail pages (use `<EntityDetailLayout>`), forms.
 */
"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface WorkspaceShellProps {
    children: ReactNode;
    className?: string;
}

function WorkspaceShellRoot({ children, className }: WorkspaceShellProps) {
    return (
        <div
            className={cn(
                // Mobile: natural document flow.
                // Desktop: flex column filling parent.
                "flex flex-col gap-default",
                "md:flex-1 md:min-h-0",
                className,
            )}
            data-workspace-shell="true"
        >
            {children}
        </div>
    );
}

function WorkspaceShellHeader({ children, className }: WorkspaceShellProps) {
    // Page-title + description strip. Identical role to
    // <ListPageShell.Header>, kept separate so future workspace-
    // specific header chrome (e.g. canvas mode toggles) can land
    // here without touching list pages.
    return (
        <header className={cn("flex-shrink-0", className)}>
            {children}
        </header>
    );
}

function WorkspaceShellToolbar({ children, className }: WorkspaceShellProps) {
    // The slim top toolbar — palette, view switches, canvas-level
    // actions. Disciplined by intent: this slot should never grow
    // into a filter toolbar. Pages that overload it with too many
    // practices have lost the canvas-centric framing.
    return (
        <div
            className={cn("flex-shrink-0", className)}
            data-workspace-toolbar="true"
        >
            {children}
        </div>
    );
}

function WorkspaceShellBody({ children, className }: WorkspaceShellProps) {
    // The dominant canvas surface. Fills remaining vertical space
    // on desktop. `overflow-hidden` because the canvas library
    // (xyflow / d3 / etc.) owns pan/scroll inside.
    return (
        <div
            className={cn(
                "md:flex-1 md:min-h-0 md:flex md:flex-col md:overflow-hidden",
                "min-h-[60vh] md:min-h-0",
                className,
            )}
            data-workspace-body="true"
        >
            {children}
        </div>
    );
}

export const WorkspaceShell = Object.assign(WorkspaceShellRoot, {
    Header: WorkspaceShellHeader,
    Toolbar: WorkspaceShellToolbar,
    Body: WorkspaceShellBody,
});
