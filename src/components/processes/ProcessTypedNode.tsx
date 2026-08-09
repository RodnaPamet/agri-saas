"use client";

/**
 * Roadmap-26 PR-B / Roadmap-27 PR-B — ProcessTypedNode.
 *
 * One xyflow custom node component covering all seven taxonomy
 * kinds (see `node-taxonomy.ts`). Per-kind chrome (icon, accent
 * border, shape) is driven by `data.kind`; per-instance footprint
 * is driven by `data.size`.
 *
 * R27-PR-B — the shape vocabulary:
 *   • rect    — process step, practice, risk, external. The
 *               workhorse: a rounded card.
 *   • diamond — decision. A REAL diamond (R25 shipped a fake one —
 *               a small rounded rect). Rendered as a 45°-rotated
 *               square so the border, selected ring and elevation
 *               shadow all rotate WITH it and stay diamond-shaped;
 *               the label sits in a separate upright layer.
 *   • note    — annotation. A flat sticker.
 *
 * Three shapes, seven kinds — the accent + icon do the remaining
 * per-kind work. Three shapes is the curated ceiling: more would
 * make the canvas read like a sticker sheet (see
 * docs/processes-canvas-semantics.md).
 *
 * Size variants (`data.size`: sm | md | lg, default md) scale the
 * footprint so an author can weight a node by importance without a
 * free-form resize handle (which invites ragged, mis-aligned maps).
 */

import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { memo, useCallback, type MouseEvent } from "react";
import { ChevronRight } from "@/components/ui/icons/nucleo/chevron-right";
import { cn } from "@/lib/cn";
import {
    useNodeOverlayStatus,
    overlayClassFor,
} from "@/lib/processes/canvas-execution-overlay";
import {
    NODE_TAXONOMY,
    NODE_ACCENT_BORDER,
    NODE_ACCENT_ICON_TONE,
    isProcessNodeKind,
    type ProcessNodeKind,
} from "./node-taxonomy";
import {
    classifyForEmphasis,
    useCanvasEmphasis,
} from "@/lib/processes/canvas-emphasis-context";

/**
 * PR-B polish — collapsed group geometry. When the user clicks the
 * chevron, the group node shrinks to this footprint and every
 * descendant's `hidden` flag flips on. The expanded width/height
 * live on `data.width` / `data.height` from R30 onwards; the
 * toggle helper reads them back when expanding.
 */
const COLLAPSED_GROUP_W = 220;
const COLLAPSED_GROUP_H = 40;

/** Per-instance footprint. Three discrete steps — not free resize. */
export type ProcessNodeSize = "sm" | "md" | "lg";
export const PROCESS_NODE_SIZES: ProcessNodeSize[] = ["sm", "md", "lg"];
export const DEFAULT_NODE_SIZE: ProcessNodeSize = "md";

export function isProcessNodeSize(value: unknown): value is ProcessNodeSize {
    return value === "sm" || value === "md" || value === "lg";
}

// ─── Per-size geometry ───────────────────────────────────────────────

const RECT_SIZE: Record<ProcessNodeSize, string> = {
    sm: "min-w-[148px] max-w-[230px] px-3 py-1.5",
    md: "min-w-[180px] max-w-[300px] px-3.5 py-2.5",
    lg: "min-w-[224px] max-w-[360px] px-4 py-3.5",
};

const NOTE_SIZE: Record<ProcessNodeSize, string> = {
    sm: "min-w-[140px] max-w-[220px] px-3 py-1.5",
    md: "min-w-[176px] max-w-[300px] px-3.5 py-2.5",
    lg: "min-w-[220px] max-w-[360px] px-4 py-3.5",
};

// R31 — the diamond-size table was retired alongside the
// diamond shape branch. The decision kind now uses the rect
// chassis + a corner sticker.

const ICON_SIZE: Record<ProcessNodeSize, string> = {
    sm: "h-3 w-3",
    md: "h-3.5 w-3.5",
    lg: "h-4 w-4",
};

const LABEL_TEXT: Record<ProcessNodeSize, string> = {
    sm: "text-[11px]",
    md: "text-xs",
    lg: "text-sm",
};

export interface ProcessTypedNodeData {
    /** Visible label (the first line; the bold/emphasis line). */
    label: string;
    /** Optional secondary line — category, owner, severity, etc. */
    subtitle?: string;
    /**
     * The kind drives chrome (icon, accent, shape). Missing /
     * unknown kinds fall back to `processStep`.
     */
    kind?: ProcessNodeKind | string;
    /** Per-instance footprint. Missing / unknown falls back to `md`. */
    size?: ProcessNodeSize | string;
    [key: string]: unknown;
}

// R32-PR11 — handle dots invisible at rest. Pre-R31 every node
// rendered four brand-outlined 8×8px dots at all times; on a
// dense canvas they read as visual noise. The `opacity-0` rest
// state lifts to full opacity only when the parent
// `.react-flow__node` is hovered. The group-hover variant is
// targeted via the chassis's `group` className (added below).
const HANDLE_CLASS =
    "!h-2 !w-2 !border-2 !border-[color:var(--brand-default)] !bg-bg-default !opacity-0 group-hover:!opacity-100 transition-opacity";

// R32-PR11 — selected ring offset. `ring-offset-2 ring-offset-
// canvas-surface` gives the brand ring breathing space against
// the node border (Apple's emphasis pattern). Pre-R32 the ring
// overlapped the border, making the selected state read as a
// thick stroke instead of a deliberate emphasis halo.
const SELECTED_CHROME =
    "border-[color:var(--brand-default)] ring-2 ring-offset-2 ring-offset-canvas-surface ring-[color:var(--brand-default)]/40 bg-bg-elevated";

function ProcessTypedNodeImpl({ id, data, selected }: NodeProps) {
    const nodeData = data as ProcessTypedNodeData;
    const kind: ProcessNodeKind = isProcessNodeKind(nodeData.kind)
        ? nodeData.kind
        : "processStep";
    // VR-6 — Run Mode overlay. The chassis paints live execution state
    // (pulsing ring while RUNNING, success/error ring, dim when SKIPPED). The
    // status is read from the canvas-level overlay context — empty (no
    // overlay) unless a CanvasOverlayProvider is mounted in Run Mode, so the
    // node still renders standalone.
    const ruleId =
        typeof (nodeData as { ruleId?: unknown }).ruleId === "string"
            ? ((nodeData as { ruleId?: string }).ruleId as string)
            : undefined;
    const overlayClass = overlayClassFor(useNodeOverlayStatus(ruleId));
    // PR-B polish — collapsed flag (groups only). The toggle handler
    // mutates this on click via xyflow's `setNodes`. Runtime-only
    // today: reloading the canvas brings groups back expanded (the
    // save serialiser intentionally drops `collapsed` from
    // `dataJson`). A persistent collapse mode is a future
    // follow-up — the trade-off was a single isolated PR rather
    // than a wider data-model migration.
    const collapsed = (nodeData as { collapsed?: boolean }).collapsed === true;
    const { setNodes } = useReactFlow();
    const size: ProcessNodeSize = isProcessNodeSize(nodeData.size)
        ? nodeData.size
        : DEFAULT_NODE_SIZE;
    const meta = NODE_TAXONOMY[kind];
    const Icon = meta.icon;

    const accentBorder = NODE_ACCENT_BORDER[meta.accent];
    const iconTone = NODE_ACCENT_ICON_TONE[meta.accent];
    const label = nodeData.label || meta.defaultLabel;

    // R32-PR5 — emphasis dimming. When the canvas has a selection,
    // every node outside the one-hop neighbourhood drops to ~50%
    // opacity so the eye reads "what's connected to what" at a
    // glance. Nodes inside the neighbourhood render at full
    // opacity (`'emphasised'`); nodes with no active selection
    // render normally (`'normal'`).
    const { emphasisIds } = useCanvasEmphasis();
    const emphasisClass = classifyForEmphasis(id, emphasisIds);
    const emphasisStyle =
        emphasisClass === "dimmed" ? "opacity-50" : "";

    // ── Group (R30) — translucent labelled container ─────────────────
    // The group's wrapper takes its full size from xyflow's `style`
    // (set when the group is created). Children whose `parentId`
    // matches the group's id render INSIDE this wrapper via
    // xyflow's nested-positioning. The dashed border + low-opacity
    // fill keep the group readable as "context container", not as
    // a process step competing for the eye.
    //
    // PR-B polish — chevron toggle in the title sticker collapses
    // the group to a single pill (shrinks the xyflow bbox + hides
    // every descendant). Double-click on the body still drills via
    // the canvas's `onNodeDoubleClick` handler — the chevron is
    // the only collapse affordance to avoid a gesture clash.
    if (meta.category === "group") {
        return (
            <GroupNodeChrome
                id={id}
                label={label}
                subtitle={
                    typeof nodeData.subtitle === "string"
                        ? nodeData.subtitle
                        : undefined
                }
                kind={kind}
                size={size}
                selected={selected ?? false}
                emphasisClass={emphasisClass}
                emphasisStyle={emphasisStyle}
                collapsed={collapsed}
                iconTone={iconTone}
                Icon={Icon}
                setNodes={setNodes}
            />
        );
    }

    // R31 — Diamond shape retired. Decision nodes now render via
    // the rect chassis below; the per-kind signal moves into a
    // corner sticker (computed below as `cornerSticker`) — a
    // quiet, repeatable affordance pattern that scales to any
    // future kind without spawning a new geometry branch.

    // ── Rect + note ──────────────────────────────────────────────────
    const isNote = meta.shape === "note";
    const sizeClasses = isNote ? NOTE_SIZE[size] : RECT_SIZE[size];
    // R32-PR11 — radius unification. Pre-R32 rect nodes used 10px
    // while group containers used 12px and chips/notes 6px — three
    // values for two semantic roles. The verdict's lock: cards
    // (rect chassis) at 8px, chips/notes at 6px. Group containers
    // stay at 12px (one notch larger for the "I hold other things"
    // container reading).
    const radiusClass = isNote ? "rounded-[6px]" : "rounded-[8px]";

    // R26-PR-D / R27 — surface tone varies by semantic category so
    // the eye reads flow vs context vs note at a glance. Solid,
    // elevated cards (not translucent tints): opaque nodes with a
    // soft drop shadow read as deliberate objects floating above the
    // recessed canvas plane.
    //
    //   flow    — brightest fill + lift → "this IS the process"
    //   context — quieter fill + lift  → "this ANNOTATES the flow"
    //   note    — flat sticker tint    → "not part of the graph"
    const surfaceClasses =
        meta.category === "note"
            ? "bg-bg-subtle"
            : meta.category === "context"
              ? "bg-canvas-node-muted shadow-canvas-node"
              : "bg-canvas-node shadow-canvas-node";

    // R31 — per-kind corner sticker. A quiet, repeatable
    // affordance pattern for kinds that need a visual signal
    // beyond the icon alone. Decision gets a "?" (branch hint);
    // external gets "EXT" (outside-the-org hint). The sticker
    // sits in the top-right at `relative inset` so a future kind
    // (e.g. error / locked / awaiting-review) can plug into the
    // same slot without spawning new geometry.
    const cornerSticker: string | null =
        kind === "decision" ? "?" : kind === "external" ? "EXT" : null;

    return (
        <div
            className={cn(
                // R32-PR11 — `group` enables group-hover:* on the
                // handle dots so they appear only when the user
                // hovers this node.
                "group relative border transition-colors",
                sizeClasses,
                radiusClass,
                surfaceClasses,
                overlayClass,
                selected
                    ? SELECTED_CHROME
                    : `${accentBorder} hover:border-border-emphasis`,
                emphasisStyle,
            )}
            data-process-node="true"
            data-process-node-kind={kind}
            data-process-node-size={size}
            data-process-node-emphasis={emphasisClass}
            data-selected={selected ? "true" : "false"}
        >
            {cornerSticker && (
                <span
                    className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full border border-canvas-border bg-canvas-frame px-1 text-[9px] font-semibold uppercase tracking-wide text-content-muted"
                    aria-hidden="true"
                    data-process-node-sticker={kind}
                >
                    {cornerSticker}
                </span>
            )}
            {meta.hasHandles && (
                <Handle
                    type="target"
                    position={Position.Left}
                    className={HANDLE_CLASS}
                />
            )}
            <div className="flex items-center gap-tight">
                <Icon
                    className={cn(ICON_SIZE[size], "flex-shrink-0", iconTone)}
                    aria-hidden="true"
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span
                        className={cn(
                            "truncate tabular-nums",
                            LABEL_TEXT[size],
                            isNote
                                ? "italic text-content-muted"
                                : "font-semibold text-content-emphasis",
                        )}
                    >
                        {label}
                    </span>
                    {nodeData.subtitle && (
                        <span className="truncate text-[10px] uppercase tracking-wide text-content-muted">
                            {nodeData.subtitle}
                        </span>
                    )}
                </div>
            </div>
            {meta.hasHandles && (
                <Handle
                    type="source"
                    position={Position.Right}
                    className={HANDLE_CLASS}
                />
            )}
        </div>
    );
}

/**
 * PR-B polish — Group node chrome (expanded + collapsed variants).
 *
 * Split from the main renderer so the `useCallback` for the
 * chevron handler can capture `id` + `setNodes` without polluting
 * the per-frame closure of every node kind. Children whose
 * `parentId === id` are toggled hidden via `setNodes`; the group's
 * own `style.width/height` flips between `data.width/height` and
 * the COLLAPSED_GROUP_* constants.
 */
function GroupNodeChrome({
    id,
    label,
    subtitle,
    kind,
    size,
    selected,
    emphasisClass,
    emphasisStyle,
    collapsed,
    iconTone,
    Icon,
    setNodes,
}: {
    id: string;
    label: string;
    subtitle?: string;
    kind: ProcessNodeKind;
    size: ProcessNodeSize;
    selected: boolean;
    emphasisClass: ReturnType<typeof classifyForEmphasis>;
    emphasisStyle: string;
    collapsed: boolean;
    iconTone: string;
    Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
    setNodes: ReturnType<typeof useReactFlow>["setNodes"];
}) {
    const toggleCollapsed = useCallback(
        (event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            setNodes((nds) => {
                // Walk parent chains to gather every descendant id.
                // Bounded by the group's children + grandchildren —
                // a linear scan per BFS level is fine at the
                // canvas's bounded sizes (dozens of nodes).
                const descendants = new Set<string>();
                const queue = [id];
                while (queue.length > 0) {
                    const head = queue.shift() as string;
                    for (const n of nds) {
                        const parent = (n as { parentId?: string }).parentId;
                        if (parent === head && !descendants.has(n.id)) {
                            descendants.add(n.id);
                            queue.push(n.id);
                        }
                    }
                }
                const nextCollapsed = !collapsed;
                return nds.map((n) => {
                    if (n.id === id) {
                        const prevData = (n.data ?? {}) as Record<
                            string,
                            unknown
                        >;
                        const expandedW =
                            typeof prevData.width === "number"
                                ? prevData.width
                                : 480;
                        const expandedH =
                            typeof prevData.height === "number"
                                ? prevData.height
                                : 240;
                        return {
                            ...n,
                            data: { ...prevData, collapsed: nextCollapsed },
                            style: {
                                ...(n.style ?? {}),
                                width: nextCollapsed
                                    ? COLLAPSED_GROUP_W
                                    : expandedW,
                                height: nextCollapsed
                                    ? COLLAPSED_GROUP_H
                                    : expandedH,
                            },
                        };
                    }
                    if (descendants.has(n.id)) {
                        return { ...n, hidden: nextCollapsed };
                    }
                    return n;
                });
            });
        },
        [id, collapsed, setNodes],
    );

    // Nucleo ships ChevronRight but not ChevronDown — when the
    // group is expanded the chevron rotates 90° via CSS so it
    // points downward (the canonical "click to collapse" visual).
    const chevronRotation = collapsed ? "" : "rotate-90";
    const chevronLabel = collapsed ? "Expand group" : "Collapse group";

    if (collapsed) {
        // Compact pill — single row with icon + label + chevron.
        // The xyflow node's style is the COLLAPSED_GROUP_* footprint
        // (set by the toggle), so this fills the bbox completely.
        return (
            <div
                className={cn(
                    "flex h-full w-full items-center gap-tight rounded-[10px] border bg-canvas-frame px-default text-[11px] font-semibold text-content-emphasis transition-colors",
                    selected
                        ? "border-[color:var(--brand-default)] bg-bg-elevated"
                        : "border-canvas-border hover:border-border-emphasis",
                    emphasisStyle,
                )}
                data-process-node="true"
                data-process-node-kind={kind}
                data-process-node-size={size}
                data-process-node-emphasis={emphasisClass}
                data-process-node-collapsed="true"
                data-selected={selected ? "true" : "false"}
            >
                <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-label={chevronLabel}
                    title={chevronLabel}
                    data-testid="group-collapse-toggle"
                    className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-content-muted hover:bg-bg-muted hover:text-content-emphasis"
                >
                    <ChevronRight
                        className={cn("h-3.5 w-3.5 transition-transform", chevronRotation)}
                        aria-hidden="true"
                    />
                </button>
                <Icon
                    className={cn("h-3.5 w-3.5 flex-shrink-0", iconTone)}
                    aria-hidden="true"
                />
                <span className="truncate">{label}</span>
                {subtitle && (
                    <span className="ml-auto truncate text-[10px] uppercase tracking-wide text-content-subtle">
                        {subtitle}
                    </span>
                )}
            </div>
        );
    }

    // Expanded — the canonical dashed container.
    return (
        <div
            className={cn(
                "relative h-full w-full rounded-[12px] border-2 border-dashed transition-colors",
                selected
                    ? "border-[color:var(--brand-default)] bg-bg-elevated/40"
                    : "border-border-subtle bg-canvas-node-muted/30 hover:border-border-emphasis",
                emphasisStyle,
            )}
            data-process-node="true"
            data-process-node-kind={kind}
            data-process-node-size={size}
            data-process-node-emphasis={emphasisClass}
            data-process-node-collapsed="false"
            data-selected={selected ? "true" : "false"}
        >
            <div className="absolute left-2 top-2 inline-flex items-center gap-tight rounded-[6px] border border-canvas-border bg-canvas-frame px-2 py-0.5 text-[11px] font-semibold text-content-emphasis">
                <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-label={chevronLabel}
                    title={chevronLabel}
                    data-testid="group-collapse-toggle"
                    className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] text-content-muted hover:bg-bg-muted hover:text-content-emphasis"
                >
                    <ChevronRight
                        className={cn("h-3 w-3 transition-transform", chevronRotation)}
                        aria-hidden="true"
                    />
                </button>
                <Icon
                    className={cn("h-3 w-3", iconTone)}
                    aria-hidden="true"
                />
                <span className="truncate max-w-trunc-default">{label}</span>
            </div>
            {subtitle && (
                <div className="absolute right-2 top-2 truncate text-[10px] uppercase tracking-wide text-content-subtle">
                    {subtitle}
                </div>
            )}
        </div>
    );
}

export const ProcessTypedNode = memo(ProcessTypedNodeImpl);

/**
 * Backwards-compat alias — the R25 ratchet asserts the existence of
 * `<ProcessStepNode>`. The implementation flows through the typed
 * renderer.
 */
export const ProcessStepNode = ProcessTypedNode;

/** Canonical xyflow node-type key for the default kind. */
export const PROCESS_STEP_NODE_TYPE = "processStep";
