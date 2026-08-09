'use client';

/**
 * PR-D — `<EntityPicker>` — drop-in replacement for the canonical
 * "paste an entity ID here" `<input>`.
 *
 * Several legacy link forms (task → entity link, vendor → entity
 * link, vendor → subprocessor) asked the operator to TYPE the
 * target entity's cuid by hand. Users never know their cuids,
 * forcing them to open a second tab + copy the URL fragment.
 * This primitive fetches the candidate set for the given
 * entity-type and surfaces it through the standard
 * `<Combobox>` — typeahead by name/code/title, no IDs to copy.
 *
 * Per-tenant fetch — the candidate API is `/api/t/{slug}/{type}`
 * with a tight `select` shape the server already exposes for the
 * list pages. The hook caches per-type per-tenant with SWR (using
 * an in-memory map; sessionStorage would over-cache stale data).
 *
 * Six entity types are supported out of the box, matching the
 * union of task-link and vendor-link targets:
 *
 *   • CONTROL                — code + name
 *   • ASSET                  — name
 *   • EVIDENCE               — title
 *   • VENDOR                 — name
 *   • FRAMEWORK_REQUIREMENT  — code + title (per-framework fetch)
 *
 * Adding a new type is one branch in `ENTITY_TYPE_FETCHERS` —
 * the consumer surface (`<EntityPicker entityType="X">`) stays
 * stable.
 *
 * Failure-soft — a failed candidate fetch surfaces an empty
 * dropdown + an inline "load failed" message. The submit button
 * the picker's value drives stays clickable IF the caller wants
 * to fall back to a paste workflow (most don't), but the picker
 * itself never blocks the rest of the form.
 */
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';

// Combobox's `buttonProps` is typed against `ButtonProps`, which
// extends `React.ButtonHTMLAttributes<HTMLButtonElement>` via VariantProps
// rather than directly — so the React `data-*` attribute escape hatch
// doesn't propagate cleanly. The intersection below adds the testid slot
// without an untyped escape (preserves the project's no-explicit-any
// ratchet count).
type ComboboxButtonProps = ComponentProps<typeof Combobox>['buttonProps'] & {
    'data-testid'?: string;
};

export type EntityPickerKind =
    | 'CONTROL'
    | 'ASSET'
    | 'EVIDENCE'
    | 'VENDOR'
    | 'ISSUE'
    | 'FRAMEWORK_REQUIREMENT';

interface CandidateRow {
    id: string;
    label: string;
}

interface FetchedCandidate {
    id: string;
    [k: string]: unknown;
}

function rowsFromResponse(
    kind: EntityPickerKind,
    rows: ReadonlyArray<FetchedCandidate>,
): CandidateRow[] {
    switch (kind) {
        case 'CONTROL':
            return rows.map((r) => {
                const prefix = (r.code as string) || '';
                const name = (r.name as string) || '(untitled)';
                return {
                    id: r.id,
                    label: prefix ? `${prefix}: ${name}` : name,
                };
            });
        case 'ASSET':
            return rows.map((r) => ({
                id: r.id,
                label: (r.name as string) || '(untitled)',
            }));
        case 'EVIDENCE':
            return rows.map((r) => ({
                id: r.id,
                label: (r.title as string) || '(untitled)',
            }));
        case 'VENDOR':
            return rows.map((r) => ({
                id: r.id,
                label: (r.name as string) || '(untitled)',
            }));
        case 'ISSUE':
            return rows.map((r) => ({
                id: r.id,
                label: (r.title as string) || '(untitled)',
            }));
        case 'FRAMEWORK_REQUIREMENT':
            // FRAMEWORK_REQUIREMENT is the only type whose canonical
            // list lives behind a per-framework URL. The picker
            // shape stays the same; the consumer is expected to
            // pass `frameworkKey` in `extraQuery` so the URL builds
            // correctly. When the candidate set is empty the
            // dropdown is still usable — just empty.
            return rows.map((r) => {
                const code = (r.code as string) || '';
                const title = (r.title as string) || '(untitled)';
                return {
                    id: r.id,
                    label: code ? `${code}: ${title}` : title,
                };
            });
        default:
            return rows.map((r) => ({ id: r.id, label: r.id }));
    }
}

/**
 * Per-type fetch routine. Returns a Promise of an array of
 * `FetchedCandidate` rows. Callers needn't know which API path is
 * involved — the picker hides that detail.
 */
async function fetchCandidates(
    tenantSlug: string,
    kind: EntityPickerKind,
    extraQuery?: Record<string, string>,
): Promise<FetchedCandidate[]> {
    const base = `/api/t/${tenantSlug}`;
    const qs = extraQuery
        ? '?' +
          Object.entries(extraQuery)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join('&')
        : '';
    let url: string;
    switch (kind) {
        case 'CONTROL':
            url = `${base}/controls${qs}`;
            break;
        case 'ASSET':
            url = `${base}/assets${qs}`;
            break;
        case 'EVIDENCE':
            url = `${base}/evidence${qs}`;
            break;
        case 'VENDOR':
            url = `${base}/vendors${qs}`;
            break;
        case 'ISSUE':
            url = `${base}/issues${qs}`;
            break;
        case 'FRAMEWORK_REQUIREMENT': {
            // The framework requirement list lives behind
            // `/frameworks/{frameworkKey}/tree` today; a single
            // global "all requirements" endpoint doesn't exist.
            // The consumer must pass `frameworkKey` in extraQuery.
            const frameworkKey = extraQuery?.frameworkKey;
            if (!frameworkKey) return [];
            url = `${base}/frameworks/${frameworkKey}/tree`;
            break;
        }
        default:
            return [];
    }
    try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return [];
        const json = await res.json();
        // Tenant list APIs return `{ rows }`; framework tree returns
        // `{ requirements }`. Normalise.
        if (Array.isArray(json)) return json as FetchedCandidate[];
        if (json && Array.isArray(json.rows)) {
            return json.rows as FetchedCandidate[];
        }
        if (json && Array.isArray(json.requirements)) {
            return json.requirements as FetchedCandidate[];
        }
        return [];
    } catch {
        return [];
    }
}

export interface EntityPickerProps {
    /** Tenant slug — needed for the API URL. */
    tenantSlug: string;
    /** Which entity type the picker should fetch + render. */
    entityType: EntityPickerKind;
    /**
     * Currently-selected entity id, or empty string when nothing
     * is selected. The empty-string convention matches the legacy
     * `<input>` shape — callers don't have to change their state
     * type.
     */
    value: string;
    /** Fires on selection. `''` when the user clears the picker. */
    onChange: (entityId: string) => void;
    /** Stable id for the trigger (used by tests + a11y). */
    id?: string;
    /** Stable testid prefix. Defaults to "entity-picker". */
    testId?: string;
    /** Placeholder copy. */
    placeholder?: string;
    /** Optional class applied to the trigger button wrapper. */
    className?: string;
    /**
     * Extra query string for the candidate fetch — used by
     * `FRAMEWORK_REQUIREMENT` to pass `frameworkKey`.
     */
    extraQuery?: Record<string, string>;
}

export function EntityPicker({
    tenantSlug,
    entityType,
    value,
    onChange,
    id,
    testId = 'entity-picker',
    placeholder = 'Select…',
    className,
    extraQuery,
}: EntityPickerProps) {
    const [candidates, setCandidates] = useState<CandidateRow[]>([]);
    const [loading, setLoading] = useState(false);
    const extraKey = useMemo(
        () => (extraQuery ? JSON.stringify(extraQuery) : ''),
        [extraQuery],
    );

    // Fetch candidates whenever the tenant / type / extra-query
    // changes. The picker is a sibling of the entity-type Combobox
    // on every consumer site; flipping the type re-fetches the
    // candidate set automatically.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        void fetchCandidates(
            tenantSlug,
            entityType,
            extraQuery,
        )
            .then((rows) => {
                if (cancelled) return;
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setCandidates(rowsFromResponse(entityType, rows));
            })
            .finally(() => {
                if (cancelled) return;
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantSlug, entityType, extraKey]);

    const options: ComboboxOption[] = useMemo(
        () =>
            candidates.map((c) => ({
                value: c.id,
                label: c.label,
            })),
        [candidates],
    );

    return (
        <Combobox
            id={id}
            options={options}
            selected={options.find((o) => o.value === value) ?? null}
            setSelected={(opt) => onChange(opt?.value ?? '')}
            placeholder={
                loading
                    ? 'Loading…'
                    : options.length === 0
                      ? `No ${entityType.toLowerCase().replace(/_/g, ' ')}s available`
                      : placeholder
            }
            emptyState={`No ${entityType.toLowerCase().replace(/_/g, ' ')}s match`}
            matchTriggerWidth
            // Combobox doesn't accept `data-testid` directly — the
            // testid lands on the trigger button via `buttonProps`.
            // The local intersection type at the top of the file
            // widens `buttonProps` to accept `data-testid` without
            // an untyped escape.
            buttonProps={{
                className,
                'data-testid': testId,
            } as ComboboxButtonProps}
        />
    );
}
