/**
 * Column visibility utilities — pure functions for computing visibility state.
 *
 * These are framework-agnostic and can be used by both the `useColumnVisibility`
 * hook and direct DataTable integration. They are fully testable without React.
 */

import { VisibilityState } from "@tanstack/react-table";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Configuration for a single table's column visibility.
 * Used to define which columns exist and which are visible by default.
 *
 * Usage:
 *   const config: ColumnVisibilityConfig = {
 *     all: ["code", "name", "status", "owner", "updatedAt"],
 *     defaultVisible: ["code", "name", "status"],
 *     fixed: ["code"],  // optional: can't be hidden
 *   };
 */
export interface ColumnVisibilityConfig {
  /** All column IDs that participate in visibility toggling. */
  all: string[];

  /** Column IDs visible by default. */
  defaultVisible: string[];

  /**
   * Column IDs that cannot be hidden (always visible).
   * These will be forced to `true` regardless of user preference.
   */
  fixed?: string[];
}

// ── Storage Key ─────────────────────────────────────────────────────

/** Standard prefix for column visibility localStorage keys. */
export const COLUMN_VISIBILITY_PREFIX = "inflect:col-vis:";

/**
 * Build a localStorage key for a table's column visibility.
 *
 * @param tableId - Unique identifier for the table (e.g., "practices", "risks").
 */
export function getVisibilityStorageKey(tableId: string): string {
  return `${COLUMN_VISIBILITY_PREFIX}${tableId}`;
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Create the default VisibilityState from a config.
 *
 * All columns in `config.all` are included; those in `defaultVisible`
 * (and `fixed`) are set to `true`, all others to `false`.
 */
export function getDefaultVisibility(config: ColumnVisibilityConfig): VisibilityState {
  const fixedSet = new Set(config.fixed ?? []);
  const defaultSet = new Set(config.defaultVisible);

  return Object.fromEntries(
    config.all.map((id) => [id, defaultSet.has(id) || fixedSet.has(id)]),
  );
}

/**
 * Merge a saved/user visibility state with the config.
 *
 * - Columns in `config.fixed` are always forced to `true`.
 * - Unknown columns in saved state (e.g., removed columns) are ignored.
 * - New columns not in saved state get their default visibility.
 *
 * This handles schema evolution gracefully — columns can be added or
 * removed without corrupting persisted preferences.
 */
export function mergeVisibility(
  saved: VisibilityState | null | undefined,
  config: ColumnVisibilityConfig,
): VisibilityState {
  const defaults = getDefaultVisibility(config);

  if (!saved) return defaults;

  const fixedSet = new Set(config.fixed ?? []);

  return Object.fromEntries(
    config.all.map((id) => {
      // Fixed columns are always visible
      if (fixedSet.has(id)) return [id, true];
      // Use saved value if it exists for this column
      if (id in saved) return [id, saved[id]];
      // Fall back to default for new/unknown columns
      return [id, defaults[id] ?? false];
    }),
  );
}

/**
 * Count visible and hidden columns from a visibility state.
 */
export function countVisibility(state: VisibilityState): {
  visible: number;
  hidden: number;
  total: number;
} {
  const entries = Object.values(state);
  const visible = entries.filter(Boolean).length;
  return {
    visible,
    hidden: entries.length - visible,
    total: entries.length,
  };
}

/**
 * Check if any columns are hidden from their defaults.
 */
export function hasCustomVisibility(
  current: VisibilityState,
  config: ColumnVisibilityConfig,
): boolean {
  const defaults = getDefaultVisibility(config);
  return config.all.some((id) => (current[id] ?? true) !== (defaults[id] ?? true));
}

/**
 * Read persisted visibility from localStorage (SSR-safe).
 */
export function readPersistedVisibility(tableId: string): VisibilityState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(getVisibilityStorageKey(tableId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as VisibilityState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write visibility state to localStorage (SSR-safe).
 */
export function writePersistedVisibility(
  tableId: string,
  state: VisibilityState,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      getVisibilityStorageKey(tableId),
      JSON.stringify(state),
    );
  } catch {
    // Silently ignore quota errors
  }
}

/**
 * Clear persisted visibility for a table (SSR-safe).
 */
export function clearPersistedVisibility(tableId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(getVisibilityStorageKey(tableId));
  } catch {
    // Silently ignore
  }
}
