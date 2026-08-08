/**
 * Roadmap-26 PR-B — Process Canvas node taxonomy.
 *
 * R25 shipped exactly one node type — `processStep`. That's
 * adequate for a proof-of-concept canvas but not for a real
 * business/IT process-mapping surface: you can't tell decision
 * points apart from steps, can't anchor governance context on
 * the map, can't drop annotations.
 *
 * This file is the single source of truth for the seven canonical
 * node kinds, the rationale for each, and the visual + interaction
 * metadata that the palette + the typed-node renderer consume.
 *
 * The seven kinds + their justifications:
 *
 *   1. `processStep` — an operational activity in the flow.
 *      The atom. Every other kind exists to give a step
 *      context.
 *   2. `decision` — a branch point. Diamond shape is the
 *      universal symbol for "the flow forks here"; without
 *      this, branches collapse into ambiguous step-to-step
 *      lines and the reader has to infer where the choice
 *      lives.
 *   3. `control` — a governance/control element ATTACHED to
 *      a step. PR-D makes controls primarily edge-mounted
 *      (control sits on the connection between two steps),
 *      but a control NODE remains useful for controls that
 *      gate a step in place (e.g. dual-approval at a single
 *      action) or for documenting orphan controls during
 *      authoring before the edge is drawn.
 *   4. `asset` — the system / datastore / document a step
 *      acts upon. One node type covers all three because
 *      IC's data model already groups them under a single
 *      Asset entity with a typed `assetType` field; the
 *      canvas inherits that grouping.
 *   5. `external` — an external party (vendor, customer,
 *      regulator) involved in the flow. Dashed border is the
 *      universal "outside the org" signal. Distinguishes
 *      "step we do" from "step they do" without forcing the
 *      reader to read every label.
 *   6. `annotation` — a free-text note. No flow semantics
 *      (no handles), borderless, italic. Lets authors leave
 *      reviewer prompts / open questions on the canvas
 *      without polluting the actual graph.
 *
 * Kinds DELIBERATELY omitted (and why):
 *
 *   • `system` / `datastore` / `document` as separate kinds
 *     — these are subtypes of Asset. The Asset domain model
 *     already encodes them via `assetType`; reintroducing
 *     them at the canvas layer would create two taxonomies
 *     that drift. Future per-asset-type visual variants can
 *     ride on the node's `dataJson.assetType` slot without
 *     a new top-level kind.
 *
 *   • `start` / `end` markers — adds two more nodes for a
 *     concept (graph endpoints) the reader infers naturally
 *     from "the leftmost node" / "the rightmost node". The
 *     industry consensus (BPMN excluded) has moved away from
 *     dedicated start/end shapes for lightweight authoring
 *     surfaces.
 *
 *   • `event` / `signal` / `timer` — BPMN-style event
 *     primitives. Adds twelve concepts for one or two
 *     genuine use cases; out of scope for the IC product.
 */

import type { LucideIcon } from 'lucide-react';
import {
    Box,
    FileText,
    GitBranch,
    Globe,
    ShieldCheck,
    StickyNote,
    Group as GroupIcon,
    // VR-1 — automation node kinds.
    Zap,
    Filter,
    Play,
    Timer,
} from 'lucide-react';

export type ProcessNodeKind =
    | 'processStep'
    | 'decision'
    | 'control'
    | 'asset'
    | 'external'
    | 'annotation'
    | 'group'
    // VR-1 — automation node kinds (visible only in AUTOMATION canvas mode).
    | 'trigger'
    | 'condition'
    | 'action'
    | 'slaGate';

/**
 * Visual-language accents. Each maps to an IC semantic colour
 * token at render time so a future theme swap (Roadmap-19/24-style
 * carbon → glass) flips every node kind in lockstep without per-
 * node edits.
 */
export type NodeAccent =
    | 'brand'           // process step (default — quiet, primary surface)
    | 'brand-secondary' // control (the flag's white family — was navy/blue)
    | 'warning'         // slaGate (amber — caution without alarm)
    | 'success'         // asset (calm green — "here is data")
    | 'neutral'         // decision (graphite — structural)
    | 'subtle';         // external + annotation (lowest visual weight)

/**
 * Shape vocabulary — TWO SHAPES, mapping to eight KINDS (R31
 * retired the diamond). Limiting the shape language keeps the
 * canvas from looking like a sticker sheet. The accent + icon +
 * a per-kind corner sticker do the per-kind work.
 *
 * Pre-R31 the vocabulary was three (rect / diamond / note);
 * the diamond was a BPMN-text-2004 vocabulary lift that
 * disambiguated decision nodes via 45°-rotated geometry. Modern
 * design tools converge on icon + label as the discriminator
 * for branch points; the diamond's only signal was "we are
 * formal", which is the WRONG signal for a process design tool.
 */
export type NodeShape = 'rect' | 'note';

/**
 * R26-PR-D — semantic category. The three categories communicate
 * the node's RELATIONSHIP to the flow, not its shape:
 *
 *   flow     — the node IS part of the operational flow
 *              (processStep, decision). Solid surface.
 *   context  — the node DECORATES the flow with governance /
 *              asset / external context. Slightly muted
 *              surface so the eye reads "this is here to
 *              annotate the flow, not be part of it."
 *   note     — pure-text annotation (no flow semantics at all).
 *              Sticker tone.
 *
 * The category drives a subtle render-time variation (surface
 * opacity, drop-shadow strength) in the typed-node renderer.
 * The accent / icon / shape still do the per-kind work — the
 * category is the SECOND-order distinction the eye picks up
 * without needing to read every label.
 */
export type NodeCategory = 'flow' | 'context' | 'note' | 'group';

export interface NodeTypeMeta {
    /** Canonical kind id (persisted in `ProcessNode.nodeType`). */
    id: ProcessNodeKind;
    /** Palette label. */
    label: string;
    /** Palette tooltip / inspector description. */
    description: string;
    /** Decorative icon. Pure visual signal; not the accessible name. */
    icon: LucideIcon;
    accent: NodeAccent;
    shape: NodeShape;
    /**
     * R26-PR-D — semantic category. Drives a second-order visual
     * variation (surface opacity) so the eye distinguishes
     * flow-line-bearing nodes from contextual decorators without
     * having to read every label.
     */
    category: NodeCategory;
    /**
     * Whether the kind participates in the graph as a source /
     * target of edges. Annotation is the only kind without
     * handles — it floats free of the flow.
     */
    hasHandles: boolean;
    /**
     * Default placeholder label rendered when the user drops a
     * new node without typing one. Per-kind so a fresh control
     * doesn't say "Untitled step".
     */
    defaultLabel: string;
}

export const NODE_TAXONOMY: Record<ProcessNodeKind, NodeTypeMeta> = {
    processStep: {
        id: 'processStep',
        label: 'Process step',
        description: 'An operational activity in the flow.',
        icon: Box,
        accent: 'brand',
        shape: 'rect',
        category: 'flow',
        hasHandles: true,
        defaultLabel: 'Untitled step',
    },
    decision: {
        id: 'decision',
        label: 'Decision',
        description: 'A branch point where the flow forks.',
        icon: GitBranch,
        accent: 'neutral',
        // R31 — retired the diamond. The 45°-rotated square was a
        // BPMN vocabulary lift; modern design tools (Linear,
        // Notion, Figma, Excalidraw) read flow branches via icon +
        // category, not divergent geometry. The branch-icon
        // GitBranch + the decision-corner sticker (rendered by
        // ProcessTypedNode) carry the per-kind difference now.
        shape: 'rect',
        category: 'flow',
        hasHandles: true,
        defaultLabel: 'Decision?',
    },
    control: {
        id: 'control',
        label: 'Control',
        description:
            'A governance / control element. Canonically edge-mounted (R26-PR-D); the node kind remains for legacy maps.',
        icon: ShieldCheck,
        accent: 'brand-secondary',
        shape: 'rect',
        category: 'context',
        hasHandles: true,
        defaultLabel: 'Control',
    },
    asset: {
        id: 'asset',
        label: 'Asset',
        description:
            'A system, datastore, or document a step acts upon. Context, not flow.',
        icon: FileText,
        accent: 'success',
        shape: 'rect',
        category: 'context',
        hasHandles: true,
        defaultLabel: 'Asset',
    },
    external: {
        id: 'external',
        label: 'External party',
        description: 'A vendor, customer, or regulator involved in the flow.',
        icon: Globe,
        accent: 'subtle',
        shape: 'rect',
        category: 'context',
        hasHandles: true,
        defaultLabel: 'External party',
    },
    annotation: {
        id: 'annotation',
        label: 'Annotation',
        description: 'A free-text note. No flow semantics.',
        icon: StickyNote,
        accent: 'subtle',
        shape: 'note',
        category: 'note',
        hasHandles: false,
        defaultLabel: 'Note',
    },
    group: {
        id: 'group',
        label: 'Group',
        description:
            'A labelled container that bundles steps under one heading.',
        icon: GroupIcon,
        accent: 'subtle',
        shape: 'rect',
        // R30 — `group` is a new category that the typed-node
        // renderer uses to opt into the translucent container
        // treatment (larger default size, lower opacity, dashed
        // border, brand-coloured label strip). xyflow honours
        // parent/child layout when child nodes carry `parentId`
        // pointing at the group; the persistence layer carries
        // `parentNodeKey` for the round-trip.
        category: 'group',
        // Groups don't carry edges. Connections flow into / out of
        // children inside the group, not the group itself.
        hasHandles: false,
        defaultLabel: 'Group',
    },
    // ─── VR-1 — Automation kinds (AUTOMATION canvas mode only) ───
    trigger: {
        id: 'trigger',
        label: 'Trigger',
        description: 'Entry point — the domain event that fires the rule.',
        icon: Zap,
        accent: 'brand',
        shape: 'rect',
        category: 'flow',
        hasHandles: true,
        defaultLabel: 'When…',
    },
    condition: {
        id: 'condition',
        label: 'Condition',
        description: 'Filter gate — passes or blocks based on a DSL expression.',
        icon: Filter,
        accent: 'neutral',
        shape: 'rect',
        category: 'flow',
        hasHandles: true,
        defaultLabel: 'If…',
    },
    action: {
        id: 'action',
        label: 'Action',
        description: 'Leaf — runs Notify / Create task / Update status / Webhook.',
        icon: Play,
        accent: 'brand-secondary',
        shape: 'rect',
        category: 'flow',
        hasHandles: true,
        defaultLabel: 'Then…',
    },
    slaGate: {
        id: 'slaGate',
        label: 'SLA gate',
        description: 'SLA timer — blocks the chain until a deadline or breaches.',
        icon: Timer,
        accent: 'warning',
        shape: 'rect',
        category: 'flow',
        hasHandles: true,
        defaultLabel: 'SLA',
    },
};

/**
 * Ordered taxonomy — drives the palette's left-to-right layout.
 *
 * R26-PR-D dropped `control` from this list. Controls are now
 * canonically edge-mounted (drag onto a connection between two
 * steps), not standalone nodes hanging in space. The taxonomy
 * entry stays in `NODE_TAXONOMY` so legacy map data carrying
 * `nodeType: 'control'` still rehydrates correctly, but the
 * palette never offers it as a primary affordance. The "Add
 * control" button on the edge selection is the canonical entry
 * point.
 *
 * Order otherwise: flow primitives (step + decision) first; then
 * the two context kinds (asset + external); then the
 * annotation last. Reading left to right, the palette communicates
 * "build the flow → layer the context → leave a note".
 */
export const NODE_TAXONOMY_ORDER: ProcessNodeKind[] = [
    'processStep',
    'decision',
    'asset',
    'external',
    'group',
    'annotation',
];

/**
 * VR-1 — automation palette order. Kept separate from
 * `NODE_TAXONOMY_ORDER` so automation kinds never leak into the
 * DOCUMENT-mode palette; `ProcessPalette` renders this as its own
 * "Automation" section ONLY when `canvasMode === 'AUTOMATION'` (VR-2).
 */
export const AUTOMATION_NODE_ORDER: ProcessNodeKind[] = [
    'trigger',
    'condition',
    'action',
    'slaGate',
];

/** The four automation kinds, for mode-gating + guards. */
export const AUTOMATION_NODE_KINDS: ReadonlyArray<ProcessNodeKind> =
    AUTOMATION_NODE_ORDER;

export function isAutomationNodeKind(value: unknown): value is ProcessNodeKind {
    return (
        typeof value === 'string' &&
        (AUTOMATION_NODE_KINDS as readonly string[]).includes(value)
    );
}

/**
 * Type-guard for runtime payloads. `nodeType` on persisted rows
 * is `String` (not the enum) because the column is forward-
 * compatible with kinds we haven't designed yet. This guard
 * catches unknown kinds at the render boundary so we can fall
 * back to `processStep` instead of crashing the canvas.
 */
export function isProcessNodeKind(value: unknown): value is ProcessNodeKind {
    return (
        typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(NODE_TAXONOMY, value)
    );
}

/**
 * Accent → Tailwind class fragments. One small lookup so the
 * typed-node renderer doesn't carry a per-accent switch.
 *
 * Each value is composed at render time with the chassis classes;
 * keep it as fragments (not full strings) so future PRs can swap
 * the chassis without rewriting the accent table.
 */
export const NODE_ACCENT_BORDER: Record<NodeAccent, string> = {
    brand: 'border-border-subtle',
    'brand-secondary':
        'border-[color:var(--brand-secondary-muted,var(--brand-secondary-default))]',
    warning: 'border-[color:var(--content-warning)]',
    success: 'border-[color:var(--content-success)]',
    neutral: 'border-border-default',
    // R31 — retired the dashed treatment. The dashed border on
    // `external` + `annotation` competed with the proximity-bind
    // preview edge (R26-PR-C — animated dashed brand stroke for
    // in-flight connections), creating two unrelated visual
    // languages that both said "tentative". `external` now uses
    // the same quiet solid border as every other rect; the
    // per-kind signal moves into the corner sticker rendered by
    // ProcessTypedNode. `annotation` already uses the `note`
    // shape with its own sticker tone.
    subtle: 'border-border-subtle',
};

export const NODE_ACCENT_ICON_TONE: Record<NodeAccent, string> = {
    brand: 'text-content-emphasis',
    'brand-secondary': 'text-[color:var(--brand-secondary-default)]',
    warning: 'text-[color:var(--content-warning)]',
    success: 'text-[color:var(--content-success)]',
    neutral: 'text-content-muted',
    subtle: 'text-content-subtle',
};
