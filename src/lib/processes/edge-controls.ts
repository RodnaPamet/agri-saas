"use client";

/**
 * Epic P2-PR-A — Edge-attached control serialisation helpers.
 *
 * Lives alongside the canvas (rather than inside it) so the
 * R32-PR10 file-size floor on `PersistedProcessCanvas.tsx`
 * (≤1900 lines) keeps holding as the canvas absorbs more feature
 * work. The two helpers are isomorphic — both peel the same shape
 * off `edge.data.controls` — they differ only in what they
 * synthesise for omitted fields (the inspector's
 * `EdgeControlRef` and the wire shape both work, but the wire
 * shape needs a `dataJson: null` slot too).
 */
import type { Edge } from "@xyflow/react";

export interface EdgeControlWire {
    controlKey: string;
    label: string;
    controlId: string | null;
    dataJson: null;
}

/**
 * Read the canonical control list off an xyflow edge's
 * `data.controls` for save serialisation. Tolerant of pre-P2
 * edges whose data omits the array.
 */
export function edgeControlsForSave(e: Edge): EdgeControlWire[] {
    const raw = (e.data as { controls?: unknown } | undefined)?.controls;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r) => {
            // A null/non-object entry can only come from partially-written
            // or hand-edited graph JSON, but this helper's whole job is to
            // be tolerant of that — and it runs on the SAVE path, so
            // throwing here would block the user from persisting the map.
            if (r === null || typeof r !== "object") return null;
            const row = r as {
                controlKey?: unknown;
                label?: unknown;
                controlId?: unknown;
            };
            if (typeof row.controlKey !== "string") return null;
            return {
                controlKey: row.controlKey,
                label:
                    typeof row.label === "string" ? row.label : row.controlKey,
                controlId:
                    typeof row.controlId === "string" ? row.controlId : null,
                dataJson: null,
            } satisfies EdgeControlWire;
        })
        .filter((r): r is EdgeControlWire => r !== null);
}
