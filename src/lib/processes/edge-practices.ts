"use client";

/**
 * Epic P2-PR-A — Edge-attached practice serialisation helpers.
 *
 * Lives alongside the canvas (rather than inside it) so the
 * R32-PR10 file-size floor on `PersistedProcessCanvas.tsx`
 * (≤1900 lines) keeps holding as the canvas absorbs more feature
 * work. The two helpers are isomorphic — both peel the same shape
 * off `edge.data.practices` — they differ only in what they
 * synthesise for omitted fields (the inspector's
 * `EdgePracticeRef` and the wire shape both work, but the wire
 * shape needs a `dataJson: null` slot too).
 */
import type { Edge } from "@xyflow/react";

export interface EdgePracticeWire {
    practiceKey: string;
    label: string;
    dataJson: null;
}

/**
 * Read the canonical practice list off an xyflow edge's
 * `data.practices` for save serialisation. Tolerant of pre-P2
 * edges whose data omits the array.
 */
export function edgePracticesForSave(e: Edge): EdgePracticeWire[] {
    const raw = (e.data as { practices?: unknown } | undefined)?.practices;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r) => {
            // A null/non-object entry can only come from partially-written
            // or hand-edited graph JSON, but this helper's whole job is to
            // be tolerant of that — and it runs on the SAVE path, so
            // throwing here would block the user from persisting the map.
            if (r === null || typeof r !== "object") return null;
            const row = r as {
                practiceKey?: unknown;
                label?: unknown;
            };
            if (typeof row.practiceKey !== "string") return null;
            return {
                practiceKey: row.practiceKey,
                label:
                    typeof row.label === "string" ? row.label : row.practiceKey,
                dataJson: null,
            } satisfies EdgePracticeWire;
        })
        .filter((r): r is EdgePracticeWire => r !== null);
}
