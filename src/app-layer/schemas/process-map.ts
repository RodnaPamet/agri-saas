/**
 * Roadmap-26 PR-A — Process Map Zod schemas.
 *
 * The save payload is shaped as the FULL graph (nodes + edges +
 * edge-practices) on every save. PR-A's repo layer replaces the
 * graph atomically — there's no per-row update path. This keeps
 * the contract dead simple: "the canvas state is the source of
 * truth; the server persists what the canvas hands it." When the
 * editor grows real undo-redo (PR-E), the same payload shape
 * carries.
 *
 * Why full-graph replace (not row-level updates):
 *   • Frontend already owns canonical state via xyflow's
 *     setNodes / setEdges. Per-row PATCH endpoints would create
 *     a second source of truth (the server's row-level state)
 *     that drifts every time the user reorders / re-positions
 *     without saving.
 *   • The graph is bounded (a process map is meant to fit on
 *     a screen — dozens of nodes, not thousands). The all-rows
 *     PUT cost is fine.
 *   • Audit log carries one entry per save instead of N row
 *     updates; the audit story stays readable.
 *
 * PR-E will likely add an optimistic-concurrency check on the
 * `version` field — the column is already there, just not
 * enforced yet at the repo layer.
 */
// The EXTENDED zod, required by `schema-openapi-zod-import` once anything in
// this file calls `.openapi()` — which #3080 does, to document the process-map
// routes against the schemas their handlers actually parse.
import { z } from '@/lib/openapi/zod';

// ─── Lifecycle status ──────────────────────────────────────────────

export const ProcessMapStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export type ProcessMapStatusValue = z.infer<typeof ProcessMapStatusSchema>;

// ─── Graph rows ────────────────────────────────────────────────────

/**
 * Per-node payload sent up on save. The frontend mints `nodeKey`
 * (e.g. "node-1") and the server persists it verbatim so the round-
 * trip is round-trip-stable for selection state.
 */
export const ProcessNodeInputSchema = z.object({
    nodeKey: z.string().min(1).max(128),
    nodeType: z.string().min(1).max(64),
    label: z.string().max(200),
    subtitle: z.string().max(200).optional().nullable(),
    posX: z.number().finite(),
    posY: z.number().finite(),
    // R30 — optional parent group reference. References another node's
    // `nodeKey` in the same map. The structural validator on the repo
    // layer rejects unknown `parentNodeKey` values; a self-reference
    // (parentNodeKey === own nodeKey) is rejected explicitly.
    parentNodeKey: z.string().max(128).optional().nullable(),
    dataJson: z.unknown().optional().nullable(),
});
export type ProcessNodeInput = z.infer<typeof ProcessNodeInputSchema>;

export const ProcessEdgeInputSchema = z.object({
    edgeKey: z.string().min(1).max(128),
    sourceKey: z.string().min(1).max(128),
    targetKey: z.string().min(1).max(128),
    edgeKind: z.string().min(1).max(64).default('flow'),
    labelOverride: z.string().max(200).optional().nullable(),
    dataJson: z.unknown().optional().nullable(),
    practices: z
        .array(
            z.object({
                practiceKey: z.string().min(1).max(128),
                label: z.string().max(200),
                dataJson: z.unknown().optional().nullable(),
            }),
        )
        .max(64)
        .optional()
        .default([]),
});
export type ProcessEdgeInput = z.infer<typeof ProcessEdgeInputSchema>;

// ─── Endpoint payloads ─────────────────────────────────────────────

export const CreateProcessMapSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
    status: ProcessMapStatusSchema.optional(),
    // VR-2 — DOCUMENT (default) vs AUTOMATION (visual rule editor).
    canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']).optional().openapi({
        description: 'Defaults to `DOCUMENT`. `AUTOMATION` is the visual rule editor.',
    }),
}).openapi('ProcessMapCreateRequest', {
    description:
        'Create a process map. Metadata only — the graph arrives through the full-graph '
        + 'PUT, so a new map starts empty.',
});
export type CreateProcessMapInput = z.infer<typeof CreateProcessMapSchema>;

/**
 * Save payload. Carries metadata edits AND the full graph.
 *
 * `expectedVersion` — optimistic-concurrency guard (Epic P1).
 * When the client sends a version, the repo refuses the write if
 * the server's current version doesn't match — the route returns
 * HTTP 409 + `{ code: 'STALE_DATA', details: { currentVersion } }`.
 * Older clients that omit `expectedVersion` get last-write-wins
 * semantics (no breaking change) — the canvas client always sends
 * it now.
 */
export const SaveProcessMapSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    status: ProcessMapStatusSchema.optional(),
    expectedVersion: z.number().int().min(1).optional().openapi({
        description:
            'OPTIMISTIC CONCURRENCY. The version the client believes is current; the '
            + 'repository refuses the write if the stored map has moved on. OPTIONAL, so '
            + 'omitting it saves unconditionally and will silently overwrite a concurrent '
            + 'edit — send it.',
    }),
    nodes: z.array(ProcessNodeInputSchema).max(500).openapi({
        description:
            'The WHOLE graph, every save. There is no per-node update path: the repository '
            + 'replaces the graph atomically, so a save omitting a node DELETES it. The '
            + 'canvas state is the source of truth and the server persists what it is '
            + 'handed.',
    }),
    edges: z.array(ProcessEdgeInputSchema).max(1000).openapi({
        description: 'The whole edge set, with the same replace-not-merge semantics as `nodes`.',
    }),
}).openapi('ProcessMapSaveRequest', {
    description:
        'Replace a process map\'s graph. A full-graph PUT rather than a patch — see '
        + '`nodes`.',
});

/**
 * The three bodies below were route-local until #3080, which made them dual
 * declarations the moment their paths were documented
 * (`request-body-declared-once`, cap zero). They live here beside the two
 * above rather than in `src/lib/schemas/`, because this is the domain's own
 * schema module and the create/save pair already did.
 */
export const PatchProcessMapSchema = z.object({
    canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']).openapi({
        description:
            'Which editor the map opens in. `AUTOMATION` is the mode whose canvas syncs '
            + 'to automation rules; `DOCUMENT` is the drawing surface.',
    }),
}).openapi('ProcessMapCanvasModeRequest', {
    description:
        'A METADATA-only mode switch — it saves no graph, which is why it is a PATCH '
        + 'beside the full-graph PUT.',
});

export const RestoreProcessMapSnapshotSchema = z.object({
    expectedVersion: z.number().int().min(1).openapi({
        description:
            'The version the client believes is CURRENT — not the version being restored, '
            + 'which is in the path. Forwarded to the same optimistic-concurrency check a '
            + 'save uses, so a restore cannot clobber an edit made while the history '
            + 'sidebar was open. REQUIRED here, unlike on a save.',
    }),
}).openapi('ProcessMapRestoreRequest');

export const ProcessMapPdfExportSchema = z.object({
    pngDataUrl: z
        .string()
        .startsWith('data:image/png;base64,')
        .min('data:image/png;base64,'.length + 16)
        .openapi({
            description:
                'The canvas, rendered to a PNG data URL BY THE CLIENT. The server only '
                + 'wraps it in a branded PDF — it does not draw the graph, so what you '
                + 'send is what prints. The prefix is enforced, and a payload shorter than '
                + 'the prefix plus 16 bytes is refused as empty.',
        }),
}).openapi('ProcessMapPdfExportRequest', {
    description:
        'Wrap a client-rendered canvas PNG in a branded PDF. Persists nothing — the PDF '
        + 'is streamed back.',
});
export type SaveProcessMapInput = z.infer<typeof SaveProcessMapSchema>;
