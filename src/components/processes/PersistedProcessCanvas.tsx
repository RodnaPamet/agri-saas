"use client";

/**
 * R26-PR-A — PersistedProcessCanvas.
 *
 * Bridges the page's process-selection chrome to the underlying
 * xyflow canvas, adding:
 *
 *   • Server load of the selected map's graph (fetch on
 *     `activeId` change → `initialNodes` / `initialEdges` rehydrate)
 *   • Save button that PUTs the current canvas state back
 *   • New-process button that POSTs a fresh map
 *   • A minimal process selector at the top of the body
 *
 * The richer editor UX (visible name editing, save-as, inspector,
 * alignment, undo-redo) is intentionally NOT here — that lands in
 * R26-PR-E. PR-A's only ambition is: prove the persistence loop.
 *
 * State ownership:
 *   • The PersistedProcessCanvas owns the xyflow `nodes` + `edges`
 *     state. R25's `ProcessCanvas` always owned its own state and
 *     accepted `initialNodes` / `initialEdges` for rehydration; for
 *     PR-A we hoist that state up one level so the Save callback
 *     can read the current graph synchronously.
 *   • The canvas inner component is re-keyed on `activeId` so that
 *     opening a different map fully unmounts the existing xyflow
 *     instance (cheaper than trying to diff-update; xyflow handles
 *     mount in <100ms even for several-hundred-node graphs).
 */
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type DragEvent,
    type ReactNode,
} from "react";
import {
    Background,
    BackgroundVariant,
    ConnectionMode,
    Controls,
    ReactFlow,
    ReactFlowProvider,
    addEdge,
    applyEdgeChanges,
    applyNodeChanges,
    useReactFlow,
    type Connection,
    type Edge,
    type EdgeChange,
    type EdgeTypes,
    type Node,
    type NodeChange,
    type NodeTypes,
    type OnConnect,
    type OnEdgesChange,
    type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import {
    ProcessPalette,
    PALETTE_DRAG_MIME,
    type PaletteDropPayload,
} from "./ProcessPalette";
import {
    ProcessTypedNode,
    PROCESS_STEP_NODE_TYPE,
    isProcessNodeSize,
    type ProcessNodeSize,
} from "./ProcessTypedNode";
import {
    NODE_TAXONOMY,
    NODE_TAXONOMY_ORDER,
    isProcessNodeKind,
    type ProcessNodeKind,
} from "./node-taxonomy";
import {
    ProcessEdge,
    PROCESS_EDGE_TYPE,
    isProcessEdgeVariant,
} from "./ProcessEdge";
import { useProximityAutoBind } from "@/lib/processes/use-proximity-auto-bind";
import { useCanvasHistory } from "@/lib/processes/use-canvas-history";
import { useCanvasAutosave } from "@/lib/processes/use-canvas-autosave";
import { useCanvasChangeEmitter } from "@/lib/processes/canvas-change-events";
import { CanvasEmphasisProvider } from "@/lib/processes/canvas-emphasis-context";
import { inferEdgeKind } from "@/lib/processes/edge-kind-inference";
import { RunModeProvider, useRunMode } from "@/lib/processes/run-mode-context";
import { CanvasOverlayProvider } from "@/lib/processes/canvas-execution-overlay";
import { patchCanvasMode } from "@/lib/processes/switch-canvas-mode";
import {
    alignNodes,
    distributeNodes,
    type AlignmentAxis,
    type DistributeAxis,
} from "@/lib/processes/canvas-alignment";
import {
    computeAutoLayout,
    computeForceLayout,
    type AutoLayoutDirection,
} from "@/lib/processes/canvas-auto-layout";
import { useKeyboardShortcut } from "@/lib/hooks/use-keyboard-shortcut";
import {
    copyToClipboard,
    hasClipboard,
    pasteFromClipboard,
} from "@/lib/processes/canvas-clipboard";
import { ProcessInspector } from "./ProcessInspector";
import { CanvasHistorySidebar } from "./CanvasHistorySidebar";
import { CanvasDiffOverlay } from "./CanvasDiffOverlay";
import type { DiffGraphSnapshot } from "@/lib/processes/canvas-diff";
import {
    CanvasCommandPalette,
    type CanvasCommandGroup,
} from "./CanvasCommandPalette";
import { CanvasDocumentBar } from "./CanvasDocumentBar";
import { CanvasDrillBreadcrumb } from "./CanvasDrillBreadcrumb";
import { useCanvasDrillStack } from "@/lib/processes/use-canvas-drill-stack";
import {
    buildDrillBreadcrumbs,
    filterByDrillScope,
} from "@/lib/processes/canvas-drill-filter";
import { CanvasExportMenu } from "./CanvasExportMenu";
import { Tooltip } from "@/components/ui/tooltip";
// R31 — CanvasHelpStrip retired. The "tips" strip occupied a
// permanent band of chrome to teach four interactions that the
// canvas's empty state + the palette icon labels can convey on
// their own. Per the design verdict's "one message per state"
// principle, the empty-state hint at canvas-bottom-centre is now
// the canonical onboarding affordance. The component file is
// deleted alongside its rendered test; the R26-PR-F + R27-PR-F
// capstones are updated to document the supersession.
import type { ProcessEdgeVariant } from "./ProcessEdge";
import type { ProcessMapSummary } from "@/components/processes/types";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui/hooks";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { surfaceVersionConflict } from "@/lib/processes/version-conflict-toast";
import { edgePracticesForSave } from "@/lib/processes/edge-practices";

/**
 * Reserved edge id for the in-flight proximity preview. The
 * canvas synthesises an edge with this id while the user is
 * dragging near a candidate node, then strips it before commit.
 * Kept module-level so tests + the commit handler can refer to
 * the same constant.
 */
const PROXIMITY_PREVIEW_ID = "__proximity_preview__";

/**
 * PR-A polish — human-readable reasons for `isValidConnection`
 * verdicts. Surfaced via `toast.warning(...)` from the canvas's
 * rejection path. A shared `id: "canvas-connection-rejected"`
 * collapses rapid-fire misclicks into one toast.
 */
// Every taxonomy kind registers the SAME renderer. The renderer
// branches internally on `data.kind` so the chassis stays shared.
// Module-level so the reference is stable across re-renders
// (xyflow warns + remounts every node when `nodeTypes` changes).
const NODE_TYPES: NodeTypes = Object.fromEntries(
    NODE_TAXONOMY_ORDER.map((kind) => [kind, ProcessTypedNode]),
);
const EDGE_TYPES: EdgeTypes = {
    [PROCESS_EDGE_TYPE]: ProcessEdge,
};

// ─── Graph-row serialisers (R27-PR-B) ────────────────────────────────
// Node size persists in the forward-compatible `ProcessNode.dataJson`
// slot; edge variant persists in the `ProcessEdge.edgeKind` column.
// Both already round-trip end to end — no schema migration needed.

function nodeDataJson(n: Node): {
    size?: string;
    width?: number;
    height?: number;
    linkedEntityId?: string;
} | null {
    const size = (n.data as { size?: unknown } | undefined)?.size;
    // R30 — group nodes persist their explicit width / height
    // alongside the rest of `dataJson`. Reading from `data` and
    // `style` covers both freshly-created groups (whose width/
    // height start in `style`) and round-tripped groups (whose
    // width/height landed in `data` on rehydration).
    const styleW = (n.style as { width?: unknown } | undefined)?.width;
    const styleH = (n.style as { height?: unknown } | undefined)?.height;
    const dataW = (n.data as { width?: unknown } | undefined)?.width;
    const dataH = (n.data as { height?: unknown } | undefined)?.height;
    const width =
        typeof styleW === "number"
            ? styleW
            : typeof dataW === "number"
              ? dataW
              : null;
    const height =
        typeof styleH === "number"
            ? styleH
            : typeof dataH === "number"
              ? dataH
              : null;
    // Epic P2-PR-B — entity FK on risk / asset / practice nodes.
    const linkedEntityId = (n.data as { linkedEntityId?: unknown } | undefined)
        ?.linkedEntityId;
    const out: {
        size?: string;
        width?: number;
        height?: number;
        linkedEntityId?: string;
    } = {};
    if (isProcessNodeSize(size)) out.size = size;
    if (width != null) out.width = width;
    if (height != null) out.height = height;
    if (typeof linkedEntityId === "string" && linkedEntityId.length > 0) {
        out.linkedEntityId = linkedEntityId;
    }
    return Object.keys(out).length === 0 ? null : out;
}

function nodeParent(n: Node): string | null {
    const p = (n as { parentId?: unknown }).parentId;
    return typeof p === "string" && p.length > 0 ? p : null;
}

function edgeKindOf(e: Edge): string {
    const v = (e.data as { variant?: unknown } | undefined)?.variant;
    return isProcessEdgeVariant(v) ? v : "flow";
}

/**
 * Epic P5-PR-B — project the live xyflow graph into a
 * `DiffGraphSnapshot` so it can be diffed against a fetched
 * snapshot. Mirrors the projection used by `saveGraph` so the
 * identity + position + data fields line up exactly.
 *
 * Deliberately NOT memoised here — call sites memo per their own
 * dependency shape.
 */
function buildLiveSnapshot(nodes: Node[], edges: Edge[]): DiffGraphSnapshot {
    return {
        nodes: nodes.map((n, idx) => {
            const kind: ProcessNodeKind = isProcessNodeKind(n.type)
                ? n.type
                : PROCESS_STEP_NODE_TYPE;
            const meta = NODE_TAXONOMY[kind];
            const dataLabel =
                n.data &&
                typeof (n.data as { label?: unknown }).label === "string"
                    ? (n.data as { label: string }).label
                    : meta.defaultLabel;
            const dataSubtitle =
                n.data &&
                typeof (n.data as { subtitle?: unknown }).subtitle ===
                    "string"
                    ? (n.data as { subtitle: string }).subtitle
                    : null;
            return {
                nodeKey: n.id || `node-${idx + 1}`,
                nodeType: kind,
                label: dataLabel,
                subtitle: dataSubtitle,
                posX: n.position.x,
                posY: n.position.y,
                parentNodeKey: nodeParent(n),
                dataJson: nodeDataJson(n) as unknown,
            };
        }),
        edges: edges.map((e, idx) => ({
            edgeKey: e.id || `edge-${idx + 1}`,
            sourceKey: e.source,
            targetKey: e.target,
            edgeKind: edgeKindOf(e),
            labelOverride: typeof e.label === "string" ? e.label : null,
            dataJson: (e.data ?? null) as unknown,
        })),
    };
}

interface PersistedProcessCanvasProps {
    tenantSlug: string;
    processes: ProcessMapSummary[];
    activeId: string | null;
    onActiveIdChange: (id: string | null) => void;
    onProcessesChange: (next: ProcessMapSummary[]) => void;
}

/**
 * VR-6 — bridges Run Mode → live-execution overlay. Reads the run-mode flag
 * and only then turns on the 3s overlay poll, distributing the status map to
 * every node via context.
 */
function OverlayBridge({ children }: { children: React.ReactNode }) {
    const { isRunMode } = useRunMode();
    return <CanvasOverlayProvider enabled={isRunMode}>{children}</CanvasOverlayProvider>;
}

export function PersistedProcessCanvas(props: PersistedProcessCanvasProps) {
    return (
        <RunModeProvider>
            <OverlayBridge>
                <ReactFlowProvider>
                    <Inner {...props} />
                </ReactFlowProvider>
            </OverlayBridge>
        </RunModeProvider>
    );
}

interface LoadedGraph {
    mapId: string;
    nodes: Node[];
    edges: Edge[];
    version: number;
}

function Inner({
    tenantSlug,
    processes,
    activeId,
    onActiveIdChange,
    onProcessesChange,
}: PersistedProcessCanvasProps) {
    const [nodes, setNodes] = useState<Node[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);
    const [loadedMap, setLoadedMap] = useState<LoadedGraph | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [creating, setCreating] = useState(false);
    const [duplicating, setDuplicating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Epic P1 — bumped by the STALE_DATA Reload toast to re-trigger
    // the load effect without flickering through activeId=null.
    const [reloadCounter, setReloadCounter] = useState(0);
    // Epic P5-PR-B — when set, mounts CanvasDiffOverlay against the
    // current canvas state. The sidebar's "Diff" button sets this;
    // "Close" on the overlay resets it. Restore success bumps
    // `reloadCounter` so the new post-restore graph loads.
    const [diffAgainstVersion, setDiffAgainstVersion] = useState<number | null>(
        null,
    );
    const toast = useToast();
    const t = useTranslations("ui");
    const tCommon = useTranslations("common");
    // Epic P3-PR-A — ref to the [data-process-canvas] wrapper so
    // the export menu can walk down to xyflow's viewport child.
    const canvasWrapperRef = useRef<HTMLDivElement>(null);
    // Epic P6-PR-B — emit `data-mobile-layout` on the canvas
    // wrapper when the viewport is narrower than the tablet
    // breakpoint so the globals.css media-query rule can fold
    // the vertical palette into a horizontal scroll strip.
    const { isMobile } = useMediaQuery();
    // Epic P6-PR-A — sub-flow drill-down navigation stack.
    const drill = useCanvasDrillStack();
    // R26-PR-E — inline name editing. Mirrors the active process's
    // name so the user can edit it in place without every keystroke
    // bouncing through the parent state.
    const [editedName, setEditedName] = useState<string>("");
    // R28 — snap-to-grid toggle. xyflow's native snapToGrid +
    // snapGrid props are wired below; the toggle persists per
    // tenant in localStorage so authors keep their preference.
    const [snapEnabled, setSnapEnabled] = useState<boolean>(() => {
        if (typeof window === "undefined") return true;
        const v = window.localStorage.getItem("inflect:processes:snap");
        return v === null ? true : v === "1";
    });
    useEffect(() => {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(
            "inflect:processes:snap",
            snapEnabled ? "1" : "0",
        );
    }, [snapEnabled]);
    const { screenToFlowPosition, updateNodeData } = useReactFlow();
    // R28 — undo/redo history. Snapshots are pushed AFTER each
    // substantive edit (create/delete/move-stop/inspector-commit/
    // variant-cycle); keyboard binds Cmd+Z / Cmd+Shift+Z.
    const history = useCanvasHistory();
    // R29 — typed change-event emitter. Today only the autosave
    // path "subscribes" (indirectly, via markDirty); the hook is
    // the seam future collab / awareness layers plug into. See
    // canvas-change-events.ts for the wire-contract rationale.
    const changeEmitter = useCanvasChangeEmitter();

    // R26-PR-E — selected-node tracking for the inspector. xyflow
    // owns selection state internally; we mirror it via the change
    // handler so the inspector can read the selected node's data
    // synchronously.
    const selectedNode = nodes.find((n) => n.selected) ?? null;
    // R28 — same idea for the edge inspector. The inspector
    // gives precedence to node over edge if both are mounted; we
    // only mirror the edge slot here so the consumer can decide.
    const selectedEdge = edges.find((e) => e.selected) ?? null;
    // R29 — multi-select bookkeeping. The alignment + distribute
    // toolbar surfaces only when ≥2 nodes are selected (≥3 for
    // distribute). Memoising the id set keeps the toolbar's
    // disabled-state checks O(1).
    const selectedNodeIds = nodes
        .filter((n) => n.selected)
        .map((n) => n.id);
    const selectionCount = selectedNodeIds.length;

    // R32-PR5 — emphasis neighbourhood. When a node OR an edge is
    // selected, the rest of the graph dims out so the eye reads
    // "what touches what" at a glance. The neighbourhood is:
    //   • Selected node — its id + every node reachable via one
    //     edge hop in EITHER direction.
    //   • Selected edge — both endpoint node ids.
    //   • Nothing — null (renderers render normally).
    //
    // The set is the SOURCE of truth for the dimming render —
    // threaded through the canvas-emphasis context so the
    // ProcessTypedNode + ProcessEdge renderers can read it
    // without prop-drilling. Computed inline here (small graph
    // sizes; a linear edge scan is cheap).
    const emphasisIds: ReadonlySet<string> | null = (() => {
        if (selectedNode) {
            const ids = new Set<string>([selectedNode.id]);
            for (const e of edges) {
                if (e.source === selectedNode.id) ids.add(e.target);
                if (e.target === selectedNode.id) ids.add(e.source);
            }
            return ids;
        }
        if (selectedEdge) {
            return new Set<string>([selectedEdge.source, selectedEdge.target]);
        }
        return null;
    })();

    // Sync the editedName mirror to the active process name when
    // selection or rename-from-elsewhere changes.
    const activeProcess = activeId
        ? processes.find((p) => p.id === activeId) ?? null
        : null;
    useEffect(() => {
        setEditedName(activeProcess?.name ?? "");
    }, [activeProcess?.name, activeProcess?.id]);

    // ─── Server load on activeId change ────────────────────────────

    useEffect(() => {
        if (!activeId) {
            setNodes([]);
            setEdges([]);
            setLoadedMap(null);
            return;
        }
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(
                    `/api/t/${tenantSlug}/processes/${activeId}`,
                );
                if (!res.ok) throw new Error(`Load failed (${res.status})`);
                const data = (await res.json()) as {
                    id: string;
                    version: number;
                    nodes: Array<{
                        nodeKey: string;
                        nodeType: string;
                        label: string;
                        subtitle: string | null;
                        posX: number;
                        posY: number;
                        parentNodeKey: string | null;
                        dataJson: unknown;
                    }>;
                    edges: Array<{
                        edgeKey: string;
                        sourceKey: string;
                        targetKey: string;
                        edgeKind: string;
                        labelOverride: string | null;
                        // Epic P2-PR-A — practices round-trip on the edge.
                        practices?: Array<{ practiceKey: string; label: string; practiceId: string | null; dataJson: unknown }>;
                    }>;
                };
                if (cancelled) return;
                const rehydratedNodes: Node[] = data.nodes.map((n) => {
                    // The `nodeType` column is forward-compatible
                    // (typed `String`, not enum) so unknown kinds
                    // never crash rehydration. Fall back to the
                    // default kind; the renderer does the same.
                    const kind: ProcessNodeKind = isProcessNodeKind(n.nodeType)
                        ? n.nodeType
                        : PROCESS_STEP_NODE_TYPE;
                    // R27-PR-B — node size rides in `dataJson`.
                    const size = (
                        n.dataJson as { size?: unknown } | null | undefined
                    )?.size;
                    // R30 — group nodes carry their explicit width /
                    // height in `dataJson.width` + `dataJson.height`;
                    // xyflow uses these via `style` to size the
                    // container. Fall back to sensible defaults so
                    // a hand-edited row still renders.
                    const json = n.dataJson as
                        | {
                              width?: unknown;
                              height?: unknown;
                              linkedEntityId?: unknown;
                          }
                        | null
                        | undefined;
                    const isGroup = kind === "group";
                    const w = typeof json?.width === "number" ? json.width : 280;
                    const h = typeof json?.height === "number" ? json.height : 160;
                    // Epic P2-PR-B — linked-entity FK from dataJson.
                    const linkedEntityId = typeof json?.linkedEntityId === "string" ? json.linkedEntityId : null;
                    return {
                        id: n.nodeKey,
                        type: kind,
                        position: { x: n.posX, y: n.posY },
                        // R30 — round-trip parentNodeKey into xyflow's
                        // `parentId`. The node KEY IS the xyflow id in
                        // our model so no translation needed.
                        ...(n.parentNodeKey
                            ? { parentId: n.parentNodeKey, extent: "parent" as const }
                            : {}),
                        ...(isGroup ? { style: { width: w, height: h } } : {}),
                        data: {
                            label: n.label,
                            kind,
                            ...(n.subtitle ? { subtitle: n.subtitle } : {}),
                            ...(isProcessNodeSize(size) ? { size } : {}),
                            ...(isGroup ? { width: w, height: h } : {}),
                            ...(linkedEntityId ? { linkedEntityId } : {}),
                        },
                    };
                });
                // R30 — xyflow requires PARENT nodes to render BEFORE
                // their children in the nodes array. Reorder so every
                // group lands before its descendants; otherwise xyflow
                // logs a warning + the child positions read as absolute.
                rehydratedNodes.sort((a, b) => {
                    const aParent = (a as { parentId?: string }).parentId;
                    const bParent = (b as { parentId?: string }).parentId;
                    if (!aParent && bParent) return -1;
                    if (aParent && !bParent) return 1;
                    return 0;
                });
                const rehydratedEdges: Edge[] = data.edges.map((e) => ({
                    id: e.edgeKey,
                    source: e.sourceKey,
                    target: e.targetKey,
                    type: PROCESS_EDGE_TYPE,
                    // R27-PR-B — variant rides in edgeKind. P2-PR-A — practices in data.practices.
                    data: {
                        variant: isProcessEdgeVariant(e.edgeKind) ? e.edgeKind : "flow",
                        ...(Array.isArray(e.practices) && e.practices.length > 0
                            ? { practices: e.practices.map((c) => ({ practiceKey: c.practiceKey, label: c.label, practiceId: c.practiceId })) }
                            : {}),
                    },
                    ...(e.labelOverride ? { label: e.labelOverride } : {}),
                }));
                setNodes(rehydratedNodes);
                setEdges(rehydratedEdges);
                setLoadedMap({
                    mapId: data.id,
                    nodes: rehydratedNodes,
                    edges: rehydratedEdges,
                    version: data.version,
                });
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : t("persistedCanvas.loadFailed"));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
        // `reloadCounter` is bumped by the Epic-P1 STALE_DATA toast's
        // Reload action and forces a re-fetch of the same activeId.
    }, [activeId, tenantSlug, reloadCounter]);

    // ─── Save current canvas state ─────────────────────────────────

    const handleSave = useCallback(async () => {
        if (!activeId) return;
        setSaving(true);
        setError(null);
        try {
            const payload = {
                nodes: nodes.map((n, idx) => {
                    // The xyflow node carries its kind on `type`
                    // (registered in NODE_TYPES) AND on `data.kind`
                    // (consumed by the renderer). Both come back
                    // from the rehydration step. On save we trust
                    // `n.type` — it is the canonical xyflow
                    // identifier and the field the registry keys
                    // off — and fall back to the default kind if
                    // it ever drifts.
                    const kind: ProcessNodeKind = isProcessNodeKind(n.type)
                        ? n.type
                        : PROCESS_STEP_NODE_TYPE;
                    const meta = NODE_TAXONOMY[kind];
                    const dataLabel =
                        n.data &&
                        typeof (n.data as { label?: unknown }).label ===
                            "string"
                            ? (n.data as { label: string }).label
                            : meta.defaultLabel;
                    const dataSubtitle =
                        n.data &&
                        typeof (n.data as { subtitle?: unknown }).subtitle ===
                            "string"
                            ? (n.data as { subtitle: string }).subtitle
                            : null;
                    return {
                        nodeKey: n.id || `node-${idx + 1}`,
                        nodeType: kind,
                        label: dataLabel,
                        subtitle: dataSubtitle,
                        posX: n.position.x,
                        posY: n.position.y,
                        parentNodeKey: nodeParent(n),
                        dataJson: nodeDataJson(n),
                    };
                }),
                edges: edges.map((e, idx) => ({
                    edgeKey: e.id || `edge-${idx + 1}`,
                    sourceKey: e.source,
                    targetKey: e.target,
                    edgeKind: edgeKindOf(e),
                    labelOverride:
                        typeof e.label === "string" ? e.label : null,
                    practices: edgePracticesForSave(e),
                })),
                // Epic P1 — version we last loaded/saved; server
                // refuses on mismatch (409 / STALE_DATA).
                ...(loadedMap?.version !== undefined
                    ? { expectedVersion: loadedMap.version }
                    : {}),
            };
            const res = await fetch(
                `/api/t/${tenantSlug}/processes/${activeId}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                },
            );
            // Epic P1 — 409 / STALE_DATA: helper surfaces the Reload
            // toast and signals us to stop the save flow.
            const conflict = await surfaceVersionConflict(res, toast, () =>
                setReloadCounter((c) => c + 1),
            );
            if (conflict) {
                setError(null);
                return;
            }
            if (!res.ok) throw new Error(`Save failed (${res.status})`);
            const data = await res.json();
            // Update the summary list with the fresh version + updatedAt
            onProcessesChange(
                processes.map((p) =>
                    p.id === activeId
                        ? {
                              ...p,
                              version: data.version,
                              updatedAt: data.updatedAt,
                              nodeCount: data.nodes.length,
                              edgeCount: data.edges.length,
                          }
                        : p,
                ),
            );
            setLoadedMap({
                mapId: data.id,
                nodes,
                edges,
                version: data.version,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : t("persistedCanvas.saveFailed"));
        } finally {
            setSaving(false);
        }
    }, [activeId, nodes, edges, tenantSlug, processes, onProcessesChange, loadedMap, toast]);

    // ─── R28 — Autosave. Debounced 3s after the last edit. ────────
    // `markDirty()` fires from the change handlers below; the save
    // callback delegates to `handleSave` so the existing PUT path
    // is reused (no second serialisation surface to drift).
    const autosave = useCanvasAutosave({
        enabled: Boolean(activeId) && !loading,
        save: handleSave,
    });
    // Clear autosave dirty whenever rehydration completes — the
    // load sequence calls setNodes/setEdges which would normally
    // mark dirty; markClean keeps the post-load state idle.
    useEffect(() => {
        if (!loading) autosave.markClean();
        // markClean is stable enough (memoised in the hook); we
        // depend on `loading` only so the cleanup fires once per
        // load cycle.
    }, [loading, activeId, autosave]);

    // ─── Inspector: patch selected node ───────────────────────────

    const handleInspectorUpdate = useCallback(
        (
            nodeId: string,
            patch: {
                label?: string;
                subtitle?: string | null;
                size?: ProcessNodeSize;
                // Epic P2-PR-B — picker writes data.linkedEntityId.
                linkedEntityId?: string | null;
            },
        ) => {
            // PR-A polish — migrate from the prior whole-array
            // `setNodes` + `.map(...)` walker to xyflow v12's
            // `updateNodeData` hook. The hook scopes the re-render
            // to the single touched node instead of re-running the
            // entire node array map; on dense maps the difference
            // is measurable. The merge semantics match the old map
            // walker (shallow merge into `node.data`), so the
            // contract for callers is unchanged.
            const partial: Record<string, unknown> = {};
            if (patch.label !== undefined) partial.label = patch.label;
            if (patch.subtitle !== undefined) {
                partial.subtitle =
                    patch.subtitle === null ? undefined : patch.subtitle;
            }
            if (patch.size !== undefined) partial.size = patch.size;
            if (patch.linkedEntityId !== undefined) {
                partial.linkedEntityId =
                    patch.linkedEntityId === null
                        ? undefined
                        : patch.linkedEntityId;
            }
            updateNodeData(nodeId, partial);
        },
        [updateNodeData],
    );

    // ─── Rename: commit the inline name edit ──────────────────────

    const handleRenameCommit = useCallback(async () => {
        if (!activeId || !activeProcess) return;
        const trimmed = editedName.trim();
        if (trimmed === "" || trimmed === activeProcess.name) {
            setEditedName(activeProcess.name);
            return;
        }
        setSaving(true);
        setError(null);
        try {
            // Reuses the existing PUT endpoint — the SaveProcessMap
            // schema accepts a metadata-only payload with the
            // current graph alongside. Sending the live graph keeps
            // the rename action atomic with whatever in-flight
            // node/edge edits the user has open.
            const payload = {
                name: trimmed,
                nodes: nodes.map((n, idx) => ({
                    nodeKey: n.id || `node-${idx + 1}`,
                    nodeType: isProcessNodeKind(n.type)
                        ? n.type
                        : PROCESS_STEP_NODE_TYPE,
                    label:
                        n.data &&
                        typeof (n.data as { label?: unknown }).label === "string"
                            ? (n.data as { label: string }).label
                            : t("persistedCanvas.untitledStep"),
                    subtitle:
                        n.data &&
                        typeof (n.data as { subtitle?: unknown }).subtitle ===
                            "string"
                            ? (n.data as { subtitle: string }).subtitle
                            : null,
                    posX: n.position.x,
                    posY: n.position.y,
                    dataJson: nodeDataJson(n),
                })),
                edges: edges.map((e, idx) => ({
                    edgeKey: e.id || `edge-${idx + 1}`,
                    sourceKey: e.source,
                    targetKey: e.target,
                    edgeKind: edgeKindOf(e),
                    labelOverride:
                        typeof e.label === "string" ? e.label : null,
                    practices: edgePracticesForSave(e),
                })),
            };
            const res = await fetch(
                `/api/t/${tenantSlug}/processes/${activeId}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                },
            );
            if (!res.ok) throw new Error(`Rename failed (${res.status})`);
            const data = await res.json();
            onProcessesChange(
                processes.map((p) =>
                    p.id === activeId
                        ? {
                              ...p,
                              name: data.name,
                              version: data.version,
                              updatedAt: data.updatedAt,
                          }
                        : p,
                ),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : t("persistedCanvas.renameFailed"));
        } finally {
            setSaving(false);
        }
    }, [
        activeId,
        activeProcess,
        editedName,
        nodes,
        edges,
        tenantSlug,
        processes,
        onProcessesChange,
    ]);

    // ─── Duplicate: clone the current graph into a new map ────────

    const handleDuplicate = useCallback(async () => {
        if (!activeId || !activeProcess) return;
        setDuplicating(true);
        setError(null);
        try {
            const createRes = await fetch(`/api/t/${tenantSlug}/processes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: `${activeProcess.name} (copy)`,
                }),
            });
            if (!createRes.ok)
                throw new Error(`Duplicate create failed (${createRes.status})`);
            const newMap = await createRes.json();

            // Send the current canvas graph to the freshly created
            // map. Two round trips, no transactional guarantee — if
            // the second fails we leave an empty map behind, which
            // is recoverable + signposted by the toolbar selector
            // showing the new map.
            const saveRes = await fetch(
                `/api/t/${tenantSlug}/processes/${newMap.id}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        nodes: nodes.map((n, idx) => ({
                            nodeKey: n.id || `node-${idx + 1}`,
                            nodeType: isProcessNodeKind(n.type)
                                ? n.type
                                : PROCESS_STEP_NODE_TYPE,
                            label:
                                n.data &&
                                typeof (n.data as { label?: unknown }).label ===
                                    "string"
                                    ? (n.data as { label: string }).label
                                    : t("persistedCanvas.untitledStep"),
                            subtitle:
                                n.data &&
                                typeof (n.data as { subtitle?: unknown })
                                    .subtitle === "string"
                                    ? (n.data as { subtitle: string }).subtitle
                                    : null,
                            posX: n.position.x,
                            posY: n.position.y,
                            parentNodeKey: nodeParent(n),
                        dataJson: nodeDataJson(n),
                        })),
                        edges: edges.map((e, idx) => ({
                            edgeKey: e.id || `edge-${idx + 1}`,
                            sourceKey: e.source,
                            targetKey: e.target,
                            edgeKind: edgeKindOf(e),
                            labelOverride:
                                typeof e.label === "string" ? e.label : null,
                            practices: edgePracticesForSave(e),
                        })),
                    }),
                },
            );
            if (!saveRes.ok)
                throw new Error(`Duplicate save failed (${saveRes.status})`);
            const filled = await saveRes.json();

            const summary: ProcessMapSummary = {
                id: filled.id,
                name: filled.name,
                description: filled.description,
                status: filled.status,
                version: filled.version,
                createdAt: filled.createdAt,
                updatedAt: filled.updatedAt,
                nodeCount: filled.nodes.length,
                edgeCount: filled.edges.length,
            };
            onProcessesChange([summary, ...processes]);
            onActiveIdChange(filled.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("persistedCanvas.duplicateFailed"));
        } finally {
            setDuplicating(false);
        }
    }, [
        activeId,
        activeProcess,
        tenantSlug,
        nodes,
        edges,
        processes,
        onProcessesChange,
        onActiveIdChange,
    ]);

    // ─── Create new process ────────────────────────────────────────

    const handleNew = useCallback(
        // VR-2/VR-3 — `canvasMode` makes AUTOMATION-mode maps creatable from the
        // UI (the visual rule editor was previously reachable only by a raw API
        // call). DOCUMENT stays the default for the plain "New process" action.
        async (canvasMode: "DOCUMENT" | "AUTOMATION" = "DOCUMENT") => {
            setCreating(true);
            setError(null);
            try {
                // Normalise — call sites that pass handleNew directly to an
                // onClick hand us an event object; only an explicit
                // 'AUTOMATION' flips the mode.
                const mode = canvasMode === "AUTOMATION" ? "AUTOMATION" : "DOCUMENT";
                const isAuto = mode === "AUTOMATION";
                const name = isAuto
                    ? `Untitled workflow ${processes.length + 1}`
                    : `Untitled process ${processes.length + 1}`;
                const res = await fetch(`/api/t/${tenantSlug}/processes`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, canvasMode: mode }),
                });
                if (!res.ok) throw new Error(`Create failed (${res.status})`);
                const data = await res.json();
                const summary: ProcessMapSummary = {
                    id: data.id,
                    name: data.name,
                    description: data.description,
                    status: data.status,
                    version: data.version,
                    canvasMode: data.canvasMode ?? mode,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                    nodeCount: 0,
                    edgeCount: 0,
                };
                onProcessesChange([summary, ...processes]);
                onActiveIdChange(data.id);
            } catch (err) {
                setError(err instanceof Error ? err.message : t("persistedCanvas.createFailed"));
            } finally {
                setCreating(false);
            }
        },
        [tenantSlug, processes, onProcessesChange, onActiveIdChange],
    );

    // PR-B follow-up — convert the active map between process-map (DOCUMENT)
    // and the visual rule editor (AUTOMATION) without a graph save.
    const handleSwitchMode = useCallback(async () => {
        if (!activeId || !activeProcess) return;
        const next =
            activeProcess.canvasMode === "AUTOMATION" ? "DOCUMENT" : "AUTOMATION";
        try {
            await patchCanvasMode(tenantSlug, activeId, next);
            onProcessesChange(
                processes.map((p) =>
                    p.id === activeId ? { ...p, canvasMode: next } : p,
                ),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : t("persistedCanvas.modeSwitchFailed"));
        }
    }, [activeId, activeProcess, tenantSlug, processes, onProcessesChange]);

    // ─── Canvas plumbing (xyflow change handlers + drop) ───────────
    //
    // R28 — change classification. xyflow's NodeChange / EdgeChange
    // unions carry both substantive edits (add, remove, position-
    // commit) AND transient flicker (selection, dimensions,
    // position-during-drag). We mark dirty + push history only on
    // the substantive subset so autosave doesn't fire on every
    // selection click and undo doesn't bury a real undo point
    // under twenty drag-tick entries.
    const isSubstantiveNodeChange = (c: NodeChange): boolean => {
        switch (c.type) {
            case "add":
            case "remove":
                return true;
            case "position":
                // `dragging: false` marks the commit (mouse-up).
                // Intermediate drag ticks have `dragging: true`
                // and shouldn't push history.
                return c.dragging === false;
            default:
                return false;
        }
    };
    const isSubstantiveEdgeChange = (c: EdgeChange): boolean => {
        return c.type === "add" || c.type === "remove";
    };

    const onNodesChange = useCallback<OnNodesChange>(
        (changes: NodeChange[]) => {
            const substantive = changes.some(isSubstantiveNodeChange);
            if (substantive) {
                // Snapshot the PRE-change state so undo restores
                // exactly what was there before this edit.
                history.push({ nodes, edges });
                autosave.markDirty();
            }
            setNodes((nds) => applyNodeChanges(changes, nds));
        },
        [nodes, edges, history, autosave],
    );
    const onEdgesChange = useCallback<OnEdgesChange>(
        (changes: EdgeChange[]) => {
            const substantive = changes.some(isSubstantiveEdgeChange);
            if (substantive) {
                history.push({ nodes, edges });
                autosave.markDirty();
            }
            setEdges((eds) => applyEdgeChanges(changes, eds));
        },
        [nodes, edges, history, autosave],
    );
    const onConnect = useCallback<OnConnect>(
        (c: Connection) => {
            history.push({ nodes, edges });
            autosave.markDirty();
            // VR-5 — infer the semantic automation edge-kind from the endpoint
            // node kinds (trigger→condition = trigger-flow, action→action =
            // chain-delay, …). Non-automation pairs infer 'flow' and carry no
            // edgeKind, so document maps are unaffected.
            const srcKind = nodes.find((n) => n.id === c.source)?.data?.kind as
                | string
                | undefined;
            const tgtKind = nodes.find((n) => n.id === c.target)?.data?.kind as
                | string
                | undefined;
            const inferred = inferEdgeKind(srcKind, tgtKind);
            const data = inferred !== "flow" ? { edgeKind: inferred } : undefined;
            setEdges((eds) =>
                addEdge(
                    { ...c, type: PROCESS_EDGE_TYPE, id: `edge-${Date.now()}`, data },
                    eds,
                ),
            );
        },
        [nodes, edges, history, autosave],
    );

    // R28 — connection validity predicate. Three reject conditions:
    //   1. Self-loop (source === target) — never meaningful in a
    //      process map; the user has misclicked.
    //   2. Duplicate (an edge already exists for this directed
    //      pair) — auto-bind has the same guard; the manual
    //      connect path needs it for parity.
    //   3. Annotation participation — annotations are documentary,
    //      not part of the flow (their kind already declares
    //      `hasHandles: false`, but if a future variant ever
    //      slipped through, the explicit reject keeps the graph
    //      semantics intact).
    const isValidConnection = useCallback(
        (c: Connection | Edge) => {
            const src = "source" in c ? c.source : null;
            const tgt = "target" in c ? c.target : null;
            if (!src || !tgt) return false;
            // Epic P4-PR-B — emit a transient `rejectedSource` flag
            // when the connection fails. The source node's
            // `data-connection-rejected` attribute drives a CSS
            // shake animation. The state clears after 600ms via
            // the effect declared at the top of Inner.
            //
            // PR-A polish — also fire a `toast.warning(...)` carrying
            // the reason text. The gap analysis flagged "tooltip
            // explaining rejection reason", but a tooltip has no
            // stable hover host once the rejection lands (the user's
            // mouse has already left the handle by then). A toast
            // hits the same goal — the user sees WHY their drop was
            // refused — without inventing a phantom anchor element.
            const reject = (reason: "self" | "duplicate" | "annotation") => {
                setRejectedSource(src);
                toast.warning(t(`persistedCanvas.reject.${reason}`), {
                    id: "canvas-connection-rejected",
                });
                return false;
            };
            if (src === tgt) return reject("self");
            if (edges.some((e) => e.source === src && e.target === tgt)) {
                return reject("duplicate");
            }
            const srcNode = nodes.find((n) => n.id === src);
            const tgtNode = nodes.find((n) => n.id === tgt);
            const srcKind = (srcNode?.data as { kind?: unknown })?.kind;
            const tgtKind = (tgtNode?.data as { kind?: unknown })?.kind;
            if (srcKind === "annotation" || tgtKind === "annotation") {
                return reject("annotation");
            }
            return true;
        },
        [nodes, edges, toast, t],
    );

    // R28 — edge inspector commit. Patches the edge's label (top-
    // level on xyflow) + `data.variant`. Pushes history + marks
    // dirty so the change survives undo and triggers autosave.
    const handleEdgeUpdate = useCallback(
        (
            edgeId: string,
            patch: {
                label?: string | null;
                variant?: ProcessEdgeVariant;
                // Epic P2-PR-A — Linked-practice picker patch.
                practices?: Array<{ practiceKey: string; label: string; practiceId: string | null }>;
            },
        ) => {
            history.push({ nodes, edges });
            autosave.markDirty();
            setEdges((eds) =>
                eds.map((e) => {
                    if (e.id !== edgeId) return e;
                    const next: Edge = { ...e };
                    if (patch.label !== undefined) {
                        // null = "clear the label"; xyflow accepts
                        // undefined or the absence of the field
                        // for an unlabelled edge.
                        if (patch.label === null) {
                            delete (next as { label?: unknown }).label;
                        } else {
                            next.label = patch.label;
                        }
                    }
                    if (patch.variant !== undefined) {
                        const prevData = (e.data ?? {}) as Record<
                            string,
                            unknown
                        >;
                        next.data = { ...prevData, variant: patch.variant };
                    }
                    if (patch.practices !== undefined) {
                        const prevData = (next.data ?? e.data ?? {}) as Record<
                            string,
                            unknown
                        >;
                        next.data = {
                            ...prevData,
                            practices: patch.practices,
                        };
                    }
                    return next;
                }),
            );
        },
        [nodes, edges, history, autosave],
    );

    // R28 — undo / redo. The hook stack stores PRE-change
    // snapshots; on undo we stash the LIVE state into the redo
    // stack so redo can restore it. Cmd+Z = undo, Cmd+Shift+Z =
    // redo (the editor-standard).
    const handleUndo = useCallback(() => {
        const prev = history.undo();
        if (!prev) return;
        history.pushRedo({ nodes, edges });
        setNodes(prev.nodes);
        setEdges(prev.edges);
        autosave.markDirty();
    }, [history, nodes, edges, autosave]);
    const handleRedo = useCallback(() => {
        const next = history.redo();
        if (!next) return;
        history.push({ nodes, edges });
        setNodes(next.nodes);
        setEdges(next.edges);
        autosave.markDirty();
    }, [history, nodes, edges, autosave]);

    // R29 — multi-select alignment + distribute. Pure functions
    // in canvas-alignment.ts compute the new positions; here we
    // push history + mark dirty + emit a typed move event.
    const handleAlign = useCallback(
        (axis: AlignmentAxis) => {
            if (selectionCount < 2) return;
            const ids = new Set(selectedNodeIds);
            history.push({ nodes, edges });
            setNodes((nds) => alignNodes(nds, ids, axis));
            autosave.markDirty();
            changeEmitter.emit("node.move", {
                nodeIds: Array.from(ids),
            });
        },
        [
            selectionCount,
            selectedNodeIds,
            nodes,
            edges,
            history,
            autosave,
            changeEmitter,
        ],
    );
    // Epic P4-PR-A — Auto-layout (dagre). Pushes the current
    // layout to history so undo restores the hand-placed positions.
    const handleAutoLayout = useCallback(
        (direction: AutoLayoutDirection) => {
            if (nodes.length === 0) return;
            history.push({ nodes, edges });
            const { positions } = computeAutoLayout(nodes, edges, direction);
            setNodes((nds) =>
                nds.map((n) =>
                    positions[n.id]
                        ? { ...n, position: positions[n.id] }
                        : n,
                ),
            );
            autosave.markDirty();
            changeEmitter.emit("node.move", {
                nodeIds: Object.keys(positions),
            });
        },
        [nodes, edges, history, autosave, changeEmitter],
    );
    // PR-A polish — Auto-arrange SELECTION only. The dagre call
    // is scoped to the selected node ids; the rest of the canvas
    // keeps its current positions. The selection's centroid is
    // preserved (see `nodeIdsFilter` branch in computeAutoLayout)
    // so the rearranged subset lands roughly where the user
    // expected, not at the canvas origin.
    const handleAutoLayoutSelection = useCallback(
        (direction: AutoLayoutDirection) => {
            if (selectionCount < 2) return;
            const ids = new Set(selectedNodeIds);
            history.push({ nodes, edges });
            const { positions } = computeAutoLayout(
                nodes,
                edges,
                direction,
                ids,
            );
            setNodes((nds) =>
                nds.map((n) =>
                    positions[n.id]
                        ? { ...n, position: positions[n.id] }
                        : n,
                ),
            );
            autosave.markDirty();
            changeEmitter.emit("node.move", {
                nodeIds: Object.keys(positions),
            });
        },
        [
            selectionCount,
            selectedNodeIds,
            nodes,
            edges,
            history,
            autosave,
            changeEmitter,
        ],
    );
    // PR-C polish — Force-directed (organic) layout via elkjs.
    // Async because elkjs returns a Promise; the await happens
    // BEFORE the setNodes call so xyflow only sees one transition
    // (no flicker via partial state). The `selectionIds`
    // parameter (optional) routes through the same nodeIdsFilter
    // contract `handleAutoLayoutSelection` uses for dagre.
    const handleAutoLayoutForce = useCallback(
        async (selectionOnly: boolean) => {
            if (nodes.length === 0) return;
            const filter = selectionOnly ? new Set(selectedNodeIds) : undefined;
            if (selectionOnly && (filter?.size ?? 0) < 2) return;
            history.push({ nodes, edges });
            const { positions } = await computeForceLayout(
                nodes,
                edges,
                filter,
            );
            setNodes((nds) =>
                nds.map((n) =>
                    positions[n.id]
                        ? { ...n, position: positions[n.id] }
                        : n,
                ),
            );
            autosave.markDirty();
            changeEmitter.emit("node.move", {
                nodeIds: Object.keys(positions),
            });
        },
        [
            nodes,
            edges,
            selectedNodeIds,
            history,
            autosave,
            changeEmitter,
        ],
    );
    const handleDistribute = useCallback(
        (axis: DistributeAxis) => {
            if (selectionCount < 3) return;
            const ids = new Set(selectedNodeIds);
            history.push({ nodes, edges });
            setNodes((nds) => distributeNodes(nds, ids, axis));
            autosave.markDirty();
            changeEmitter.emit("node.move", {
                nodeIds: Array.from(ids),
            });
        },
        [
            selectionCount,
            selectedNodeIds,
            nodes,
            edges,
            history,
            autosave,
            changeEmitter,
        ],
    );

    // R29 — bulk delete. Delete key already works via xyflow's
    // selection-aware change pipeline; this is the explicit
    // toolbar affordance so the action is discoverable when ≥2
    // are selected.
    // R30 — Group selected. Creates a fresh group container sized
    // to encompass the selection's bounding box (with padding); each
    // selected node becomes the group's child. xyflow expects child
    // positions to be RELATIVE to the parent, so we shift each
    // child's position by (parent.x, parent.y).
    const handleGroupSelected = useCallback(() => {
        if (selectionCount < 2) return;
        const ids = new Set(selectedNodeIds);
        const targets = nodes.filter((n) => ids.has(n.id));
        // Refuse to group nodes that already belong to a group —
        // nested grouping is allowed by xyflow but the UX work to
        // make nested-group resize feel right is out of R30 scope.
        if (targets.some((n) => nodeParent(n) != null)) return;
        if (targets.some((n) => (n.data as { kind?: unknown })?.kind === "group")) return;

        // Compute bounding box. Conservative w/h fallbacks match
        // canvas-alignment.ts (180×72 for unmeasured steps).
        const FALLBACK_W = 180;
        const FALLBACK_H = 72;
        const boxes = targets.map((n) => {
            const m = n.measured as { width?: number; height?: number } | undefined;
            return {
                x: n.position.x,
                y: n.position.y,
                w: m?.width ?? n.width ?? FALLBACK_W,
                h: m?.height ?? n.height ?? FALLBACK_H,
            };
        });
        const PADDING = 32;
        const HEADER = 24;
        const minX = Math.min(...boxes.map((b) => b.x)) - PADDING;
        const minY = Math.min(...boxes.map((b) => b.y)) - PADDING - HEADER;
        const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + PADDING;
        const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + PADDING;
        const groupId = `group-${Date.now()}`;
        const groupNode: Node = {
            id: groupId,
            type: "group",
            position: { x: minX, y: minY },
            style: { width: maxX - minX, height: maxY - minY },
            data: {
                label: t("persistedCanvas.groupLabel"),
                kind: "group",
                width: maxX - minX,
                height: maxY - minY,
            },
        };

        history.push({ nodes, edges });
        // Group node MUST come first in the array so xyflow renders
        // it BEFORE its children (parent-before-child is the canonical
        // xyflow requirement).
        setNodes((nds) => {
            const reparented = nds.map((n) => {
                if (!ids.has(n.id)) return n;
                return {
                    ...n,
                    parentId: groupId,
                    extent: "parent" as const,
                    // xyflow expects child positions to be RELATIVE
                    // to the parent when parentId is set.
                    position: {
                        x: n.position.x - minX,
                        y: n.position.y - minY,
                    },
                };
            });
            return [groupNode, ...reparented];
        });
        autosave.markDirty();
        changeEmitter.emit("node.add", { nodeIds: [groupId] });
        changeEmitter.emit("node.update", { nodeIds: Array.from(ids) });
    }, [
        selectionCount,
        selectedNodeIds,
        nodes,
        edges,
        history,
        autosave,
        changeEmitter,
    ]);

    // R30 — Ungroup. Pops every child out of a selected group node:
    // adds the group's position back to each child's relative
    // position (making them absolute again), then removes the
    // group itself. Only fires when exactly one group is selected.
    const handleUngroup = useCallback(() => {
        if (!selectedNode) return;
        const kind = (selectedNode.data as { kind?: unknown })?.kind;
        if (kind !== "group") return;
        const groupId = selectedNode.id;
        const gx = selectedNode.position.x;
        const gy = selectedNode.position.y;
        history.push({ nodes, edges });
        setNodes((nds) => {
            const lifted = nds
                .filter((n) => n.id !== groupId)
                .map((n) => {
                    if (nodeParent(n) !== groupId) return n;
                    return {
                        ...n,
                        position: { x: n.position.x + gx, y: n.position.y + gy },
                        parentId: undefined,
                        extent: undefined,
                    };
                });
            return lifted;
        });
        autosave.markDirty();
        changeEmitter.emit("node.remove", { nodeIds: [groupId] });
    }, [selectedNode, nodes, edges, history, autosave, changeEmitter]);

    const handleBulkDelete = useCallback(() => {
        if (selectionCount === 0) return;
        const ids = new Set(selectedNodeIds);
        history.push({ nodes, edges });
        setNodes((nds) => nds.filter((n) => !ids.has(n.id)));
        // Also strip edges that reference any of the removed
        // nodes — xyflow does this on Delete key but the manual
        // path needs the same cleanup.
        setEdges((eds) =>
            eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
        );
        autosave.markDirty();
        changeEmitter.emit("node.remove", {
            nodeIds: Array.from(ids),
        });
    }, [
        selectionCount,
        selectedNodeIds,
        nodes,
        edges,
        history,
        autosave,
        changeEmitter,
    ]);

    useKeyboardShortcut("mod+z", handleUndo, {
        description: t("persistedCanvas.scUndo"),
        enabled: Boolean(activeId),
    });
    useKeyboardShortcut("mod+shift+z", handleRedo, {
        description: t("persistedCanvas.scRedo"),
        enabled: Boolean(activeId),
    });
    useKeyboardShortcut("mod+s", () => void handleSave(), {
        description: t("persistedCanvas.scSave"),
        enabled: Boolean(activeId),
    });

    // Epic P4-PR-B — Cmd+C / Cmd+V / Cmd+D for selected nodes.
    const handleCopy = useCallback(() => {
        const selected = nodes.filter((n) => n.selected);
        if (selected.length === 0) return;
        copyToClipboard(selected, edges);
    }, [nodes, edges]);
    const handlePaste = useCallback(() => {
        if (!hasClipboard()) return;
        const pasted = pasteFromClipboard();
        if (!pasted) return;
        history.push({ nodes, edges });
        setNodes((nds) => [
            ...nds.map((n) => ({ ...n, selected: false })),
            ...pasted.nodes,
        ]);
        setEdges((eds) => [...eds, ...pasted.edges]);
        autosave.markDirty();
    }, [nodes, edges, history, autosave]);
    const handleDuplicateSelection = useCallback(() => {
        const selected = nodes.filter((n) => n.selected);
        if (selected.length === 0) return;
        copyToClipboard(selected, edges);
        handlePaste();
    }, [nodes, edges, handlePaste]);
    useKeyboardShortcut("mod+c", handleCopy, {
        description: t("persistedCanvas.scCopy"),
        enabled: Boolean(activeId),
    });
    useKeyboardShortcut("mod+v", handlePaste, {
        description: t("persistedCanvas.scPaste"),
        enabled: Boolean(activeId),
    });
    useKeyboardShortcut("mod+d", handleDuplicateSelection, {
        description: t("persistedCanvas.scDuplicate"),
        enabled: Boolean(activeId),
        preventDefault: true,
    });

    // Epic P4-PR-B — Tab-to-create. From a single selected node,
    // mint a connected sibling of the same kind to the right.
    const handleTabCreate = useCallback(() => {
        const selected = nodes.filter((n) => n.selected);
        if (selected.length !== 1) return;
        const source = selected[0];
        const kind =
            (source.data as { kind?: unknown } | undefined)?.kind ??
            "processStep";
        const newId = `n-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
        const newNode: Node = {
            id: newId,
            type: typeof kind === "string" ? kind : "processStep",
            position: {
                x: source.position.x + 280,
                y: source.position.y,
            },
            data: { label: t("persistedCanvas.untitled"), kind },
            selected: true,
        };
        const newEdge: Edge = {
            id: `edge-${newId}`,
            source: source.id,
            target: newId,
            type: PROCESS_EDGE_TYPE,
            data: { variant: "flow" },
        };
        history.push({ nodes, edges });
        setNodes((nds) => [
            ...nds.map((n) => ({ ...n, selected: false })),
            newNode,
        ]);
        setEdges((eds) => [...eds, newEdge]);
        autosave.markDirty();
    }, [nodes, edges, history, autosave]);
    useKeyboardShortcut("tab", handleTabCreate, {
        description: t("persistedCanvas.scTab"),
        enabled: Boolean(activeId),
        preventDefault: true,
    });

    // Epic P4-PR-B — Connection-rejection feedback. When xyflow
    // rejects a connection (self-loop, duplicate, annotation
    // participation), surface a transient `data-connection-rejected`
    // marker so the source handle gets the canonical rejection
    // animation. The state clears 600ms later — the animation
    // duration.
    const [rejectedSource, setRejectedSource] = useState<string | null>(null);
    useEffect(() => {
        if (rejectedSource === null) return;
        const timer = setTimeout(() => setRejectedSource(null), 600);
        return () => clearTimeout(timer);
    }, [rejectedSource]);

    // R26-PR-C — proximity auto-bind. When the user drags a node
    // close enough to another, surface a candidate edge; on
    // mouse-up still in range, commit it.
    const handleProximityCommit = useCallback(
        (cand: { source: string; target: string }) => {
            setEdges((eds) => {
                // Guard against the (rare) race where the candidate
                // edge already landed via the in-flight onConnect
                // path. addEdge would dedupe by id but not by
                // (source, target).
                if (
                    eds.some(
                        (e) =>
                            e.source === cand.source &&
                            e.target === cand.target,
                    )
                ) {
                    return eds;
                }
                return [
                    ...eds,
                    {
                        id: `edge-${Date.now()}`,
                        source: cand.source,
                        target: cand.target,
                        type: PROCESS_EDGE_TYPE,
                    },
                ];
            });
        },
        [],
    );
    const proximity = useProximityAutoBind(nodes, edges, {
        onCommit: handleProximityCommit,
    });
    const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    }, []);
    const onDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const raw = event.dataTransfer.getData(PALETTE_DRAG_MIME);
            if (!raw) return;
            // R26-PR-B widened the palette payload from a raw label
            // (`"Process step"`) to a JSON object `{ kind, label }`.
            // Parse the structured form first; if that fails we
            // gracefully fall back to treating `raw` as a label and
            // minting a default-kind step node. The fallback keeps
            // backwards compat with any stale drag source still
            // sending the R25 payload shape.
            let kind: ProcessNodeKind = PROCESS_STEP_NODE_TYPE;
            let label = raw;
            try {
                const parsed = JSON.parse(raw) as PaletteDropPayload;
                if (
                    parsed &&
                    typeof parsed === "object" &&
                    isProcessNodeKind(parsed.kind) &&
                    typeof parsed.label === "string"
                ) {
                    kind = parsed.kind;
                    label = parsed.label;
                }
            } catch {
                // Non-JSON payload — keep the raw-label fallback.
            }
            const position = screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            });
            const meta = NODE_TAXONOMY[kind];
            setNodes((nds) => [
                ...nds,
                {
                    id: `node-${Date.now()}`,
                    type: kind,
                    position,
                    data: { label: label || meta.defaultLabel, kind },
                },
            ]);
        },
        [screenToFlowPosition],
    );

    const showEmpty = !activeId;

    // R31 Bundle 8 (PR 9) — Canvas command palette groups.
    // The palette is opened by `/` and lists every canvas verb
    // shipped in R28 / R29 / R30 / R31. Groups read top-to-bottom:
    // document actions first (Save, Undo, Redo, Fit view), then
    // selection-aware commands (Group / Ungroup / Align /
    // Distribute / Delete), then mode toggles (Snap).
    const commandGroups: CanvasCommandGroup[] = [
        {
            heading: t("persistedCanvas.headingDocument"),
            commands: [
                {
                    id: "save",
                    label: tCommon("save"),
                    description: t("persistedCanvas.cmdSaveDesc"),
                    shortcut: "⌘S",
                    disabled: !activeId || saving || loading,
                    onSelect: () => void handleSave(),
                },
                {
                    id: "undo",
                    label: t("processDocBar.undo"),
                    description: t("persistedCanvas.cmdUndoDesc"),
                    shortcut: "⌘Z",
                    disabled: !history.canUndo || saving || loading,
                    onSelect: handleUndo,
                },
                {
                    id: "redo",
                    label: t("processDocBar.redo"),
                    description: t("persistedCanvas.cmdRedoDesc"),
                    shortcut: "⌘⇧Z",
                    disabled: !history.canRedo || saving || loading,
                    onSelect: handleRedo,
                },
                {
                    id: "duplicate",
                    label: t("persistedCanvas.cmdDuplicate"),
                    description: t("persistedCanvas.cmdDuplicateDesc"),
                    disabled: !activeId || duplicating || saving || loading,
                    onSelect: handleDuplicate,
                },
                {
                    id: "new",
                    label: t("persistedCanvas.cmdNew"),
                    description: t("persistedCanvas.cmdNewDesc"),
                    disabled: creating,
                    onSelect: () => handleNew("DOCUMENT"),
                },
                {
                    id: "new-automation",
                    label: t("persistedCanvas.cmdNewAutomation"),
                    description: t("persistedCanvas.cmdNewAutomationDesc"),
                    disabled: creating,
                    onSelect: () => handleNew("AUTOMATION"),
                },
            ],
        },
        {
            // Epic P4-PR-A — dagre auto-layout.
            heading: t("persistedCanvas.headingLayout"),
            commands: [
                {
                    id: "arrange-lr",
                    label: t("persistedCanvas.cmdArrangeLr"),
                    description: t("persistedCanvas.cmdArrangeLrDesc"),
                    disabled: nodes.length === 0 || saving || loading,
                    onSelect: () => handleAutoLayout("LR"),
                },
                {
                    id: "arrange-tb",
                    label: t("persistedCanvas.cmdArrangeTb"),
                    description: t("persistedCanvas.cmdArrangeTbDesc"),
                    disabled: nodes.length === 0 || saving || loading,
                    onSelect: () => handleAutoLayout("TB"),
                },
                // PR-A polish — selection-only auto-arrange. Enabled
                // only when ≥2 nodes are selected; lays out just
                // that subset and re-centres on the selection's
                // pre-layout centroid so the result lands where the
                // user expects.
                {
                    id: "arrange-selection-lr",
                    label: t("persistedCanvas.cmdArrangeSelLr"),
                    description: t("persistedCanvas.cmdArrangeSelLrDesc"),
                    disabled: selectionCount < 2 || saving || loading,
                    onSelect: () => handleAutoLayoutSelection("LR"),
                },
                {
                    id: "arrange-selection-tb",
                    label: t("persistedCanvas.cmdArrangeSelTb"),
                    description: t("persistedCanvas.cmdArrangeSelTbDesc"),
                    disabled: selectionCount < 2 || saving || loading,
                    onSelect: () => handleAutoLayoutSelection("TB"),
                },
                // PR-C polish — Force-directed (organic) layout
                // for graphs without a clear hierarchical flow.
                // elkjs is loaded on demand (the ~600KB bundle is
                // dynamically imported by `computeForceLayout`).
                {
                    id: "arrange-force",
                    label: t("persistedCanvas.cmdForce"),
                    description: t("persistedCanvas.cmdForceDesc"),
                    disabled: nodes.length === 0 || saving || loading,
                    onSelect: () => void handleAutoLayoutForce(false),
                },
                {
                    id: "arrange-force-selection",
                    label: t("persistedCanvas.cmdForceSel"),
                    description: t("persistedCanvas.cmdForceSelDesc"),
                    disabled: selectionCount < 2 || saving || loading,
                    onSelect: () => void handleAutoLayoutForce(true),
                },
            ],
        },
        {
            heading: t("persistedCanvas.headingSelection"),
            commands: [
                {
                    id: "group",
                    label: t("persistedCanvas.groupSelected"),
                    description: t("persistedCanvas.groupDesc"),
                    disabled:
                        selectionCount < 2 ||
                        nodes
                            .filter((n) => selectedNodeIds.includes(n.id))
                            .some(
                                (n) =>
                                    nodeParent(n) != null ||
                                    (n.data as { kind?: unknown })?.kind ===
                                        "group",
                            ),
                    onSelect: handleGroupSelected,
                },
                {
                    id: "ungroup",
                    label: t("persistedCanvas.ungroup"),
                    description: t("persistedCanvas.ungroupDesc"),
                    disabled:
                        !selectedNode ||
                        (selectedNode.data as { kind?: unknown })?.kind !==
                            "group",
                    onSelect: handleUngroup,
                },
                {
                    id: "align-left",
                    label: t("persistedCanvas.alignLeft"),
                    disabled: selectionCount < 2,
                    onSelect: () => handleAlign("left"),
                },
                {
                    id: "align-center-x",
                    label: t("persistedCanvas.alignCenterX"),
                    disabled: selectionCount < 2,
                    onSelect: () => handleAlign("center-x"),
                },
                {
                    id: "align-right",
                    label: t("persistedCanvas.alignRight"),
                    disabled: selectionCount < 2,
                    onSelect: () => handleAlign("right"),
                },
                {
                    id: "align-top",
                    label: t("persistedCanvas.alignTop"),
                    disabled: selectionCount < 2,
                    onSelect: () => handleAlign("top"),
                },
                {
                    id: "align-center-y",
                    label: t("persistedCanvas.alignCenterY"),
                    disabled: selectionCount < 2,
                    onSelect: () => handleAlign("center-y"),
                },
                {
                    id: "align-bottom",
                    label: t("persistedCanvas.alignBottom"),
                    disabled: selectionCount < 2,
                    onSelect: () => handleAlign("bottom"),
                },
                {
                    id: "distribute-h",
                    label: t("persistedCanvas.distributeH"),
                    disabled: selectionCount < 3,
                    onSelect: () => handleDistribute("horizontal"),
                },
                {
                    id: "distribute-v",
                    label: t("persistedCanvas.distributeV"),
                    disabled: selectionCount < 3,
                    onSelect: () => handleDistribute("vertical"),
                },
                {
                    id: "delete",
                    label: t("persistedCanvas.cmdDelete"),
                    description: t("persistedCanvas.cmdDeleteDesc"),
                    shortcut: "Del",
                    disabled: selectionCount === 0,
                    onSelect: handleBulkDelete,
                },
            ],
        },
        {
            heading: t("persistedCanvas.headingModes"),
            commands: [
                {
                    id: "snap-toggle",
                    label: snapEnabled
                        ? t("persistedCanvas.cmdSnapOn")
                        : t("persistedCanvas.cmdSnapOff"),
                    description: t("persistedCanvas.cmdSnapDesc"),
                    onSelect: () => setSnapEnabled((v) => !v),
                },
            ],
        },
    ];

    return (
        // R32-PR5 — emphasis provider. The whole canvas subtree
        // reads `useCanvasEmphasis()` so the typed-node + edge
        // renderers can dim themselves out when they fall
        // outside the selected node's one-hop neighbourhood.
        <CanvasEmphasisProvider emphasisIds={emphasisIds}>
        <div
            ref={canvasWrapperRef}
            className="flex h-full w-full flex-col"
            data-process-canvas="true"
            data-mobile-layout={isMobile ? "true" : undefined}
        >
            <CanvasCommandPalette groups={commandGroups} />
            {/* R31 Bundle 3 (PR 1) — the document bar. Pre-R31 this
                row carried the document selector + name + actions
                ONLY; the page above it carried a separate breadcrumb
                + Heading + description block (three bands of chrome
                before the canvas). The page block is now gone — the
                breadcrumbs + tenant-rooted document identity live
                inline here, Figma-style. One bar above the canvas. */}
            {/* R32-PR10 — document bar extracted from 195 lines of
                inline JSX into its own component. The bar owns no
                state; every field flows from Inner via five grouped
                props (doc / busy / editorState / handlers /
                tenantSlug). Testids, classes, and behaviour are
                byte-identical to the pre-R32 inline version. */}
            <CanvasDocumentBar
                tenantSlug={tenantSlug}
                doc={{
                    activeId,
                    processes,
                    activeProcess,
                    editedName,
                    loadedMap,
                    error,
                }}
                busy={{ saving, loading, creating, duplicating }}
                editorState={{
                    snapEnabled,
                    autosaveStatus: autosave.status,
                    canUndo: history.canUndo,
                    canRedo: history.canRedo,
                }}
                handlers={{
                    onActiveIdChange,
                    setEditedName,
                    handleSave,
                    handleNew,
                    handleDuplicate,
                    handleRenameCommit,
                    handleUndo,
                    handleRedo,
                    setSnapEnabled,
                    onSwitchMode: handleSwitchMode,
                }}
                exportSlot={
                    activeId && activeProcess ? (
                        <CanvasExportMenu
                            canvasEl={canvasWrapperRef.current}
                            nodes={nodes}
                            mapName={activeProcess.name}
                            tenantSlug={tenantSlug}
                            mapId={activeId}
                            disabled={saving || loading}
                        />
                    ) : null
                }
            />

            {/* Epic P6-PR-A — drill-down breadcrumb. Hidden at
                root; shown when the user double-clicks into a
                group. Each crumb jumps directly to that depth. */}
            <CanvasDrillBreadcrumb
                trail={buildDrillBreadcrumbs(drill.stack, nodes)}
                onJump={(depth) => {
                    if (depth === 0) drill.reset();
                    else {
                        // Pop until the desired depth (which is
                        // stack.length === depth, not depth - 1
                        // because trail[0] is the root row).
                        const popsNeeded = drill.stack.length - depth;
                        for (let i = 0; i < popsNeeded; i++) drill.exit();
                    }
                }}
            />

            {/* R31 Bundle 4 (PR 2) — the ProcessPalette moved
                from a HORIZONTAL strip across the top of the
                canvas into the VERTICAL left rail below. The
                taxonomy + drag-source contract are unchanged;
                only the LAYOUT shifted to match the universal
                design-tool vocabulary (palette on the left,
                canvas in the centre, inspector on the right).
                See the palette mount inside the body's 3-column
                row below. */}
            {/* R29 — multi-select toolbar. Renders only when ≥2
                nodes are selected; vanishes back to the natural
                palette + help-strip layout when the selection
                drops. The alignment + distribute buttons stay
                inside one slim strip rather than spawning a
                second permanent row of chrome. */}
            {/* R30 — single-group strip. Mounts when exactly one
                node is selected AND that node is a group; gives
                the user a one-click way to dissolve the group
                without trawling into a context menu. Pairs with
                the multi-select Group action below. */}
            {selectionCount === 1 &&
                selectedNode != null &&
                (selectedNode.data as { kind?: unknown })?.kind === "group" && (
                    <div
                        className="flex flex-wrap items-center gap-tight border-b border-canvas-border bg-canvas-frame px-default py-2 text-[11px]"
                        data-single-group-toolbar="true"
                    >
                        <span className="mr-1 font-semibold uppercase tracking-wider text-content-subtle">
                            {t("persistedCanvas.groupSelected")}
                        </span>
                        <button
                            type="button"
                            className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                            onClick={handleUngroup}
                            data-testid="ungroup-btn"
                            aria-label={t("persistedCanvas.ungroup")}
                            title={t("persistedCanvas.ungroup")}
                        >
                            {t("persistedCanvas.ungroup")}
                        </button>
                    </div>
                )}
            {selectionCount >= 2 && (
                <div
                    className="flex flex-wrap items-center gap-tight border-b border-canvas-border bg-canvas-frame px-default py-2 text-[11px]"
                    data-multi-select-toolbar="true"
                    data-selection-count={selectionCount}
                >
                    <span
                        className="mr-1 font-semibold uppercase tracking-wider text-content-subtle"
                        aria-label={t("persistedCanvas.nodesSelected", { count: selectionCount })}
                    >
                        {t("persistedCanvas.selectedCount", { count: selectionCount })}
                    </span>
                    <span className="mr-1 text-content-subtle">·</span>
                    <span className="text-content-muted">{t("persistedCanvas.align")}</span>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                        onClick={() => handleAlign("left")}
                        data-testid="align-left-btn"
                        aria-label={t("persistedCanvas.alignLeft")}
                        title={t("persistedCanvas.alignLeft")}
                    >
                        {t("persistedCanvas.letterL")}
                    </button>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                        onClick={() => handleAlign("center-x")}
                        data-testid="align-center-x-btn"
                        aria-label={t("persistedCanvas.alignCenterX")}
                        title={t("persistedCanvas.alignCenterX")}
                    >
                        {t("persistedCanvas.letterC")}
                    </button>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                        onClick={() => handleAlign("right")}
                        data-testid="align-right-btn"
                        aria-label={t("persistedCanvas.alignRight")}
                        title={t("persistedCanvas.alignRight")}
                    >
                        {t("persistedCanvas.letterR")}
                    </button>
                    <span className="mx-1 text-content-subtle">·</span>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                        onClick={() => handleAlign("top")}
                        data-testid="align-top-btn"
                        aria-label={t("persistedCanvas.alignTop")}
                        title={t("persistedCanvas.alignTop")}
                    >
                        {t("persistedCanvas.letterT")}
                    </button>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                        onClick={() => handleAlign("center-y")}
                        data-testid="align-center-y-btn"
                        aria-label={t("persistedCanvas.alignCenterY")}
                        title={t("persistedCanvas.alignCenterY")}
                    >
                        {t("persistedCanvas.letterM")}
                    </button>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                        onClick={() => handleAlign("bottom")}
                        data-testid="align-bottom-btn"
                        aria-label={t("persistedCanvas.alignBottom")}
                        title={t("persistedCanvas.alignBottom")}
                    >
                        {t("persistedCanvas.letterB")}
                    </button>
                    {selectionCount >= 3 && (
                        <>
                            <span className="mx-1 text-content-subtle">·</span>
                            <span className="text-content-muted">
                                {t("persistedCanvas.distribute")}
                            </span>
                            <button
                                type="button"
                                className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                                onClick={() => handleDistribute("horizontal")}
                                data-testid="distribute-h-btn"
                                aria-label={t("persistedCanvas.distributeH")}
                                title={t("persistedCanvas.distributeH")}
                            >
                                {t("persistedCanvas.letterH")}
                            </button>
                            <button
                                type="button"
                                className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis"
                                onClick={() => handleDistribute("vertical")}
                                data-testid="distribute-v-btn"
                                aria-label={t("persistedCanvas.distributeV")}
                                title={t("persistedCanvas.distributeV")}
                            >
                                {t("persistedCanvas.letterV")}
                            </button>
                        </>
                    )}
                    <span className="mx-1 text-content-subtle">·</span>
                    {/* R30 — Group selected. Refuses to nest groups
                        or to fold a node that already lives inside a
                        group; disabled state mirrors that gate.
                        R32-PR12 — explanatory <Tooltip> on the
                        disabled state surfaces WHY the button can't
                        be clicked. Per the design verdict: "never
                        let a practice fail silently". */}
                    {(() => {
                        const groupDisabled = nodes
                            .filter((n) => selectedNodeIds.includes(n.id))
                            .some(
                                (n) =>
                                    nodeParent(n) != null ||
                                    (n.data as { kind?: unknown })?.kind ===
                                        "group",
                            );
                        const groupBtn = (
                            <button
                                type="button"
                                className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-muted hover:border-border-emphasis hover:text-content-emphasis disabled:opacity-50"
                                onClick={handleGroupSelected}
                                data-testid="group-selected-btn"
                                aria-label={t("persistedCanvas.groupNodesAria")}
                                title={
                                    groupDisabled
                                        ? t("persistedCanvas.groupDisabledTitle")
                                        : t("persistedCanvas.groupSelected")
                                }
                                disabled={groupDisabled}
                            >
                                {t("persistedCanvas.groupBtn")}
                            </button>
                        );
                        return groupDisabled ? (
                            <Tooltip content={t("persistedCanvas.groupDisabledTitle")}>
                                {groupBtn}
                            </Tooltip>
                        ) : (
                            groupBtn
                        );
                    })()}
                    <span className="mx-1 text-content-subtle">·</span>
                    <button
                        type="button"
                        className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-0.5 text-content-error hover:border-border-error hover:bg-bg-error"
                        onClick={handleBulkDelete}
                        data-testid="bulk-delete-btn"
                        aria-label={t("persistedCanvas.deleteSelectedNodesAria", { count: selectionCount })}
                        title={t("persistedCanvas.deleteSelectedTitle")}
                    >
                        {tCommon("delete")}
                    </button>
                </div>
            )}
            <div className="flex flex-1 min-h-0">
                {/* R31 Bundle 4 (PR 2) — the palette as a vertical
                    left rail. Lives INSIDE the body's flex row so
                    its width is reserved alongside the canvas
                    plane and (optional) right inspector. The
                    palette → canvas → inspector eye-flow is now
                    Western-reading L→R, matching every other
                    design tool. */}
                <ProcessPalette />
                {/* The canvas plane — the recessed working surface.
                    A distinct deep token + a top inner shadow make it
                    read as sunk below the chrome: the dominant region,
                    visually separated from the frame around it. */}
                <div
                    className="relative flex-1 min-h-0 bg-canvas-surface shadow-canvas-recess"
                    onDragOver={onDragOver}
                    onDrop={onDrop}
                >
                    {showEmpty && (
                        <CanvasEmpty onNew={handleNew} creating={creating} />
                    )}
                    {!showEmpty && nodes.length === 0 && !loading && (
                        // R31 — quieter empty-but-loaded hint.
                        // Anchored to the bottom-centre instead of
                        // dead-centre so it reads as a footnote, not
                        // a competing card on top of the canvas.
                        // Disappears the moment a node lands.
                        <div
                            className="pointer-events-none absolute inset-x-0 bottom-default z-10 flex items-end justify-center"
                            data-canvas-empty-state="true"
                        >
                            <p className="text-[11px] text-content-subtle">
                                {t("persistedCanvas.dragToBegin")}
                            </p>
                        </div>
                    )}
                    {/* R31 — vignette overlay. A radial gradient that
                        darkens the canvas edges ~4% so the surface
                        reads as a "table you're working on" rather
                        than an endless plane. Pointer-events-none so
                        the canvas's pan/zoom still owns the gesture
                        layer. Behind ReactFlow children so the dot
                        grid + vignette compose visually. */}
                    <div
                        className="pointer-events-none absolute inset-0 z-[1]"
                        aria-hidden="true"
                        data-canvas-vignette="true"
                        style={{
                            background:
                                "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.04) 100%)",
                        }}
                    />
                    <ReactFlow
                        key={activeId ?? "no-map"}
                        // Two composed projections on the nodes prop:
                        // 1. Epic P6-PR-A — drill-scoped filter:
                        //    at root (currentGroupId === null) the
                        //    full graph; inside a group, just that
                        //    group's children.
                        // 2. Epic P4-PR-B — rejected-source marker:
                        //    if a connection attempt just failed,
                        //    tag the source node's className with
                        //    `canvas-rejected` so the CSS shake
                        //    rule fires. Clears after 600ms.
                        nodes={(() => {
                            const baseNodes = drill.currentGroupId
                                ? filterByDrillScope(
                                      nodes,
                                      edges,
                                      drill.currentGroupId,
                                  ).visibleNodes
                                : nodes;
                            if (!rejectedSource) return baseNodes;
                            return baseNodes.map((n) =>
                                n.id === rejectedSource
                                    ? {
                                          ...n,
                                          className:
                                              `${n.className ?? ""} canvas-rejected`.trim(),
                                      }
                                    : n,
                            );
                        })()}
                        // Synthesise a transient preview edge when
                        // the proximity hook has a live candidate.
                        // ProcessEdge reads `data.isPreview` and
                        // swaps to dashed brand stroke; the commit
                        // path strips the reserved id before
                        // persisting.
                        edges={
                            (() => {
                                const baseEdges = drill.currentGroupId
                                    ? filterByDrillScope(
                                          nodes,
                                          edges,
                                          drill.currentGroupId,
                                      ).visibleEdges
                                    : edges;
                                if (!proximity.candidate) return baseEdges;
                                return [
                                    ...baseEdges,
                                    {
                                        id: PROXIMITY_PREVIEW_ID,
                                        source: proximity.candidate.source,
                                        target: proximity.candidate.target,
                                        type: PROCESS_EDGE_TYPE,
                                        data: { isPreview: true },
                                        animated: true,
                                    },
                                ];
                            })()
                        }
                        nodeTypes={NODE_TYPES}
                        edgeTypes={EDGE_TYPES}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeDrag={proximity.onNodeDrag}
                        onNodeDragStop={proximity.onNodeDragStop}
                        // Epic P6-PR-A — double-click a group to
                        // drill into it. Other kinds ignore the
                        // event (no semantic action defined yet).
                        onNodeDoubleClick={(_, node) => {
                            const kind = (
                                node.data as { kind?: unknown } | undefined
                            )?.kind;
                            if (kind === "group") drill.enter(node.id);
                        }}
                        // R28 — connection validity. Rejects self-
                        // loops, duplicate directed pairs, and any
                        // edge touching an annotation node.
                        isValidConnection={isValidConnection}
                        // PR-A polish — `loose` mode lets the user
                        // initiate a drag from either end of a handle
                        // (target → source AND source → target), so
                        // dragging "backwards" feels right when the
                        // author retraces a connection. `isValid-
                        // Connection` above is still the authority
                        // on whether the resulting pair is allowed.
                        connectionMode={ConnectionMode.Loose}
                        // R28 — snap to grid. Toggled by the
                        // toolbar practice; persisted per tenant in
                        // localStorage. 16px grid is one Background
                        // dot step ÷ 1.5 — fine enough to feel
                        // precise, loose enough that snapping is
                        // visible.
                        snapToGrid={snapEnabled}
                        snapGrid={[16, 16]}
                        // R29 — only paint nodes within the
                        // viewport. xyflow's culling pass; pairs
                        // with the existing `memo()` on the
                        // ProcessTypedNode renderer so off-screen
                        // nodes neither mount nor re-render on
                        // every viewport tick. Keeps medium-large
                        // graphs (200+ nodes) interactive on the
                        // canvas.
                        onlyRenderVisibleElements
                        fitView
                        proOptions={{ hideAttribution: true }}
                        aria-label={t("processCanvas.ariaLabel")}
                    >
                        {/* R31 — two-layer background discipline.
                            Coarse 128px dot field at low opacity
                            anchors orientation only; the fine 16px
                            field rises in visibility only when snap
                            is engaged (gives `snapToGrid` visual
                            meaning — without this, the user has no
                            cue that the toggle is active). Both
                            quieter than R25's single dense pass. */}
                        <Background
                            id="canvas-bg-coarse"
                            variant={BackgroundVariant.Dots}
                            gap={128}
                            size={1.5}
                            color="var(--canvas-grid)"
                            style={{ opacity: 0.18 }}
                        />
                        <Background
                            id="canvas-bg-fine"
                            variant={BackgroundVariant.Dots}
                            gap={16}
                            size={1}
                            color="var(--canvas-grid)"
                            style={{ opacity: snapEnabled ? 0.4 : 0 }}
                        />
                        {/* R31 Bundle 6 (PR 7) — orientation aids.
                            Pre-R31 the canvas shipped with no zoom UI:
                            on a large process map the user couldn't
                            tell how to get back. Every canvas tool
                            that has shipped in the last 15 years has
                            +/-/fit practices.

                            xyflow's `<Controls>` primitive is the
                            canonical answer; we wrap it with a
                            token-driven surface so the overlay matches
                            the canvas frame language. The original
                            R31 Bundle 6 PR also shipped a minimap
                            in the bottom-right; user feedback
                            (2026-05-26) found it added clutter on the
                            canvas surface without earning the
                            corner-real-estate — removed.

                            Zoom-button icon + surface colours come
                            from `globals.css` `[data-process-canvas]`
                            overrides that wire xyflow's
                            `--xy-controls-button-*` cascade through
                            to the canvas-frame token suite, so the
                            buttons read on both light and dark
                            themes. */}
                        <Controls
                            position="bottom-left"
                            showInteractive={false}
                            className="!bg-canvas-frame/90 !border !border-canvas-border !rounded-[8px] !shadow-canvas-node backdrop-blur"
                            data-testid="canvas-zoom-practices"
                            aria-label={t("persistedCanvas.zoomPractices")}
                        />
                    </ReactFlow>
                </div>
                {/* R26-PR-E inspector — mounts when a node is
                    selected; hides cleanly otherwise. R28 extends
                    it to edges: an edge selection mounts the same
                    panel with label + variant fields. */}
                <ProcessInspector
                    node={selectedNode}
                    edge={selectedEdge}
                    tenantSlug={tenantSlug}
                    onUpdate={handleInspectorUpdate}
                    onEdgeUpdate={handleEdgeUpdate}
                />
                {/* Epic P5-PR-A — Version-history sidebar. Mounts
                    alongside the inspector; the AsidePanel primitive
                    handles collapse-to-spine + the `?aside` deep-
                    link so the user can toggle between Inspector
                    and Version history without re-mounting either.
                    Epic P5-PR-B wires Diff + Restore callbacks. */}
                {activeId && (
                    <CanvasHistorySidebar
                        tenantSlug={tenantSlug}
                        mapId={activeId}
                        currentVersion={loadedMap?.version ?? null}
                        onDiffRequest={setDiffAgainstVersion}
                        onRestored={() => setReloadCounter((c) => c + 1)}
                    />
                )}
                {/* Epic P5-PR-B — Diff overlay. Renders only when a
                    snapshot version is selected; fetches that
                    snapshot's graphJson and runs computeCanvasDiff
                    against the live canvas state. */}
                {activeId && diffAgainstVersion != null && loadedMap && (
                    <CanvasDiffOverlay
                        open
                        onOpenChange={(next) =>
                            setDiffAgainstVersion(next ? diffAgainstVersion : null)
                        }
                        tenantSlug={tenantSlug}
                        mapId={activeId}
                        targetVersion={diffAgainstVersion}
                        currentVersion={loadedMap.version}
                        currentSnapshot={buildLiveSnapshot(nodes, edges)}
                    />
                )}
            </div>
        </div>
        </CanvasEmphasisProvider>
    );
}

function CanvasEmpty({
    onNew,
    creating,
}: {
    onNew: () => void;
    creating: boolean;
}): ReactNode {
    const t = useTranslations("ui");
    return (
        <div
            className="absolute inset-0 z-10 flex items-center justify-center"
            data-canvas-empty="true"
        >
            <div className="flex max-w-[320px] flex-col items-center gap-default text-center">
                {/* R32-PR11 — empty-state typography voice elevated.
                    Pre-R32 the lead line whispered (`text-sm`); a
                    premium tool anchors the eye with `text-base` so
                    the voice reads with the authority of a design
                    surface. The secondary paragraph stays quiet
                    (`text-xs text-content-muted`) so the weight
                    hierarchy is explicit. */}
                <p className="text-base font-medium text-content-emphasis">
                    {t("persistedCanvas.emptyTitle")}
                </p>
                <p className="text-xs text-content-muted">
                    {t("persistedCanvas.emptyBody")}
                </p>
                <Button
                    size="sm"
                    variant="primary"
                    onClick={onNew}
                    disabled={creating}
                    data-testid="empty-state-new-btn"
                >
                    {creating ? t("processDocBar.creating") : t("persistedCanvas.createFirst")}
                </Button>
            </div>
        </div>
    );
}
