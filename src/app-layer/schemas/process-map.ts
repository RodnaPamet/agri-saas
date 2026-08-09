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
import { z } from 'zod';

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
                practiceId: z.string().optional().nullable(),
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
    canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']).optional(),
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
    expectedVersion: z.number().int().min(1).optional(),
    nodes: z.array(ProcessNodeInputSchema).max(500),
    edges: z.array(ProcessEdgeInputSchema).max(1000),
});
export type SaveProcessMapInput = z.infer<typeof SaveProcessMapSchema>;
