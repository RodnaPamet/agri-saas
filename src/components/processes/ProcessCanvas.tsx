"use client";

/**
 * R25-PR-B — ProcessCanvas.
 *
 * Wraps xyflow's `<ReactFlow>` with IC theming and the
 * Processes-page interaction model (drag-drop from palette,
 * pan/zoom defaults, dot-grid background). Custom node + edge
 * types arrive in PR-C/D; PR-B uses xyflow's defaults so the
 * interaction substrate is independently testable.
 *
 * Why a thin wrapper and not raw `<ReactFlow>` at the call site:
 *   - Centralises the IC theming (background color, dot-grid
 *     colour, pan-on-drag, zoom step). Drift across canvas
 *     consumers is one of xyflow's common failure modes.
 *   - Keeps the `<ReactFlowProvider>` mounting at one place so
 *     downstream hooks (`useReactFlow`, `useUpdateNodeInternals`)
 *     can be used freely by the palette / practice overlays.
 *
 * Why `'use client'` + dynamic import in the page: xyflow uses
 * browser-only APIs (ResizeObserver, getBoundingClientRect on
 * mount) — SSRing it crashes. The GraphExplorer in this repo
 * (the traceability page) sets the same boundary; pattern reused.
 */

import {
    Background,
    BackgroundVariant,
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
import { memo, useCallback, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { ProcessPalette, PALETTE_DRAG_MIME } from "./ProcessPalette";
import {
    ProcessStepNode,
    PROCESS_STEP_NODE_TYPE,
} from "./ProcessStepNode";
import {
    ProcessEdge,
    PROCESS_EDGE_TYPE,
} from "./ProcessEdge";

/**
 * R25-PR-C — custom node type registration. xyflow expects a
 * STABLE `nodeTypes` object (re-creating it on every render
 * triggers a warning + forces all nodes to remount, which would
 * lose selection / position state). Module-level so the same
 * reference is reused for every canvas mount.
 */
const NODE_TYPES: NodeTypes = {
    [PROCESS_STEP_NODE_TYPE]: ProcessStepNode,
};

/**
 * R25-PR-D — custom edge type registration. Same stable-reference
 * pattern as NODE_TYPES.
 */
const EDGE_TYPES: EdgeTypes = {
    [PROCESS_EDGE_TYPE]: ProcessEdge,
};

/**
 * Counter used to mint unique node ids on drop. Module-level so it
 * survives re-renders of the canvas; the in-memory canvas state
 * never persists across reloads anyway (per the R25 scope).
 */
let _nodeIdCounter = 1;
function mintNodeId(): string {
    return `node-${_nodeIdCounter++}`;
}

interface ProcessCanvasInnerProps {
    initialNodes?: Node[];
    initialEdges?: Edge[];
    paletteSlot?: ReactNode;
}

function ProcessCanvasInner({
    initialNodes = [],
    initialEdges = [],
    paletteSlot,
}: ProcessCanvasInnerProps) {
    const t = useTranslations("ui");
    const [nodes, setNodes] = useState<Node[]>(initialNodes);
    const [edges, setEdges] = useState<Edge[]>(initialEdges);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const { screenToFlowPosition } = useReactFlow();

    const onNodesChange = useCallback<OnNodesChange>(
        (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
        [],
    );
    const onEdgesChange = useCallback<OnEdgesChange>(
        (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
        [],
    );
    const onConnect = useCallback<OnConnect>(
        (connection: Connection) =>
            // R25-PR-D — new connections render with the custom
            // ProcessEdge (bezier stroke + optional practice-on-edge
            // overlay). Without the explicit `type`, xyflow falls
            // back to the default thin grey edge.
            setEdges((eds) =>
                addEdge({ ...connection, type: PROCESS_EDGE_TYPE }, eds),
            ),
        [],
    );

    // R25-PR-B drag-drop wiring: the palette emits an HTML5 drag
    // with the canonical PALETTE_DRAG_MIME payload; the canvas
    // accepts the drop and converts the screen position to the
    // flow position via `screenToFlowPosition` (xyflow helper that
    // accounts for current pan + zoom).
    const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    }, []);

    const onDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const payload = event.dataTransfer.getData(PALETTE_DRAG_MIME);
            if (!payload) return;
            // The palette ships just the label for now; PR-C extends
            // the payload with a typed `kind` so different process-
            // step shapes can be dragged.
            const position = screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            });
            const newNode: Node = {
                id: mintNodeId(),
                type: PROCESS_STEP_NODE_TYPE,
                position,
                data: { label: payload },
            };
            setNodes((nds) => [...nds, newNode]);
        },
        [screenToFlowPosition],
    );

    return (
        <div
            ref={wrapperRef}
            className="flex h-full w-full flex-col"
            data-process-canvas="true"
        >
            {paletteSlot}
            <div
                className="relative flex-1 min-h-0"
                onDragOver={onDragOver}
                onDrop={onDrop}
            >
                {nodes.length === 0 && (
                    // R25-PR-F — empty state. Centered, calm, single
                    // instructional sentence. Communicates the
                    // primary interaction (drag from palette) without
                    // requiring a help link or tutorial overlay. The
                    // sentence disappears as soon as the first node
                    // lands — affordances must NOT linger past the
                    // moment of need.
                    <div
                        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
                        data-canvas-empty-state="true"
                    >
                        <p className="text-sm text-content-muted">
                            {t("processCanvas.emptyDragHint")}
                        </p>
                    </div>
                )}
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={NODE_TYPES}
                    edgeTypes={EDGE_TYPES}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    fitView
                    proOptions={{ hideAttribution: true }}
                    aria-label={t("processCanvas.ariaLabel")}
                >
                    {/* IC token-aware background. Dot variant reads as
                        a calm graph-paper surface — line variant adds
                        too much visual chatter on the dark navy bg.
                        24px gap matches the existing GraphExplorer's
                        dot spacing. */}
                    <Background
                        variant={BackgroundVariant.Dots}
                        gap={24}
                        size={1.3}
                        color="var(--canvas-grid)"
                    />
                </ReactFlow>
            </div>
        </div>
    );
}

const MemoizedInner = memo(ProcessCanvasInner);

export interface ProcessCanvasProps {
    initialNodes?: Node[];
    initialEdges?: Edge[];
    /**
     * Optional palette element rendered above the canvas surface.
     * The page wires `<ProcessPalette>` here; tests can pass null
     * or a stub to isolate canvas behaviour.
     */
    paletteSlot?: ReactNode;
}

export function ProcessCanvas(props: ProcessCanvasProps) {
    // ReactFlowProvider must wrap any consumer of `useReactFlow`.
    // The page mounts this single provider at the top; downstream
    // PRs (custom nodes, practice overlays) can use the hook for
    // free.
    return (
        <ReactFlowProvider>
            <MemoizedInner {...props} />
        </ReactFlowProvider>
    );
}

export { ProcessPalette };
