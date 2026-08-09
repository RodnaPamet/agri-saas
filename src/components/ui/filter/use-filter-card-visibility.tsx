'use client';

/**
 * useFilterCardVisibility — the "Edit filter cards" gear's state (2026-06-07).
 *
 * Mirrors `useColumnsDropdown`'s contract but for the toolbar's FILTER
 * cards (and, by design, any future card that wants to live in the same
 * gear). Owns the click-to-order + visibility state, persists it to
 * localStorage under `inflect:filter-vis:<entity>`, and returns a ready
 * `<EditFiltersButton>` plus the ordered visible cards.
 *
 *   const cards = useMemo(() => filtersToCards(liveFilterDefs), [liveFilterDefs]);
 *   const { visibleCards, dropdown: filterGear } =
 *     useFilterCardVisibility({ storageKey: 'inflect:filter-vis:practices', cards });
 *   const visibleFilters = useMemo(
 *     () => selectVisibleFilters(visibleCards, liveFilterDefs), [...]);
 *   // <EntityListPage filters={{ defs: visibleFilters, toolbarActions: <>{filterGear}{columnsGear}</> }} />
 *
 * EXTENSIBILITY (P4): the hook is keyed on a discriminated
 * `CardDefinition[]`, not raw `FilterType[]`. Only `kind: 'filter'` is
 * wired into the toolbar today; `kpi` / `preset` / `scope` are typed
 * forward-compat extension points — a KPI summary card, a saved-filter
 * preset chip, or a date-range scope can register here later and be
 * shown/hidden from the SAME gear popover, with the page reading
 * `visibleCards.filter(c => c.kind === 'kpi')` etc.
 */
import {
    createElement,
    isValidElement,
    useCallback,
    useMemo,
    type ComponentType,
    type ReactNode,
    type SVGProps,
} from 'react';
import { useLocalStorage } from '@/components/ui/hooks';
import {
    buildChecklistItems,
    defaultOrder,
    isModifiedFromDefault,
    reconcileOrder,
    reorderOrder,
    toggleOrder,
} from '@/components/ui/checklist-order';
import { EditFiltersButton } from './edit-filters-button';
import type { Filter as FilterType } from './types';

/** Discriminator for the cards a filter gear can practice. */
export type CardKind = 'filter' | 'kpi' | 'preset' | 'scope';

export interface CardDefinition {
    /** Unique key — used for localStorage persistence + checklist rows. */
    id: string;
    /** Shown in the checklist. */
    label: string;
    /** Shown in the checklist row. */
    icon?: ReactNode;
    /** Defaults to `true` — set `false` for opt-in cards. */
    defaultVisible?: boolean;
    /** Extensible discriminator; only `'filter'` is wired today. */
    kind: CardKind;
}

export interface UseFilterCardVisibilityOptions {
    /** Convention: `'inflect:filter-vis:<entity>'`. */
    storageKey: string;
    cards: CardDefinition[];
}

export interface UseFilterCardVisibilityResult {
    /** Visible cards, in left-to-right order. */
    visibleCards: CardDefinition[];
    /** Pre-rendered gear — drop into the toolbar actions slot. */
    dropdown: ReactNode;
}

/**
 * Render a `FilterIcon` to a node for the checklist. FilterIcon is a union
 * of three shapes and each needs different handling:
 *   - an already-created element (`<Foo/>`)        → use as-is
 *   - a COMPONENT TYPE: a function component OR a forwardRef/memo object
 *     (lucide icons are forwardRef — `{$$typeof, render, displayName}`,
 *     NOT a plain function), which must be INSTANTIATED, else React throws
 *     #31 ("objects are not valid as a React child")
 *   - a plain node (string/number)                 → use as-is
 */
function renderFilterIcon(icon: FilterType['icon']): ReactNode {
    if (icon == null) return undefined;
    if (isValidElement(icon)) return icon;
    const isComponentType =
        typeof icon === 'function' ||
        (typeof icon === 'object' && '$$typeof' in (icon as object));
    if (isComponentType) {
        return createElement(
            icon as ComponentType<SVGProps<SVGSVGElement>>,
            { className: 'h-3.5 w-3.5' },
        );
    }
    return icon as ReactNode;
}

/** Map a page's `FilterType[]` into `kind: 'filter'` card definitions. */
export function filtersToCards(filters: FilterType[]): CardDefinition[] {
    return filters.map((f) => ({
        id: f.key,
        label: f.label,
        icon: renderFilterIcon(f.icon),
        kind: 'filter' as const,
    }));
}

/**
 * Project the gear's ordered visible cards back onto the page's filter
 * defs — the `FilterType[]` (in order) to pass to `<FilterToolbar filters>`.
 */
export function selectVisibleFilters(
    visibleCards: CardDefinition[],
    allFilters: FilterType[],
): FilterType[] {
    const byKey = new Map(allFilters.map((f) => [f.key, f]));
    return visibleCards
        .filter((c) => c.kind === 'filter')
        .map((c) => byKey.get(c.id))
        .filter((f): f is FilterType => Boolean(f));
}

export function useFilterCardVisibility({
    storageKey,
    cards,
}: UseFilterCardVisibilityOptions): UseFilterCardVisibilityResult {
    const defaultVisibleDefs = useMemo(
        () => cards.filter((c) => c.defaultVisible !== false),
        [cards],
    );
    const defaults = useMemo(
        () => defaultOrder(defaultVisibleDefs),
        [defaultVisibleDefs],
    );

    const [stored, setStored] = useLocalStorage<string[]>(storageKey, defaults);
    const order = useMemo(() => {
        const reconciled = reconcileOrder(stored, defaultVisibleDefs);
        // Stale-data migration: if a NON-empty persisted order had ALL of
        // its ids dropped (the gear's cards changed identity — e.g. filter
        // categories → KPI cards under the same storage key), fall back to
        // defaults rather than rendering an empty card set. A genuinely
        // empty `stored` (user hid everything) is respected.
        if (
            reconciled.length === 0 &&
            Array.isArray(stored) &&
            stored.length > 0
        ) {
            return defaults;
        }
        return reconciled;
    }, [stored, defaultVisibleDefs, defaults]);

    const cardById = useMemo(
        () => new Map(cards.map((c) => [c.id, c])),
        [cards],
    );
    const visibleCards = useMemo(
        () =>
            order
                .map((id) => cardById.get(id))
                .filter((c): c is CardDefinition => Boolean(c)),
        [order, cardById],
    );
    const items = useMemo(
        () => buildChecklistItems(cards, order),
        [cards, order],
    );
    const someModified = useMemo(
        () => isModifiedFromDefault(order, defaults),
        [order, defaults],
    );

    const onToggle = useCallback(
        (id: string) =>
            setStored((prev) =>
                toggleOrder(reconcileOrder(prev, defaultVisibleDefs), id),
            ),
        [setStored, defaultVisibleDefs],
    );
    const onReset = useCallback(() => setStored(defaults), [setStored, defaults]);
    const onReorder = useCallback(
        (fromId: string, toId: string) =>
            setStored((prev) =>
                reorderOrder(
                    reconcileOrder(prev, defaultVisibleDefs),
                    fromId,
                    toId,
                ),
            ),
        [setStored, defaultVisibleDefs],
    );

    const dropdown = (
        <EditFiltersButton
            items={items}
            onToggle={onToggle}
            onReset={onReset}
            onReorder={onReorder}
            someModified={someModified}
        />
    );

    return { visibleCards, dropdown };
}
