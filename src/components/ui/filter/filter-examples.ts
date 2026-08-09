/**
 * Representative filter definitions for Epic 53.
 *
 * These are **reference patterns**, not production filter configs. They exist
 * so page authors have compile-checked examples of the three canonical filter
 * shapes the system supports:
 *
 *   1. enum/status filter   → `statusFilterExample`
 *   2. entity-reference    → `ownerFilterExample`
 *   3. range filter         → `scoreRangeFilterExample`
 *
 * Import into a test or playground to explore the API; do not import from
 * application code — each list page should own its own filter definitions so
 * types can flow from the page's entity shape. The barrel (`index.ts`)
 * deliberately does not re-export these symbols.
 */

import { Activity, CircleDot, User } from "lucide-react";
import type { FilterDefInput } from "./filter-definitions";
import { optionsFromEnum, typedOptionsFromEnum } from "./filter-definitions";
import type { TypedFilterOption } from "./types";

// ─── 1. Enum / status filter ─────────────────────────────────────────
//
// Mirrors Prisma's `PracticeStatus` enum. Single-select, clearable, grouped
// under "Attributes".

export type PracticeStatus =
  | "NOT_STARTED"
  | "PLANNED"
  | "IN_PROGRESS"
  | "IMPLEMENTING"
  | "IMPLEMENTED"
  | "NEEDS_REVIEW"
  | "NOT_APPLICABLE";

const CONTROL_STATUS_LABELS: Record<PracticeStatus, string> = {
  NOT_STARTED: "Not started",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  IMPLEMENTING: "Implementing",
  IMPLEMENTED: "Implemented",
  NEEDS_REVIEW: "Needs review",
  NOT_APPLICABLE: "Not applicable",
};

/** Typed options — use `typedOptionsFromEnum` when you want `V` to survive. */
export const statusTypedOptions: TypedFilterOption<PracticeStatus>[] =
  typedOptionsFromEnum(CONTROL_STATUS_LABELS);

/** Loose options for the existing component layer. */
export const statusFilterExample: FilterDefInput = {
  label: "Status",
  description: "Lifecycle stage of the practice.",
  group: "Attributes",
  icon: CircleDot,
  options: optionsFromEnum(CONTROL_STATUS_LABELS),
  resetBehavior: "clearable",
};

// ─── 2. Entity-reference filter ──────────────────────────────────────
//
// A filter whose options come from an API (list of owners). `options: null`
// is the contract the picker uses to render an async-loaded state. Multi-
// select, with the IS/IS_NOT operator exposed.

export interface OwnerReference {
  id: string;
  name: string;
  email: string;
}

export const ownerFilterExample: FilterDefInput = {
  label: "Owner",
  labelPlural: "Owners",
  description: "Person accountable for this record.",
  group: "People",
  icon: User,
  /** `null` signals the component to expect externally-loaded options. */
  options: null,
  multiple: true,
  /**
   * Disable cmdk's built-in filtering — the parent query already filters
   * server-side, so we don't want cmdk to re-filter the results.
   */
  shouldFilter: false,
  resetBehavior: "clearable",
};

/**
 * Helper page authors call once server data arrives — maps entities to the
 * shape `Filter.Select` expects. The `displayLabel` override keeps the active
 * pill readable while the picker row shows `name — email`.
 */
export function ownerOptionsFromEntities(
  owners: OwnerReference[],
): TypedFilterOption<string>[] {
  return owners.map((o) => ({
    value: o.id,
    label: `${o.name} — ${o.email}`,
    displayLabel: o.name,
  }));
}

// ─── 3. Range filter ─────────────────────────────────────────────────
//
// Min/max numeric bounds round-tripped through `encodeRangeToken` /
// `parseRangeToken`. The display is scaled — e.g. a risk score stored 0–100
// shown as 0.0–10.0. `operator` UI is hidden because range already conveys
// "between" semantics.

export const scoreRangeFilterExample: FilterDefInput = {
  label: "Risk score",
  description: "Inherent risk score, bounded 0–100.",
  group: "Quantitative",
  icon: Activity,
  options: null,
  type: "range",
  hideOperator: true,
  rangeDisplayScale: 10,
  rangeNumberStep: 0.1,
  formatRangeBound: (n) => (n / 10).toFixed(1),
  formatRangePillLabel: (token) => {
    // token format is "min|max" — matches encodeRangeToken output.
    const [min, max] = token.split("|");
    const fmt = (raw: string) => (raw === "" ? "—" : (Number(raw) / 10).toFixed(1));
    return `Score ${fmt(min)}–${fmt(max)}`;
  },
  resetBehavior: "clearable",
};

// ─── 4. Convenience bundle for tests / documentation ────────────────

export const EXAMPLE_FILTER_DEFS = {
  status: statusFilterExample,
  owner: ownerFilterExample,
  riskScore: scoreRangeFilterExample,
} as const;
