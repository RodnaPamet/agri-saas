"use client";

/**
 * Processes page client shell.
 *
 * R25 mounted the canvas with zero persistence. R26-PR-A adds:
 *   - the existing process list, selectable from a slim header
 *     practice
 *   - a "New process" affordance that POSTs to the create endpoint
 *   - a "Save" button that PUTs the canvas state back to the
 *     selected map's endpoint
 *   - rehydration: selecting a map loads its graph from the server
 *     and seeds the canvas as `initialNodes` + `initialEdges`
 *
 * The richer editor UX (visible name, save-as, inspector, alignment
 * helpers, undo-redo) lands in R26-PR-E; PR-A is the minimum
 * needed to prove the persistence loop end-to-end.
 *
 * Component split:
 *   - `<ProcessesClient>` (this file) owns the page chrome +
 *     selection state. It does NOT own canvas state; the canvas
 *     does (xyflow's internal nodes/edges, plus a wrapper that
 *     exposes a save callback).
 *   - `<PersistedProcessCanvas>` (sibling component) wraps the
 *     R25 `<ProcessCanvas>` and adds the save/rehydrate plumbing.
 *     Splitting keeps the page chrome simple and lets the canvas
 *     own its xyflow state without prop-drilling.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { cn } from "@/lib/cn";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { RulesTab } from "./RulesTab";
import { AnalyticsTab } from "./AnalyticsTab";
import { MonitorTab } from "./MonitorTab";
import type { ProcessMapSummary } from "@/components/processes/types";
import { CanvasModeProvider } from "@/lib/processes/canvas-mode-context";
// R31 Bundle 3 — page-level Heading + PageBreadcrumbs retired. The
// document bar inside the canvas now carries the breadcrumbs +
// document title inline (Figma-style).

// xyflow uses browser-only APIs on mount (ResizeObserver,
// getBoundingClientRect). The `ssr:false` boundary lives at this
// import — the wrapper itself is a "use client" component, but
// "use client" still runs through SSR for the initial paint.
// Dynamic-import with ssr:false keeps the canvas off the server
// pipeline entirely. Same pattern R25 established via the
// `<ProcessCanvas>` import that this replaces.
const PersistedProcessCanvas = dynamic(
    () =>
        import("@/components/processes/PersistedProcessCanvas").then(
            (m) => m.PersistedProcessCanvas,
        ),
    { ssr: false },
);


export type { ProcessMapSummary } from "@/components/processes/types";

interface ProcessesClientProps {
    tenantSlug: string;
    initialProcesses: ProcessMapSummary[];
}

export function ProcessesClient({
    tenantSlug,
    initialProcesses,
}: ProcessesClientProps) {
    const t = useTranslations('processes');
    // The full list is owned here so a save can refresh the
    // selected map's metadata (version, updatedAt) without a full
    // page reload. Selection itself drives the canvas's load
    // sequence via its `processMapId` prop.
    const [processes, setProcesses] = useState<ProcessMapSummary[]>(
        initialProcesses,
    );
    const [activeId, setActiveId] = useState<string | null>(
        initialProcesses[0]?.id ?? null,
    );

    // Automation Epic 1 — the Process page gains a tab bar. "Canvas" is
    // the existing process-map editor; "Rules" is the automation-rule
    // inventory. The tab bar uses the canonical EntityDetailLayout pattern
    // (border-b accent + emphasis text) — the single-tab-pattern ratchet
    // reserves the pill primitive out of app pages. Epic 9 extends this
    // with Analytics; Epic 10 adds Monitor.
    const [tab, setTab] = useState<"canvas" | "rules" | "analytics" | "monitor">("canvas");
    const TABS: ReadonlyArray<{
        key: "canvas" | "rules" | "analytics" | "monitor";
        label: string;
    }> = [
        { key: "canvas", label: t('tabCanvas') },
        { key: "rules", label: t('tabRules') },
        { key: "analytics", label: t('tabAnalytics') },
        { key: "monitor", label: t('tabMonitor') },
    ];

    return (
        <div className="flex h-full min-h-0 flex-col">
            <nav
                className="flex gap-1 border-b border-border-default overflow-x-auto"
                role="tablist"
                aria-label={t('sectionsAria')}
            >
                {TABS.map((t) => {
                    const isActive = tab === t.key;
                    return (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={cn(
                                "px-5 py-2.5 text-base font-medium transition border-b-2 whitespace-nowrap",
                                isActive
                                    ? "border-[var(--brand-default)] text-content-emphasis"
                                    : "border-transparent text-content-muted hover:text-content-emphasis",
                            )}
                            onClick={() => setTab(t.key)}
                            id={`processes-tab-${t.key}`}
                            data-testid={`processes-tab-${t.key}`}
                        >
                            {t.label}
                        </button>
                    );
                })}
                {/* PR-B follow-up — cross-map governance meta-graph. */}
                <a
                    href={`/t/${tenantSlug}/processes/governance`}
                    className="ml-auto self-center px-5 py-2.5 text-base font-medium text-content-muted hover:text-content-emphasis whitespace-nowrap"
                    data-testid="governance-graph-link"
                >
                    {t('governanceLink')}
                </a>
            </nav>
            <div className="min-h-0 flex-1 pt-3">
                {tab === "rules" ? (
                    <RulesTab tenantSlug={tenantSlug} />
                ) : tab === "analytics" ? (
                    <AnalyticsTab />
                ) : tab === "monitor" ? (
                    <MonitorTab />
                ) : (
                    <CanvasWorkspace
                        tenantSlug={tenantSlug}
                        processes={processes}
                        activeId={activeId}
                        setActiveId={setActiveId}
                        setProcesses={setProcesses}
                    />
                )}
            </div>
        </div>
    );
}

function CanvasWorkspace({
    tenantSlug,
    processes,
    activeId,
    setActiveId,
    setProcesses,
}: {
    tenantSlug: string;
    processes: ProcessMapSummary[];
    activeId: string | null;
    setActiveId: (id: string | null) => void;
    setProcesses: (p: ProcessMapSummary[]) => void;
}) {
    return (
        // R31 Bundle 3 (PR 1) — Page header retired. Pre-R31 the
        // page above the canvas carried a CRUD-page header
        // (breadcrumbs + a level-1 page title + a description
        // sentence) — three bands of chrome before the working
        // surface. A canvas tool announces itself THROUGH the
        // canvas itself; the document bar inside
        // PersistedProcessCanvas now carries the breadcrumbs +
        // document title inline, Figma-style. The header slot
        // stays available for future canvas-mode chrome (Design /
        // Run mode toggle, etc.) but is intentionally empty today.
        <WorkspaceShell className="animate-fadeIn">
            {/* The workspace frame — an elevated panel that contains
                the chrome (toolbar + palette) and the recessed canvas
                plane. It reads as raised purely through tone — the
                frame surface sits a step lighter than the page behind
                it (depth via background tone, not box-shadow, per the
                Card-primitive discipline). `overflow-hidden` clips
                every inner strip to the frame's rounded corners so the
                composition reads as one deliberate container. */}
            <WorkspaceShell.Body className="overflow-hidden rounded-lg border border-canvas-border bg-canvas-frame">
                <CanvasModeProvider
                    mode={
                        processes.find((p) => p.id === activeId)?.canvasMode ?? "DOCUMENT"
                    }
                >
                    <PersistedProcessCanvas
                        tenantSlug={tenantSlug}
                        processes={processes}
                        activeId={activeId}
                        onActiveIdChange={setActiveId}
                        onProcessesChange={setProcesses}
                    />
                </CanvasModeProvider>
            </WorkspaceShell.Body>
        </WorkspaceShell>
    );
}
