/**
 * Epic 53 — Evidence list page filter configuration.
 *
 * URL-synchronised filter defs backing the Evidence toolbar. Keys align 1:1
 * with `EvidenceQuerySchema`:
 *
 *   q          → free-text search (`useFilterContext`'s search slot)
 *   type       → EvidenceType (FILE | LINK | TEXT)
 *   status     → EvidenceStatus (DRAFT | SUBMITTED | APPROVED | REJECTED)
 *   controlId  → entity-reference (Control ID; options derived from loaded data)
 *
 * Retention buckets (`archived=true` / `expiring=true`) are *not* modelled
 * here — they're driven by the existing retention-tab UI (`tab=active|
 * expiring|archived`) and mapped to API flags in the page. Keeping them
 * outside the filter config preserves the separation between "view of the
 * data" (tabs) and "filters on the view" (this module).
 */

import type {
    FilterDefInput,
} from '@/components/ui/filter/filter-definitions';
import {
    createTypedFilterDefs,
    optionsFromEnum,
} from '@/components/ui/filter/filter-definitions';
import type { FilterOption } from '@/components/ui/filter/types';
import { FileText, CircleDot, Link2, FolderOpen } from 'lucide-react';

// ─── Static labels ──────────────────────────────────────────────────

export const EVIDENCE_TYPE_LABELS = {
    FILE: 'File',
    LINK: 'Link',
    TEXT: 'Text',
} as const;

export const EVIDENCE_STATUS_LABELS = {
    DRAFT: 'Draft',
    SUBMITTED: 'Submitted',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
} as const;

// ─── Static filter definitions ──────────────────────────────────────

const STATIC_DEFS = {
    type: {
        label: 'Type',
        description: 'File / link / text evidence.',
        group: 'Attributes',
        icon: FileText,
        options: optionsFromEnum(EVIDENCE_TYPE_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    status: {
        label: 'Review status',
        description: 'Position in the evidence review workflow.',
        group: 'Workflow',
        icon: CircleDot,
        options: optionsFromEnum(EVIDENCE_STATUS_LABELS),
        multiple: true,
        resetBehavior: 'clearable',
    },
    controlId: {
        label: 'Linked control',
        description: 'Only show evidence attached to this control.',
        group: 'Linked',
        icon: Link2,
        options: null, // filled at render time from the controls prop
        shouldFilter: true,
        resetBehavior: 'clearable',
    },
    // B8 follow-up — Folder filter. Options are derived at render
    // time from the folders present in the currently-loaded
    // evidence rows (plus a "No folder" pseudo-bucket when any
    // unfoldered row exists). The `__none__` sentinel matches
    // null/empty folders so legacy unfoldered evidence stays
    // findable after rollout.
    folder: {
        label: 'Folder',
        description: 'Organisational folder label.',
        group: 'Attributes',
        icon: FolderOpen,
        options: null, // filled at render time from loaded evidence
        shouldFilter: true,
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const evidenceFilterDefs = createTypedFilterDefs()(STATIC_DEFS);

export const EVIDENCE_FILTER_KEYS = evidenceFilterDefs.filterKeys;

// ─── Runtime option builder ─────────────────────────────────────────

interface ControlLike {
    id: string;
    name: string;
    code?: string | null;
}

/**
 * Build Control options from the list loaded server-side. The filter row
 * displays `{ code }: name` to match the pattern used elsewhere on
 * Evidence pages, while the pill text (displayLabel) stays short.
 */
export function controlOptionsFromControls(
    controls: ReadonlyArray<ControlLike>,
): FilterOption[] {
    const seen = new Map<string, FilterOption>();
    for (const c of controls) {
        if (!c.id || seen.has(c.id)) continue;
        const prefix = c.code || '';
        seen.set(c.id, {
            value: c.id,
            label: prefix ? `${prefix}: ${c.name}` : c.name,
            displayLabel: prefix || c.name,
        });
    }
    return Array.from(seen.values()).sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}

/**
 * B8 follow-up — build the Folder filter's options from whatever
 * is currently loaded. A `__none__` pseudo-option matches rows
 * with a null/empty folder, so legacy unfoldered evidence stays
 * findable after rollout.
 */
export interface EvidenceFolderLike {
    folder?: string | null;
}

export function folderOptionsFromEvidence(
    evidence: ReadonlyArray<EvidenceFolderLike>,
): FilterOption[] {
    const present = new Set<string>();
    let hasUnfoldered = false;
    for (const e of evidence) {
        const f = (e.folder || '').trim();
        if (f) present.add(f);
        else hasUnfoldered = true;
    }
    const out: FilterOption[] = [];
    if (hasUnfoldered) {
        out.push({ value: '__none__', label: 'No folder' });
    }
    for (const f of Array.from(present).sort()) {
        out.push({ value: f, label: f });
    }
    return out;
}

export function buildEvidenceFilters(
    controls: ReadonlyArray<ControlLike>,
    evidence: ReadonlyArray<EvidenceFolderLike> = [],
) {
    const controlOpts = controlOptionsFromControls(controls);
    const folderOpts = folderOptionsFromEvidence(evidence);
    return evidenceFilterDefs.filters.map((f) => {
        if (f.key === 'controlId') return { ...f, options: controlOpts };
        if (f.key === 'folder') return { ...f, options: folderOpts };
        return f;
    });
}
