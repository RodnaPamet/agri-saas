"use client";

/**
 * R25-PR-D / R27-PR-B — ProcessEdge + PracticeOnEdge overlay.
 *
 * Custom xyflow edge with a token-backed bezier stroke, a three-tier
 * connection LANGUAGE, and an optional edge-mounted Practice overlay.
 *
 * Edge variants (R27-PR-B) — a deliberately minimal hierarchy. One
 * line style per meaning; three is the whole vocabulary:
 *
 *   • flow        — SOLID. Normal sequential process flow. The
 *                   default; the spine of the map.
 *   • conditional — DASHED. An optional / branch path — the
 *                   "sometimes taken" route out of a decision.
 *   • reference   — DOTTED. A non-flow informational dependency —
 *                   a step references an asset or an external
 *                   system. It carries meaning, not sequence.
 *
 * The variant rides on `edge.data.variant`, persists through the
 * `edgeKind` column, and is cycled from the edge's selection
 * affordance. A selected edge keeps its dash signature (only the
 * colour + weight lift) so the variant stays legible while active.
 *
 * The practice-on-edge treatment is the R25 architectural commit:
 * practices are governance objects placed BETWEEN process steps,
 * not separate nodes hanging in space.
 *
 * Data-shape contract:
 *   edge.data.practice:  { label: string } | undefined
 *   edge.data.variant:  'flow' | 'conditional' | 'reference' | undefined
 *   edge.data.isPreview: true while a proximity auto-bind is in flight
 */

import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath,
    useReactFlow,
    type EdgeProps,
} from "@xyflow/react";
import { ShieldCheck, ShieldPlus, Spline } from "lucide-react";
import { memo, useCallback, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { useCanvasEmphasis } from "@/lib/processes/canvas-emphasis-context";

/** The three connection variants. Minimal, meaningful, curated. */
export type ProcessEdgeVariant = "flow" | "conditional" | "reference";

/** Cycle order for the selection affordance. */
export const EDGE_VARIANT_ORDER: ProcessEdgeVariant[] = [
    "flow",
    "conditional",
    "reference",
];

export const EDGE_VARIANT_META: Record<
    ProcessEdgeVariant,
    { label: string; description: string }
> = {
    flow: { label: "Flow", description: "Normal sequential flow" },
    conditional: {
        label: "Conditional",
        description: "Optional / branch path",
    },
    reference: {
        label: "Reference",
        description: "Informational dependency — not sequence",
    },
};

/**
 * Runtime guard — `edgeKind` is a free `String` column, so a
 * rehydrated edge may carry a value we don't recognise. Unknown
 * kinds fall back to `flow` at the render boundary.
 */
export function isProcessEdgeVariant(v: unknown): v is ProcessEdgeVariant {
    return v === "flow" || v === "conditional" || v === "reference";
}

export interface ProcessEdgeData {
    /** Optional practice placed on this connection. */
    practice?: {
        label: string;
    };
    /**
     * R26-PR-C — transient proximity auto-bind preview. Dashed
     * brand stroke; stripped from the edges array on commit.
     */
    isPreview?: boolean;
    /** R27-PR-B — the connection variant. Defaults to `flow`. */
    variant?: ProcessEdgeVariant;
    /** VR-5 — semantic automation edge kind (trigger-flow / condition-pass / …). */
    edgeKind?: string;
    [key: string]: unknown;
}

/**
 * Resolve the SVG stroke style for a (variant, state) pair.
 *
 * Solid / dashed / dotted is the VARIANT's job; colour + weight is
 * the STATE's job. Keeping the dash pattern on the selected state
 * means a highlighted conditional edge still reads as conditional.
 */
function strokeFor(
    variant: ProcessEdgeVariant,
    selected: boolean,
    isPreview: boolean,
): CSSProperties {
    // R32-PR11 — explicit stroke-width hierarchy.
    //   • Preview:  1.5 (dashed, brand-tinted — "in flight")
    //   • Rest:     1.5 (canvas-edge tone)
    //   • Selected: 2.5 (brand tone, ~67% thicker than rest)
    // Pre-R32 the rest/selected gap was 1.75 vs 2.25 — too
    // subtle to read on a dense graph. The new hierarchy is
    // never reversed: rest < preview ≈ rest < selected.
    if (isPreview) {
        return {
            stroke: "var(--brand-default)",
            strokeWidth: 1.5,
            strokeDasharray: "6 4",
        };
    }
    const stroke = selected ? "var(--brand-default)" : "var(--canvas-edge)";
    if (variant === "conditional") {
        return {
            stroke,
            strokeWidth: selected ? 2.5 : 1.5,
            strokeDasharray: "7 5",
        };
    }
    if (variant === "reference") {
        return {
            stroke,
            strokeWidth: selected ? 2.25 : 1.25,
            strokeDasharray: "1 6",
            strokeLinecap: "round",
        };
    }
    // flow — solid.
    return {
        stroke,
        strokeWidth: selected ? 2.5 : 1.5,
    };
}

/**
 * VR-5 — automation edge styling. Each semantic edge kind gets a distinct
 * stroke + label chip so the workflow graph reads without opening any node.
 */
const AUTOMATION_EDGE_STYLE: Record<
    string,
    { stroke: string; dash?: string; label: string }
> = {
    "trigger-flow": { stroke: "var(--brand-default)", label: "" },
    "condition-pass": { stroke: "var(--content-success)", label: "Pass" },
    "condition-fail": { stroke: "var(--content-error)", dash: "6 4", label: "Fail" },
    "chain-delay": { stroke: "var(--canvas-edge)", dash: "2 5", label: "Chain" },
    "sla-breach": { stroke: "var(--content-warning)", label: "SLA breach" },
    "sla-pass": { stroke: "var(--content-success)", label: "On time" },
};

function ProcessEdgeImpl(props: EdgeProps) {
    const {
        id,
        source,
        target,
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        selected,
        data,
        label,
    } = props;
    const t = useTranslations("ui");

    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });

    const edgeData = data as ProcessEdgeData | undefined;
    const practice = edgeData?.practice;
    const isPreview = edgeData?.isPreview === true;
    const variant: ProcessEdgeVariant = isProcessEdgeVariant(edgeData?.variant)
        ? edgeData.variant
        : "flow";
    const { setEdges } = useReactFlow();

    // R25-PR-E — single-click "Add practice" affordance.
    const addPractice = useCallback(() => {
        setEdges((eds) =>
            eds.map((edge) =>
                edge.id === id
                    ? {
                          ...edge,
                          data: {
                              ...(edge.data as ProcessEdgeData | undefined),
                              practice: { label: t("processEdge.practiceDefault") },
                          },
                      }
                    : edge,
            ),
        );
    }, [id, setEdges, t]);

    // R27-PR-B — cycle the connection variant
    // flow → conditional → reference → flow. One affordance, no
    // dialog: visual authoring, consistent with the add-practice UX.
    const cycleVariant = useCallback(() => {
        setEdges((eds) =>
            eds.map((edge) => {
                if (edge.id !== id) return edge;
                const cur = (edge.data as ProcessEdgeData | undefined)?.variant;
                const idx = EDGE_VARIANT_ORDER.indexOf(
                    isProcessEdgeVariant(cur) ? cur : "flow",
                );
                const next =
                    EDGE_VARIANT_ORDER[(idx + 1) % EDGE_VARIANT_ORDER.length];
                return {
                    ...edge,
                    data: {
                        ...(edge.data as ProcessEdgeData | undefined),
                        variant: next,
                    },
                };
            }),
        );
    }, [id, setEdges]);

    // R32-PR5 — emphasis dimming for edges. The edge is in the
    // active neighbourhood iff BOTH endpoints are in the
    // selected node's one-hop set (or it's the selected edge
    // itself, in which case xyflow's own `selected` lifts it).
    // Outside the neighbourhood → drop opacity to ~30% so the
    // dimming reads even on the lightest variant (`reference`
    // is dotted and easily lost).
    const { emphasisIds } = useCanvasEmphasis();
    const edgeDimmed =
        emphasisIds !== null &&
        !selected &&
        (!emphasisIds.has(source) || !emphasisIds.has(target));
    // VR-5 — an automation edge kind overrides the variant styling with its
    // semantic stroke + emits a label chip.
    const autoKind =
        typeof edgeData?.edgeKind === "string" ? edgeData.edgeKind : undefined;
    const autoStyle = autoKind ? AUTOMATION_EDGE_STYLE[autoKind] : undefined;
    const baseStyle: CSSProperties = autoStyle
        ? {
              stroke: autoStyle.stroke,
              strokeWidth: selected ? 2.5 : 1.5,
              ...(autoStyle.dash ? { strokeDasharray: autoStyle.dash } : {}),
          }
        : strokeFor(variant, selected === true, isPreview);
    const edgeStyle: CSSProperties = edgeDimmed
        ? { ...baseStyle, opacity: 0.3 }
        : baseStyle;
    // The automation kind's chip shows when there's no explicit label/practice.
    const autoLabel =
        autoStyle?.label && autoStyle.label.length > 0 && autoKind
            ? t(`processEdge.autoLabel.${autoKind}`)
            : null;

    return (
        <>
            <BaseEdge
                id={id}
                path={edgePath}
                // Token-backed stroke — quiet `--canvas-edge` at rest,
                // brand-lifted on selection / preview. Solid / dashed
                // / dotted is the variant's signature. R32-PR5
                // composes the emphasis-dim opacity on top.
                style={edgeStyle}
            />
            {practice && (
                // EdgeLabelRenderer pulls the overlay OUT of the SVG
                // so React components render natively at the midpoint.
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: "absolute",
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: "all",
                        }}
                        className="nodrag nopan"
                        data-practice-on-edge="true"
                    >
                        <PracticeOnEdge label={practice.label} />
                    </div>
                </EdgeLabelRenderer>
            )}
            {!practice && typeof label === "string" && label.length > 0 && (
                // R31 Bundle 7 (PR 5 minimum viable) — chip-styled
                // edge label. Pre-R31, the inspector's edge-label
                // edit set `edge.label` but xyflow's default text
                // render for bezier edges renders nothing without
                // a custom mount. This pulls a token-driven chip
                // at the midpoint so labels stay readable when
                // edges overlap (raw text on a dense graph is
                // unreadable). If a practice already occupies the
                // midpoint, the label suppresses — the practice is
                // the more semantic anchor.
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: "absolute",
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: "all",
                        }}
                        className="nodrag nopan"
                        data-edge-label-chip="true"
                    >
                        <span className="inline-flex items-center rounded-[4px] border border-canvas-border bg-canvas-frame px-1.5 py-0.5 text-[10px] text-content-muted">
                            {label}
                        </span>
                    </div>
                </EdgeLabelRenderer>
            )}
            {!practice &&
                !(typeof label === "string" && label.length > 0) &&
                autoLabel && (
                    // VR-5 — semantic automation edge-kind chip.
                    <EdgeLabelRenderer>
                        <div
                            style={{
                                position: "absolute",
                                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                                pointerEvents: "all",
                            }}
                            className="nodrag nopan"
                            data-edge-kind-chip={autoKind}
                        >
                            <span className="inline-flex items-center rounded-[4px] border border-canvas-border bg-canvas-frame px-1.5 py-0.5 text-[10px] text-content-muted">
                                {autoLabel}
                            </span>
                        </div>
                    </EdgeLabelRenderer>
                )}
            {selected && (
                // R27-PR-B — selection affordances. Sits just above
                // the midpoint when a practice badge occupies it, so
                // the two never collide. The variant cycle is always
                // offered; "Add practice" only when none exists yet.
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: "absolute",
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - (practice ? 28 : 0)}px)`,
                            pointerEvents: "all",
                        }}
                        className="nodrag nopan flex items-center gap-1"
                        data-edge-affordances="true"
                    >
                        <button
                            type="button"
                            onClick={cycleVariant}
                            title={t("processEdge.variantChangeTitle", {
                                description: t(`processEdge.variantDescription.${variant}`),
                            })}
                            className="inline-flex items-center gap-1 rounded-[8px] border border-canvas-border bg-canvas-frame px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-default transition-colors hover:border-border-emphasis hover:text-content-emphasis"
                            data-edge-variant-affordance="true"
                        >
                            <Spline
                                className="h-3 w-3 shrink-0 text-[color:var(--brand-default)]"
                                aria-hidden="true"
                            />
                            <span>{t(`processEdge.variantLabel.${variant}`)}</span>
                        </button>
                        {!practice && selected && (
                            <button
                                type="button"
                                onClick={addPractice}
                                className="inline-flex items-center gap-1 rounded-[8px] border border-border-emphasis bg-canvas-frame px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-emphasis transition-colors hover:bg-bg-muted"
                                data-add-practice-affordance="true"
                            >
                                <ShieldPlus
                                    className="h-3 w-3 shrink-0 text-[color:var(--brand-default)]"
                                    aria-hidden="true"
                                />
                                <span>{t("processEdge.addPractice")}</span>
                            </button>
                        )}
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    );
}

export const ProcessEdge = memo(ProcessEdgeImpl);

/**
 * Canonical xyflow edge-type key.
 */
export const PROCESS_EDGE_TYPE = "processEdge";

/**
 * R25-PR-D — PracticeOnEdge.
 *
 * Visual representation of a practice inserted into a process
 * connection. Deliberately distinct from a process node: a small
 * pill, shield-check icon, no handles, elevated tint — it reads as
 * "a practice ON this connection", not another step.
 */
interface PracticeOnEdgeProps {
    label: string;
}

export function PracticeOnEdge({ label }: PracticeOnEdgeProps) {
    // R32-PR12 — chip vocabulary match. Pre-R32 the practice pill
    // had a larger radius than the edge-label chip shipped in
    // R31 Bundle 7. Two pills on the same edge with two
    // different radii — every edge-mounted artefact now reads as
    // one consistent shape language. Same bg-canvas-frame as the
    // label chip; the brand-coloured icon is what distinguishes
    // the practice affordance.
    return (
        <div
            className="inline-flex items-center gap-1 rounded-[4px] border border-canvas-border bg-canvas-frame px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-emphasis"
            data-practice-on-edge-badge="true"
        >
            <ShieldCheck className="h-3 w-3 shrink-0 text-[color:var(--brand-default)]" />
            <span className="max-w-trunc-tight truncate">{label}</span>
        </div>
    );
}
