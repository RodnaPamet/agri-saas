"use client";

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * <AsyncCombobox> — debounced async-search wrapper around <Combobox>.
 *
 * Combobox already supports loading/onSearchChange/shouldFilter, but
 * wiring debounce + abort + race-resolution at every call site is
 * boilerplate. UserCombobox (`user-combobox.tsx`) solved this for the
 * tenant-members case via React Query; AsyncCombobox generalises the
 * pattern to any source — search-by-name on Controls, Risks, Vendors,
 * Tags, Frameworks, etc.
 *
 * What it adds over Combobox:
 *
 *   - `onSearch(query, signal)` — fires after a 250ms debounce. Each
 *     search aborts the previous via AbortController, so a fast typer
 *     never sees stale results race in.
 *   - Internal options + loading state — caller doesn't need to manage
 *     either. The component owns the lifecycle.
 *   - Initial fetch on open with an empty query (so the dropdown is
 *     populated even before the user types).
 *   - Selected option preservation — `value` (single) or `values`
 *     (multi) is the source of truth; the component keeps the matching
 *     option in view even when subsequent searches don't return it.
 *
 * What it inherits unchanged from Combobox:
 *
 *   - Multi-select via the `multiple` discriminator
 *   - onCreate passthrough for create-new flows
 *   - Full a11y / FormField wiring (id/name/aria-*)
 *   - Keyboard nav, popover positioning, mobile drawer
 */

import { useTranslations } from "next-intl";
import * as React from "react";
import { Combobox, type ComboboxOption } from "./combobox";

// ─── Public option shape ──────────────────────────────────────────────

export type AsyncOption<TMeta = unknown> = ComboboxOption<TMeta>;

// ─── Shared props ─────────────────────────────────────────────────────

interface AsyncBaseProps<TMeta> {
    /**
     * Search function. Called after debounce with the current query +
     * an AbortSignal that fires when a newer query supersedes this one.
     * Implementations should pass `signal` through to fetch.
     */
    onSearch: (
        query: string,
        signal: AbortSignal,
    ) => Promise<AsyncOption<TMeta>[]>;
    /** Debounce window in ms. Default: 250. */
    debounceMs?: number;
    /** Initial options shown before the first search resolves. */
    initialOptions?: AsyncOption<TMeta>[];

    // ── Combobox passthrough ─────────────────────────────────────────
    id?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    invalid?: boolean;
    /**
     * Id of the element holding the visible label. `<FormField>`
     * injects its `<Label>` id here; Combobox prefers it over its
     * selected-text fallback so the trigger's accessible name stays
     * stable across a selection change.
     */
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    placeholder?: React.ReactNode;
    searchPlaceholder?: string;
    emptyState?: React.ReactNode;
    className?: string;
    forceDropdown?: boolean;
    matchTriggerWidth?: boolean;

    // ── Create-new flow ──────────────────────────────────────────────
    /** When set, an "Create '<query>'" affordance appears in the list. */
    onCreate?: (search: string) => Promise<boolean>;
    createLabel?: (search: string) => React.ReactNode;
}

interface AsyncSingleProps<TMeta> extends AsyncBaseProps<TMeta> {
    multiple?: false;
    /** Selected value (option `value`). */
    value: string | null;
    /** Caller receives the option (may be null). */
    onChange: (option: AsyncOption<TMeta> | null) => void;
}

interface AsyncMultipleProps<TMeta> extends AsyncBaseProps<TMeta> {
    multiple: true;
    values: string[];
    onChange: (options: AsyncOption<TMeta>[]) => void;
    maxSelected?: number;
}

export type AsyncComboboxProps<TMeta = unknown> =
    | AsyncSingleProps<TMeta>
    | AsyncMultipleProps<TMeta>;

// ─── Hook — debounced + aborted search ───────────────────────────────

export function useAsyncSearch<TMeta>(
    onSearch: (
        query: string,
        signal: AbortSignal,
    ) => Promise<AsyncOption<TMeta>[]>,
    debounceMs: number,
    initial: AsyncOption<TMeta>[] | undefined,
) {
    const [query, setQuery] = React.useState("");
    const [options, setOptions] = React.useState<AsyncOption<TMeta>[]>(
        initial ?? [],
    );
    const [isLoading, setIsLoading] = React.useState(false);

    // Pin the latest onSearch in a ref so the debounce effect doesn't
    // re-run on every parent render (caller usually inlines a closure).
    const searchRef = React.useRef(onSearch);
    React.useEffect(() => {
        searchRef.current = onSearch;
    }, [onSearch]);

    React.useEffect(() => {
        const controller = new AbortController();
        const handle = window.setTimeout(() => {
            setIsLoading(true);
            searchRef
                .current(query, controller.signal)
                .then((results) => {
                    if (!controller.signal.aborted) {
                        setOptions(results);
                        setIsLoading(false);
                    }
                })
                .catch((err: unknown) => {
                    // AbortError is the expected outcome of a superseded
                    // search; swallow it. Anything else, surface as
                    // "no results" — the caller's onSearch is responsible
                    // for surfacing user-facing errors via toast/log.
                    if (
                        controller.signal.aborted ||
                        (err instanceof DOMException &&
                            err.name === "AbortError")
                    ) {
                        return;
                    }
                    if (!controller.signal.aborted) {
                        setOptions([]);
                        setIsLoading(false);
                    }
                });
        }, debounceMs);
        return () => {
            window.clearTimeout(handle);
            controller.abort();
        };
    }, [query, debounceMs]);

    return { query, setQuery, options, isLoading };
}

// ─── Component ───────────────────────────────────────────────────────

export function AsyncCombobox<TMeta = unknown>(
    props: AsyncComboboxProps<TMeta>,
) {
    const t = useTranslations("ui");
    const {
        onSearch,
        debounceMs = 250,
        initialOptions,
        id,
        name,
        disabled,
        required,
        invalid,
        placeholder = t("combobox.placeholder"),
        searchPlaceholder = t("combobox.searchPlaceholder"),
        emptyState = t("asyncCombobox.emptyState"),
        className,
        forceDropdown = true,
        matchTriggerWidth = true,
        onCreate,
        createLabel,
    } = props;
    const ariaLabelledBy = props["aria-labelledby"];
    const ariaDescribedBy = props["aria-describedby"];

    // ── Selected-option cache ────────────────────────────────────────
    // The async search may not return the currently-selected option in
    // its result set (user typed past it). Keep a per-component cache
    // so the trigger always renders the right label.
    const [selectedCache, setSelectedCache] = React.useState<
        Map<string, AsyncOption<TMeta>>
    >(new Map());

    const cacheOption = React.useCallback(
        (opt: AsyncOption<TMeta> | null | undefined) => {
            if (!opt) return;
            setSelectedCache((prev) => {
                if (prev.has(opt.value)) return prev;
                const next = new Map(prev);
                next.set(opt.value, opt);
                return next;
            });
        },
        [],
    );

    const { setQuery, options, isLoading } = useAsyncSearch<TMeta>(
        onSearch,
        debounceMs,
        initialOptions,
    );

    // Cache freshly-arrived options so we can re-derive the selected
    // option later if it scrolls out of the result set.
    React.useEffect(() => {
        if (!options.length) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedCache((prev) => {
            let next = prev;
            for (const opt of options) {
                if (!next.has(opt.value)) {
                    if (next === prev) next = new Map(prev);
                    next.set(opt.value, opt);
                }
            }
            return next;
        });
    }, [options]);

    // ── Branch on multi vs single ────────────────────────────────────

    if (props.multiple) {
        const { values, onChange, maxSelected } = props;
        const selectedOptions: AsyncOption<TMeta>[] = values
            .map((v) => selectedCache.get(v))
            .filter((o): o is AsyncOption<TMeta> => Boolean(o));

        return (
            <Combobox<true, TMeta>
                multiple
                id={id}
                name={name}
                disabled={disabled}
                required={required}
                invalid={invalid}
                aria-labelledby={ariaLabelledBy}
                aria-describedby={ariaDescribedBy}
                options={options}
                shouldFilter={false}
                onSearchChange={setQuery}
                loading={isLoading}
                selected={selectedOptions}
                setSelected={(opts) => {
                    for (const o of opts) cacheOption(o);
                    onChange(opts);
                }}
                maxSelected={maxSelected}
                placeholder={placeholder}
                searchPlaceholder={searchPlaceholder}
                emptyState={emptyState}
                forceDropdown={forceDropdown}
                matchTriggerWidth={matchTriggerWidth}
                buttonProps={{ className: className ?? "w-full" }}
                onCreate={onCreate}
                createLabel={createLabel}
                caret
            />
        );
    }

    const { value, onChange } = props;
    const selected: AsyncOption<TMeta> | null = value
        ? selectedCache.get(value) ?? null
        : null;

    return (
        <Combobox<false, TMeta>
            id={id}
            name={name}
            disabled={disabled}
            required={required}
            invalid={invalid}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={ariaDescribedBy}
            options={options}
            shouldFilter={false}
            onSearchChange={setQuery}
            loading={isLoading}
            selected={selected}
            setSelected={(opt) => {
                cacheOption(opt);
                onChange(opt);
            }}
            placeholder={placeholder}
            searchPlaceholder={searchPlaceholder}
            emptyState={emptyState}
            forceDropdown={forceDropdown}
            matchTriggerWidth={matchTriggerWidth}
            buttonProps={{ className: className ?? "w-full" }}
            onCreate={onCreate}
            createLabel={createLabel}
            caret
        />
    );
}
