"use client";

/**
 * R26-PR-E / R28 — ProcessInspector.
 *
 * Right-side property panel for the selected canvas element.
 * Originally NODE-only (R26-PR-E); R28 extends to EDGES — selecting
 * a connection now opens the same panel with edge-specific fields
 * (label override + the variant cycle: flow / conditional / reference).
 *
 * Why a panel and not an inline popover:
 *   • Inline popovers compete with the canvas surface for focus;
 *     the user's eye has to alternate between "where the node
 *     lives" and "where the popover is". A persistent right
 *     panel anchors the edit affordance in one stable place.
 *   • Multiple edits (e.g. label THEN subtitle) need a
 *     persistent affordance, not a popover that closes on every
 *     blur.
 *
 * Why it's COLLAPSIBLE:
 *   • Authors who already know what they're building shouldn't
 *     have to look at a panel of empty fields. The panel mounts
 *     only when something is selected; selecting nothing
 *     hides it.
 *
 * Empty-state messaging:
 *   • When something IS selected but the kind doesn't carry
 *     editable fields (decision: just a label; annotation: just
 *     text), the panel still mounts so the user sees a
 *     consistent affordance — never a partial-mount that reads
 *     as "is anything happening?"
 */

import { useEffect, useMemo, useState } from "react";
import { Input } from '@/components/ui/input';
import { useTranslations } from "next-intl";
import type { Edge, Node } from "@xyflow/react";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { AsidePanel } from "@/components/ui/aside-panel";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import {
    findTenantAsset,
    formatAssetLabel,
    useTenantAssets,
} from "@/lib/processes/use-tenant-assets";

/**
 * PR-D polish — refresh cadence for linked-entity status. 30s
 * balances "live enough that an admin changing a practice's status
 * in another tab reflects on the canvas" against API hammering.
 */
const ENTITY_STATUS_POLL_MS = 30_000;

/**
 * PR-D polish — map a linked-entity `status` value to a tone class
 * for the chip. The chip is informational, not interactive — the
 * tones lean on the existing semantic-bg-* token suite.
 *
 * Unknown / missing statuses get the neutral `subtle` tone (no
 * special colour) — never blank, never wrong.
 */
function entityStatusTone(status: string | null | undefined): string {
    if (!status) return "bg-bg-subtle text-content-muted";
    const s = status.toUpperCase();
    if (s === "DONE" || s === "MITIGATED" || s === "ACTIVE") {
        return "bg-bg-success/40 text-content-success";
    }
    if (s === "IN_PROGRESS" || s === "OPEN") {
        return "bg-bg-info/40 text-content-info";
    }
    if (s === "BLOCKED" || s === "REJECTED" || s === "DECOMMISSIONED") {
        return "bg-bg-error/40 text-content-error";
    }
    return "bg-bg-subtle text-content-muted";
}
import {
    NODE_TAXONOMY,
    isProcessNodeKind,
    isAutomationNodeKind,
} from "./node-taxonomy";
import { useIsAutomationMode } from "@/lib/processes/canvas-mode-context";
import { AutomationInspectorPanel } from "./AutomationInspectorPanel";
import {
    DEFAULT_NODE_SIZE,
    isProcessNodeSize,
    type ProcessNodeSize,
} from "./ProcessTypedNode";
import {
    EDGE_VARIANT_ORDER,
    isProcessEdgeVariant,
    type ProcessEdgeVariant,
} from "./ProcessEdge";

/**
 * Epic P2-PR-A — shape of an edge-attached practice reference.
 * One per edge today (the inspector picks ONE); the underlying
 * `ProcessEdgePractice` table supports multiple per edge for future
 * "two practices gate this edge" use cases.
 */
export interface EdgePracticeRef {
    /** Stable per-edge identifier — survives saves + reloads. */
    practiceKey: string;
    /** Human label rendered on the in-canvas pill. */
    label: string;
}

export interface ProcessInspectorProps {
    /** Selected node, or null when nothing is selected. */
    node: Node | null;
    /**
     * R28 — selected edge, or null when nothing is selected. Mutually
     * exclusive with `node` in practice (xyflow lets you multi-select
     * a node + an edge but the canvas only mirrors one slot at a
     * time — node wins if both are set).
     */
    edge?: Edge | null;
    /**
     * Tenant slug — Epic P2-PR-A — used by the edge inspector to
     * fetch the tenant's Practices list for the picker. Optional:
     * the node-mode panel doesn't need it, and absence in edge mode
     * gracefully hides the picker (rendered tests + storybook
     * stages without the canvas surrounding context keep working).
     */
    tenantSlug?: string;
    /**
     * Called when the user commits a label / subtitle / size /
     * entity-link change. The canvas writes the change back into
     * its nodes state.
     *
     * Epic P2-PR-B — `linkedEntityId` carries the FK to whichever
     * entity matches the node's kind (practice / asset). The
     * picker is conditional on `data.kind`, so a single shared field
     * suffices — kind disambiguates on read.
     */
    onUpdate: (
        nodeId: string,
        patch: {
            label?: string;
            subtitle?: string | null;
            size?: ProcessNodeSize;
            linkedEntityId?: string | null;
        },
    ) => void;
    /**
     * R28 + Epic P2-PR-A — commit an edge edit. The canvas applies
     * the patch to the edge's `label` (top-level on xyflow) +
     * `data.variant` + `data.practices` (P2-PR-A — linked tenant
     * Practice).
     */
    onEdgeUpdate?: (
        edgeId: string,
        patch: {
            label?: string | null;
            variant?: ProcessEdgeVariant;
            practices?: EdgePracticeRef[];
        },
    ) => void;
}

export function ProcessInspector({
    node,
    edge = null,
    tenantSlug,
    onUpdate,
    onEdgeUpdate,
}: ProcessInspectorProps) {
    const t = useTranslations("ui");
    // Local state mirrors the node's data so the user can type
    // without every keystroke flushing to the canvas state. The
    // mirror commits on blur (or Enter), which is when the canvas
    // actually receives the patch.
    const data = node?.data as
        | {
              label?: string;
              subtitle?: string;
              kind?: unknown;
              size?: unknown;
              linkedEntityId?: unknown;
          }
        | undefined;
    const [label, setLabel] = useState(data?.label ?? "");
    const [subtitle, setSubtitle] = useState(data?.subtitle ?? "");
    // VR-4 — automation-mode inspector branch (hook stays unconditional).
    const isAutomation = useIsAutomationMode();

    // Sync local mirror when the selected node changes.
    useEffect(() => {
        setLabel(data?.label ?? "");
        setSubtitle(data?.subtitle ?? "");
    }, [node?.id, data?.label, data?.subtitle]);

    // R28 — edge-selection mode. Node wins if both are set; the
    // canvas only mirrors one slot at a time but the guard here
    // keeps the rendering deterministic regardless of order.
    if (!node && edge) {
        return (
            <EdgeInspectorBody
                edge={edge}
                tenantSlug={tenantSlug}
                onEdgeUpdate={onEdgeUpdate}
            />
        );
    }

    if (!node) {
        return null;
    }

    // VR-4 — when an automation node is selected on an AUTOMATION canvas, the
    // inspector renders the inline rule editor instead of the document panels.
    if (isAutomation && isAutomationNodeKind(data?.kind)) {
        const ruleId =
            data && typeof (data as { ruleId?: unknown }).ruleId === "string"
                ? ((data as { ruleId?: string }).ruleId as string)
                : null;
        return (
            <AsidePanel title={t("ruleDetail.rule")} surfaceKey="processes-inspector">
                <div className="flex flex-col gap-default p-default">
                    <AutomationInspectorPanel
                        kind={data!.kind as "trigger" | "condition" | "action" | "slaGate"}
                        ruleId={ruleId}
                    />
                </div>
            </AsidePanel>
        );
    }

    const kindMeta = isProcessNodeKind(data?.kind)
        ? NODE_TAXONOMY[data.kind]
        : null;

    const size: ProcessNodeSize = isProcessNodeSize(data?.size)
        ? data.size
        : DEFAULT_NODE_SIZE;

    const commit = () => {
        const trimmedLabel = label.trim();
        const trimmedSubtitle = subtitle.trim();
        onUpdate(node.id, {
            label: trimmedLabel,
            subtitle: trimmedSubtitle === "" ? null : trimmedSubtitle,
        });
    };

    // R31 Bundle 5 (PR 6) — Inspector chrome now flows through the
    // canonical `<AsidePanel>` primitive (Practices parity).
    // The pre-R31 bespoke 260px `<aside>` is gone; the new shell
    // gives the inspector collapse-to-spine, resize, deep-link
    // (`?aside=processes-inspector`), and a `<Sheet>` fallback
    // below xl for free. The inner body retains every existing
    // testid the R28 ratchet pins; only the chrome moved.
    return (
        <AsidePanel
            title={t("processInspector.inspector")}
            surfaceKey="processes-inspector"
        >
            <div
                className="flex flex-col gap-default"
                data-process-inspector="true"
                aria-label={t("processInspector.selectedNodeProps")}
            >
                {kindMeta && (
                    <span className="text-[10px] uppercase tracking-wide text-content-subtle">
                        {kindMeta.label}
                    </span>
                )}
                <label className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("processInspector.label")}
                </span>
                <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-xs text-content-emphasis focus:border-border-emphasis focus:outline-none"
                    data-testid="inspector-label-input"
                />
            </label>
            <label className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("processInspector.subtitle")}
                </span>
                <input
                    type="text"
                    value={subtitle}
                    onChange={(e) => setSubtitle(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    placeholder={t("processInspector.optional")}
                    className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-xs text-content-emphasis focus:border-border-emphasis focus:outline-none"
                    data-testid="inspector-subtitle-input"
                />
            </label>
            <div className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("processInspector.size")}
                </span>
                <ToggleGroup
                    size="sm"
                    ariaLabel={t("processInspector.nodeSize")}
                    selected={size}
                    options={[
                        { value: "sm", label: t("processInspector.sizeS") },
                        { value: "md", label: t("processInspector.sizeM") },
                        { value: "lg", label: t("processInspector.sizeL") },
                    ]}
                    selectAction={(v) =>
                        onUpdate(node.id, { size: v as ProcessNodeSize })
                    }
                />
            </div>
            {/* Epic P2-PR-B — Linked-entity picker. Mounts only on
                nodes whose kind matches a compliance entity (practice
                / asset). The selection writes the FK into
                `data.linkedEntityId`; the canvas's `nodeDataJson`
                serialiser persists it via the existing `dataJson`
                column — no schema change needed. */}
            <NodeLinkedEntityPicker
                nodeKind={data?.kind}
                tenantSlug={tenantSlug}
                selectedId={
                    typeof data?.linkedEntityId === "string"
                        ? data.linkedEntityId
                        : null
                }
                onCommit={(linkedEntityId) =>
                    onUpdate(node.id, { linkedEntityId })
                }
            />
                <p className="text-[10px] text-content-subtle">
                    {t("processInspector.saveHint")}
                </p>
            </div>
        </AsidePanel>
    );
}

// ─── Epic P2-PR-B — Linked-entity picker (practice / asset) ──

function NodeLinkedEntityPicker({
    nodeKind,
    tenantSlug,
    selectedId,
    onCommit,
}: {
    nodeKind: unknown;
    tenantSlug?: string;
    selectedId: string | null;
    onCommit: (id: string | null) => void;
}) {
    const t = useTranslations("ui");
    // Three hooks unconditionally — React rules of hooks. Each
    // short-circuits to a no-op when the slug is the empty string,
    // and we discard the unused responses below.
    //
    // PR-D polish — periodic revalidation so a status change made
    // elsewhere reflects on the canvas without a reload. The cache
    // is shared module-scoped, so the 30s poll runs once per
    // tenant even with three concurrent hook mounts.
    const slug = tenantSlug ?? "";
    const assets = useTenantAssets(slug, { pollMs: ENTITY_STATUS_POLL_MS });

    // ASSET only. There was a `practice` branch here, fed by
    // `useTenantPractices` → `GET /api/t/:slug/practices` — a route GRC
    // teardown phase 3 deleted with the Practice model. The hook's cache
    // only populates on success, so it re-fetched on every mount and its
    // 30s poll re-404'd indefinitely, swallowed by an early return; and
    // because the hook call sat ABOVE this guard it fired on ANY node
    // selection, not just practice nodes.
    //
    // The node kind itself survives — node-taxonomy marks it "legacy
    // maps", with edge-mounted practices as the canonical form — so an
    // old map still renders its practice nodes. What it no longer offers
    // is a picker over rows that do not exist.
    if (nodeKind !== "asset") {
        return null;
    }

    const active = {
        label: t("processInspector.linkedAsset"),
        options: assets.options.map((a) => ({
            value: a.id,
            label: formatAssetLabel(a),
        })),
        loading: assets.loading,
        emptyHint: t("processInspector.noAssets"),
    };

    const selectedOption = selectedId
        ? active.options.find((o) => o.value === selectedId) ?? null
        : null;

    // PR-D polish — live status chip for the currently-selected
    // entity. Reads from the same hook state the picker reads;
    // the 30s polling cadence above keeps the value live.
    const liveStatus = findTenantAsset(assets, selectedId)?.status ?? null;

    return (
        <div
            className="flex flex-col gap-tight"
            data-testid="inspector-node-entity-picker"
            data-entity-kind={nodeKind}
        >
            <div className="flex items-center justify-between gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {active.label}
                </span>
                {liveStatus && (
                    <span
                        className={`rounded-[4px] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${entityStatusTone(liveStatus)}`}
                        data-testid="inspector-node-entity-status"
                        data-status={liveStatus}
                        title={t("processInspector.statusTitle", { status: liveStatus })}
                    >
                        {liveStatus}
                    </span>
                )}
            </div>
            <Combobox
                selected={selectedOption}
                setSelected={(option) =>
                    onCommit(option?.value ?? null)
                }
                options={active.options}
                disabled={active.loading || active.options.length === 0}
                aria-label={active.label}
                placeholder={
                    active.loading
                        ? t("processInspector.loading")
                        : active.options.length === 0
                          ? active.emptyHint
                          : t("processInspector.pickOne")
                }
            />
        </div>
    );
}

// ─── R28 + Epic P2-PR-A — Edge inspector body ──────────────────────

function EdgeInspectorBody({
    edge,
    tenantSlug,
    onEdgeUpdate,
}: {
    edge: Edge;
    tenantSlug?: string;
    onEdgeUpdate?: ProcessInspectorProps["onEdgeUpdate"];
}) {
    const t = useTranslations("ui");
    const variantRaw = (edge.data as { variant?: unknown } | undefined)
        ?.variant;
    const variant: ProcessEdgeVariant = isProcessEdgeVariant(variantRaw)
        ? variantRaw
        : "flow";
    const initialLabel =
        typeof edge.label === "string" ? edge.label : "";
    const [label, setLabel] = useState(initialLabel);

    useEffect(() => {
        setLabel(typeof edge.label === "string" ? edge.label : "");
    }, [edge.id, edge.label]);

    // Epic P2-PR-A — practices attached to this edge. PR-A allows
    // ONE per edge in the inspector; the underlying ProcessEdgePractice
    // table supports many for future "two practices gate this edge"
    // shapes.
    const existingPractices = readEdgePractices(edge);
    const selectedPractice = existingPractices[0] ?? null;
    // Passing the empty string short-circuits the hook to a no-op
    // ({ options: [], loading: false }); the picker block below
    // also gates on `tenantSlug` so absence cleanly hides the
    // affordance.
    // A free-text label, not a picker.
    //
    // This was a Combobox over the tenant's Practice rows. GRC teardown
    // phase 3 dropped both the Practice model and
    // `ProcessEdgePractice.practiceId`, so there is no row to select and
    // nowhere to store a selection — the dropdown could only ever have
    // rendered empty, and the id it wrote was stripped by
    // `ProcessEdgeInputSchema` before it reached Prisma.
    //
    // What survives is what the table now holds: `practiceKey` (a
    // client-stable id) plus a human `label`. So the affordance becomes
    // what the data actually supports — the user types the practice this
    // edge is gated by.
    const [practiceLabel, setPracticeLabel] = useState(
        selectedPractice?.label ?? "",
    );
    useEffect(() => {
        setPracticeLabel(selectedPractice?.label ?? "");
    }, [edge.id, selectedPractice?.label]);

    const commitLinkedPractice = () => {
        if (!onEdgeUpdate) return;
        const trimmed = practiceLabel.trim();
        if (trimmed === "") {
            // Cleared: drop every practice attached to this edge.
            onEdgeUpdate(edge.id, { practices: [] });
            return;
        }
        const next: EdgePracticeRef = {
            practiceKey:
                selectedPractice?.practiceKey ??
                `prac-${edge.id}-${Date.now().toString(36)}`,
            label: trimmed,
        };
        onEdgeUpdate(edge.id, { practices: [next] });
    };

    const commit = () => {
        if (!onEdgeUpdate) return;
        const trimmed = label.trim();
        onEdgeUpdate(edge.id, { label: trimmed === "" ? null : trimmed });
    };

    // R31 Bundle 5 (PR 6) — edge inspector chrome moves to AsidePanel
    // parity, same as the node inspector above. Same surfaceKey so
    // a user toggling between node + edge selection sees a single
    // inspector panel persist its collapse state across both modes.
    return (
        <AsidePanel
            title={t("processInspector.inspector")}
            surfaceKey="processes-inspector"
        >
            <div
                className="flex flex-col gap-default"
                data-process-inspector="true"
                data-inspector-mode="edge"
                aria-label={t("processInspector.selectedEdgeProps")}
            >
                <span className="text-[10px] uppercase tracking-wide text-content-subtle">
                    {t("processInspector.connection")}
                </span>
                <label className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("processInspector.label")}
                </span>
                <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    placeholder={t("processInspector.optional")}
                    className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-xs text-content-emphasis focus:border-border-emphasis focus:outline-none"
                    data-testid="inspector-edge-label-input"
                />
            </label>
            <div className="flex flex-col gap-tight">
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("processInspector.variant")}
                </span>
                <ToggleGroup
                    size="sm"
                    ariaLabel={t("processInspector.edgeVariant")}
                    selected={variant}
                    options={EDGE_VARIANT_ORDER.map((v) => ({
                        value: v,
                        label: t(`processEdge.variantLabel.${v}`),
                    }))}
                    selectAction={(v) =>
                        onEdgeUpdate?.(edge.id, {
                            variant: v as ProcessEdgeVariant,
                        })
                    }
                />
                <span className="text-[10px] text-content-subtle">
                    {t(`processEdge.variantDescription.${variant}`)}
                </span>
            </div>
            {/* Epic P2-PR-A — the practice this edge is gated by. A
                free-text label since phase 3: ProcessEdgePractice keeps
                `practiceKey` + `label` and no longer points at a row. */}
            <div
                className="flex flex-col gap-tight"
                data-testid="inspector-edge-practice-picker"
            >
                <span className="text-[10px] uppercase tracking-wide text-content-muted">
                    {t("processInspector.linkedPractice")}
                </span>
                <Input
                    value={practiceLabel}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPracticeLabel(e.target.value)}
                    onBlur={commitLinkedPractice}
                    aria-label={t("processInspector.linkedPractice")}
                    placeholder={t("processInspector.pickPractice")}
                />
                <span className="text-[10px] text-content-subtle">
                    {t("processInspector.auditorsSeePractice")}
                </span>
            </div>
                <p className="text-[10px] text-content-subtle">
                    {t("processInspector.saveHint")}
                </p>
            </div>
        </AsidePanel>
    );
}

/**
 * Epic P2-PR-A — read the typed practice list off an edge's `data`.
 * Tolerant of pre-P2 edges whose data omits the practices array.
 */
function readEdgePractices(edge: Edge): EdgePracticeRef[] {
    const raw = (edge.data as { practices?: unknown } | undefined)?.practices;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r) => {
            // `practiceId` is read-tolerant by omission: a legacy edge in
            // a saved map may still carry one, and dropping it here means
            // it is simply not carried forward. There is no column left to
            // write it to.
            const row = r as { practiceKey?: unknown; label?: unknown };
            if (typeof row.practiceKey !== "string") return null;
            return {
                practiceKey: row.practiceKey,
                label:
                    typeof row.label === "string" ? row.label : row.practiceKey,
            } satisfies EdgePracticeRef;
        })
        .filter((r): r is EdgePracticeRef => r !== null);
}
