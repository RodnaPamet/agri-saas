/**
 * Epic 46 — Framework Viewer (TreeView foundation).
 *
 * Typed hierarchical contract for framework data. Shared by:
 *   - the API route (server-side serialization)
 *   - the framework tree builder (pure, deterministic)
 *   - the TreeView UI primitives (when wired into the framework page in
 *     a later prompt)
 *
 * The contract is INTENTIONALLY narrow at this layer — the generic
 * `TreeView<T>` component takes its own broader interface
 * (`TreeViewNode`) so it can be reused for non-framework hierarchies
 * (asset trees, org charts, taxonomy editors). `FrameworkTreeNode`
 * extends that contract with the framework-specific fields.
 */

// ─── Node kinds ────────────────────────────────────────────────────────

/**
 * The two structural roles a node can play in the framework tree.
 *
 *   - `section`  — synthesized grouping (theme, regulation article,
 *                  code-prefix bucket). Has no row in
 *                  `FrameworkRequirement`. Cannot be selected as a
 *                  requirement target — it only acts as a visual
 *                  container.
 *   - `requirement` — a real `FrameworkRequirement` row. The ones at
 *                  greater depth are CHILDREN of other requirements
 *                  whose `code` is a strict dotted prefix
 *                  (e.g. `5.1.2` is a child of `5.1`).
 */
export type FrameworkTreeNodeKind = 'section' | 'requirement';

// ─── Compliance status ─────────────────────────────────────────────────

/**
 * Per-node compliance state.
 *
 * Sourced from authoritative backend data
 * (`PracticeRequirementLink` join + `Practice.status` +
 * `Practice.applicability`) and computed server-side by
 * `computeNodeComplianceStatus`. The frontend never recomputes —
 * it just renders.
 *
 *   - `compliant` — every applicable mapped practice is IMPLEMENTED.
 *   - `partial`   — some but not all applicable mapped practices are
 *                   IMPLEMENTED (work in progress).
 *   - `gap`       — there are no mapped practices, OR none of the
 *                   applicable ones are IMPLEMENTED.
 *   - `na`        — every mapped practice is NOT_APPLICABLE
 *                   (deliberate scope-out, not a gap).
 *   - `unknown`   — the framework has been loaded without coverage
 *                   data (rare; render as neutral).
 *
 * Sections aggregate their descendants per the rules in
 * `aggregateComplianceStatus`.
 */
export type ComplianceStatus = 'compliant' | 'partial' | 'gap' | 'na' | 'unknown';

// ─── Tree-node contract ────────────────────────────────────────────────

/**
 * One node in the framework tree.
 *
 * Sections are synthesized — their `id` is prefixed `section:` so
 * routing/selection callers can differentiate without inspecting
 * `kind`. Requirement IDs are the real `FrameworkRequirement.id`.
 */
export interface FrameworkTreeNode {
    /**
     * Stable id. Section ids are synthesized as
     * `section:<frameworkId>:<sectionLabel>`; requirement ids are the
     * underlying `FrameworkRequirement.id` (cuid). Stability matters:
     * the TreeView keys expansion + selection state by id, so a
     * non-deterministic id would reset state on every fetch.
     */
    id: string;
    kind: FrameworkTreeNodeKind;
    /** Short display label — section name, or requirement code (e.g. `A.5.1`). */
    label: string;
    /** Long display label — section name, or requirement title. */
    title: string;
    description?: string | null;
    /** Requirement code (only set for `kind === 'requirement'`). */
    code?: string;
    /**
     * For requirements: the original sortOrder from the schema, so
     * sibling ordering in the tree matches the framework's intent
     * (which is rarely lexicographic — `5.10` should sort after
     * `5.9`, not before).
     */
    sortOrder?: number;
    /**
     * Recursive child count INCLUDING transitively-nested
     * requirements. Used for badges next to section nodes
     * (`Organizational (37)`).
     */
    descendantCount: number;
    /**
     * Direct child count (one level down). Useful for UI affordances
     * that don't want to recurse.
     */
    childCount: number;
    /**
     * Server-computed compliance status for this node. Set on
     * requirements from `PracticeRequirementLink` data; aggregated
     * upward to sections. Absent (or `unknown`) when the tree was
     * built without coverage context — the explorer falls back to
     * the cheaper mapped/unmapped indicator in that case.
     */
    complianceStatus?: ComplianceStatus;
    /**
     * Per-status counts for descendant requirements. Sections use
     * this for the minimap mini-distribution bar; requirements
     * report their own one-element distribution. Only populated
     * when `complianceStatus` is set.
     */
    statusCounts?: {
        compliant: number;
        partial: number;
        gap: number;
        na: number;
        unknown: number;
    };
    /**
     * `true` iff this node has children to render. Always derivable
     * from `children.length > 0` for non-lazy trees, but stored as a
     * separate field so future lazy-loading variants (where
     * `children` may be empty until expansion) work without breaking
     * the contract.
     */
    hasChildren: boolean;
    children: FrameworkTreeNode[];
}

// ─── Top-level payload ─────────────────────────────────────────────────

/**
 * Wire shape returned by `GET /api/t/[tenantSlug]/frameworks/[frameworkKey]/tree`.
 *
 * Carries the framework descriptor alongside the nodes so a single
 * fetch is enough to render the page header + tree without a second
 * round-trip.
 */
export interface FrameworkTreePayload {
    framework: {
        id: string;
        key: string;
        name: string;
        version: string | null;
        kind: string;
        description: string | null;
    };
    nodes: FrameworkTreeNode[];
    totals: {
        sections: number;
        requirements: number;
        /** Maximum nesting depth observed (1 = flat list under sections). */
        maxDepth: number;
    };
}

// ─── Generic TreeView contract ─────────────────────────────────────────

/**
 * Minimum shape the generic `<TreeView>` component requires of a
 * node. Caller's domain model (e.g. `FrameworkTreeNode`) must
 * structurally satisfy this — they do, by construction.
 *
 * Non-framework trees (assets, org chart, practice taxonomy) can use
 * `TreeView` directly as long as they fulfil this contract.
 */
export interface TreeViewNode {
    id: string;
    children?: readonly TreeViewNode[];
    hasChildren?: boolean;
}
