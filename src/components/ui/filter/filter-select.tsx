'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
import { cn } from "@/lib/cn";
import { truncate } from "@/lib/text-utils";
import { useTranslations } from "next-intl";
import { Command, useCommandState } from "cmdk";
import { ChevronDown, ListFilter } from "lucide-react";
import {
  Fragment,
  PropsWithChildren,
  ReactNode,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatedSizeContainer } from "../animated-size-container";
import { useKeyboardShortcut, useMediaQuery } from "../hooks";
import { Check, LoadingSpinner, Magic } from "../icons";
import { Popover } from "../popover";
import { FilterDateRangePanel } from "./filter-date-range-panel";
import { FilterRangePanel } from "./filter-range-panel";
import { FilterScroll } from "./filter-scroll";
import {
  activeRangeTokenFor,
  hasAppliedRange,
  isOptionSelectedIn,
  isSingleSelect,
  rangeTokenIsComplete,
  resolveEmptyStateFor,
} from "./filter-select-utils";
import {
  ActiveFilterInput,
  Filter,
  FilterOption,
  isRangeType,
} from "./types";

type FilterSelectProps = {
  filters: Filter[];
  onSelect: (
    key: string,
    value: FilterOption["value"] | FilterOption["value"][],
  ) => void;
  onRemove: (key: string, value: FilterOption["value"]) => void;
  /** Clears an entire filter (e.g. numeric range with two URL params). */
  onRemoveFilter?: (key: string) => void;
  onOpenFilter?: (key: string) => void;
  onSearchChange?: (search: string) => void;
  onSelectedFilterChange?: (key: string | null) => void;
  activeFilters?: ActiveFilterInput[];
  askAI?: boolean;
  isAdvancedFilter?: boolean;
  /**
   * When set, the top-level search input becomes a LIVE content search
   * (its text is forwarded via `onSearchChange`, seeded from `searchValue`,
   * and the filter categories stay listed below it) instead of a
   * category-narrowing box. This is the seam FilterToolbar uses so a page's
   * free-text search lives inside the filter dropdown — no separate bar.
   */
  searchPlaceholder?: string;
  /** Committed content query — seeds + re-syncs the top-level search input. */
  searchValue?: string;
  /** DOM id for the top-level search input (content-search mode). */
  searchId?: string;
  children?: ReactNode;
  emptyState?: ReactNode | Record<string, ReactNode>;
  className?: string;
};

export function FilterSelect({
  filters,
  onSelect,
  onRemove,
  onRemoveFilter,
  onOpenFilter,
  onSearchChange,
  onSelectedFilterChange,
  activeFilters,
  askAI,
  isAdvancedFilter = false,
  searchPlaceholder,
  searchValue,
  searchId,
  children,
  emptyState,
  className,
}: FilterSelectProps) {
  const t = useTranslations("ui.filter");
  const { isMobile } = useMediaQuery();

  // Content-search mode: the top-level input is a live free-text search
  // (its text drives the table query) rather than a category-narrowing box.
  const contentSearch = Boolean(searchPlaceholder);
  const searchValueRef = useRef(searchValue ?? "");
  useEffect(() => {
    searchValueRef.current = searchValue ?? "";
  }, [searchValue]);

  // Track main list container/dimensions to maintain size for loading spinner
  const listContainer = useRef<HTMLDivElement>(null);
  const listDimensions = useRef<{
    width: number;
    height: number;
  }>(undefined);

  const [isOpen, setIsOpen] = useState(false);

  // Epic 57 — `F` on any list page opens the first FilterSelect
  // trigger. The hook blocks the shortcut inside text inputs and any
  // open overlay automatically; `enabled: !isOpen` keeps a no-op press
  // from stealing keyboard focus while the filter panel is already
  // mounted. `scope: 'global'` is explicit (default) so the palette
  // can surface this as an app-wide binding.
  useKeyboardShortcut("f", () => setIsOpen(true), {
    enabled: !isOpen,
    scope: "global",
    description: "Open filters",
  });

  const [search, setSearch] = useState(
    contentSearch ? (searchValue ?? "") : "",
  );
  const [selectedFilterKey, setSelectedFilterKey] = useState<
    Filter["key"] | null
  >(null);

  // Returning to the top level (or closing the popover) restores the search
  // box to the committed content query rather than clearing it — so a live
  // content search survives close/reopen instead of being wiped. In the
  // classic category-only mode it clears to empty as before.
  const reset = useCallback(() => {
    setSearch(contentSearch ? searchValueRef.current : "");
    setSelectedFilterKey(null);
  }, [contentSearch]);

  const goBackOrClose = useCallback(() => {
    selectedFilterKey ? reset() : setIsOpen(false);
  }, [selectedFilterKey, reset]);

  // Reset state when closed
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isOpen) reset();
  }, [isOpen]);

  // The currently selected filter to display options for
  const selectedFilter = selectedFilterKey
    ? filters.find(({ key }) => key === selectedFilterKey)
    : null;

  const activeRangeTokenForSelected = useMemo(
    () => activeRangeTokenFor(selectedFilter, activeFilters),
    [activeFilters, selectedFilter],
  );

  const rangeFilterHasAppliedValue = useMemo(() => {
    if (!selectedFilter || !isRangeType(selectedFilter.type)) return false;
    return hasAppliedRange(activeRangeTokenForSelected);
  }, [selectedFilter, activeRangeTokenForSelected]);

  // Both token-valued panels clear and apply identically — the token IS the
  // whole value, so there is nothing kind-specific left to do by the time it
  // reaches here. Defined once so the two branches cannot drift.
  const rangePanelClear = useMemo(() => {
    if (!rangeFilterHasAppliedValue || !selectedFilterKey) return undefined;
    return () =>
      onRemoveFilter
        ? onRemoveFilter(selectedFilterKey)
        : onRemove(selectedFilterKey, activeRangeTokenForSelected ?? "|");
  }, [
    rangeFilterHasAppliedValue,
    selectedFilterKey,
    onRemoveFilter,
    onRemove,
    activeRangeTokenForSelected,
  ]);

  const rangePanelApply = useCallback(
    (token: string) => {
      const key = selectedFilterKey;
      if (!key) return;
      // `"|"` is the empty sentinel: an emptied panel means "no filter",
      // not "a filter matching nothing".
      if (token === "|") {
        onRemoveFilter
          ? onRemoveFilter(key)
          : onRemove(key, activeRangeTokenForSelected ?? "|");
      } else {
        onSelect(key, token);
      }
    },
    [
      selectedFilterKey,
      onRemoveFilter,
      onRemove,
      onSelect,
      activeRangeTokenForSelected,
    ],
  );

  const openFilter = useCallback(
    (key: Filter["key"]) => {
      // Maintain dimensions for loading options
      if (listContainer.current) {
        listDimensions.current = {
          width: listContainer.current.clientWidth,
          height: listContainer.current.clientHeight,
        };
      }

      setSearch("");
      setSelectedFilterKey(key);

      onOpenFilter?.(key);
    },
    [onOpenFilter],
  );

  const isOptionSelected = useCallback(
    (value: FilterOption["value"]) =>
      selectedFilterKey
        ? isOptionSelectedIn(activeFilters, selectedFilterKey, value)
        : false,
    [activeFilters, selectedFilterKey],
  );

  const selectOption = useCallback(
    (value: FilterOption["value"]) => {
      if (!selectedFilter) return;
      const singleSelect = isSingleSelect(selectedFilter, { isAdvancedFilter });
      const isSelected = isOptionSelected(value);

      if (isSelected) {
        onRemove(selectedFilter.key, value);
      } else {
        onSelect(selectedFilter.key, value);
      }
      if (singleSelect) setIsOpen(false);
    },
    [selectedFilter, isOptionSelected, onSelect, onRemove, isAdvancedFilter],
  );

  // Only the TOP-LEVEL search is the content query. When a filter category
  // is selected the input narrows that filter's options and must NOT touch
  // the table query — so guard on `selectedFilterKey`.
  useEffect(() => {
    if (!selectedFilterKey) onSearchChange?.(search);
  }, [search, selectedFilterKey]);

  useEffect(() => {
    onSelectedFilterChange?.(selectedFilterKey);
  }, [selectedFilterKey]);

  // If filter is selected and has options, maintain dimensions (for async fetches)
  useEffect(() => {
    if (selectedFilter?.options && listContainer.current) {
      listDimensions.current = {
        width: listContainer.current.clientWidth,
        height: listContainer.current.clientHeight,
      };
    }
  }, [selectedFilter?.options]);

  return (
    <Popover
      openPopover={isOpen}
      setOpenPopover={setIsOpen}
      onEscapeKeyDown={(e) => {
        if (
          isRangeType(selectedFilter?.type) &&
          rangeTokenIsComplete(activeRangeTokenForSelected)
        ) {
          e.preventDefault();
          setIsOpen(false);
          return;
        }
        if (selectedFilterKey) {
          e.preventDefault();
          e.stopPropagation();
          goBackOrClose();
          return;
        }
        e.preventDefault();
        setIsOpen(false);
      }}
      content={
        <AnimatedSizeContainer
          width={!isMobile}
          height
          className="rounded-[inherit]"
          style={{ transform: "translateZ(0)" }} // Fixes overflow on some browsers
        >
          {selectedFilter?.type === "range" ? (
            <FilterRangePanel
              key={selectedFilterKey}
              filter={selectedFilter}
              activeToken={activeRangeTokenForSelected}
              scrollRef={listContainer}
              onBack={() => reset()}
              onClear={rangePanelClear}
              onCloseOuter={() => setIsOpen(false)}
              onApply={rangePanelApply}
            />
          ) : selectedFilter?.type === "dateRange" ? (
            <FilterDateRangePanel
              key={selectedFilterKey}
              filter={selectedFilter}
              activeToken={activeRangeTokenForSelected}
              scrollRef={listContainer}
              onBack={() => reset()}
              onClear={rangePanelClear}
              onApply={rangePanelApply}
            />
          ) : (
            <Command
              loop
              shouldFilter={
                selectedFilter
                  ? selectedFilter.shouldFilter !== false
                  : // Top-level content search filters the TABLE, not the
                    // category list — keep every category visible.
                    !contentSearch
              }
            >
              <div
                id={!selectedFilter && contentSearch ? searchId : undefined}
                className="flex items-center overflow-hidden rounded-t-lg border-b border-border-subtle"
              >
                <CommandInput
                  placeholder={
                    !selectedFilter && contentSearch
                      ? searchPlaceholder
                      : `${selectedFilter?.label || t("filter")}...`
                  }
                  value={search}
                  onValueChange={setSearch}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Escape" ||
                      ((e.key === "Backspace" || e.key === "Delete") && !search)
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      goBackOrClose();
                    }
                  }}
                  onEmptySubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (askAI) {
                      onSelect(
                        "ai",
                        // Prepend search with selected filter label for more context
                        selectedFilter
                          ? `${selectedFilter.label} ${search}`
                          : search,
                      );
                      setIsOpen(false);
                    } else selectOption(search);
                  }}
                />
                {!selectedFilter && (
                  <kbd className="mr-2 hidden shrink-0 rounded border border-border-subtle bg-bg-muted px-2 py-0.5 text-xs font-light text-content-muted md:block">
                    F
                  </kbd>
                )}
              </div>
              <FilterScroll key={selectedFilterKey} ref={listContainer}>
                <Command.List
                  className={cn(
                    "flex w-full flex-col gap-1 p-1",
                    selectedFilter ? "min-w-[100px]" : "min-w-[180px]",
                  )}
                >
                  {!selectedFilter
                    ? // Top-level filters
                      filters
                        .filter((filter) => !filter.hideInFilterDropdown)
                        .map((filter) => (
                          <Fragment key={filter.key}>
                            <FilterButton
                              filter={filter}
                              onSelect={() => openFilter(filter.key)}
                            />
                            {filter.separatorAfter && (
                              <Command.Separator className="-mx-1 my-1 border-b border-border-subtle" />
                            )}
                          </Fragment>
                        ))
                    : // Filter options
                      selectedFilter.options
                        ?.filter(
                          (option) => !search || !option.hideDuringSearch,
                        )
                        ?.map((option) => {
                          const singleSelect = isSingleSelect(selectedFilter, {
                            isAdvancedFilter,
                          });
                          const isSelected = isOptionSelected(option.value);

                          return (
                            <FilterButton
                              key={option.value}
                              filter={selectedFilter}
                              option={option}
                              showCheckbox={
                                !singleSelect &&
                                (isAdvancedFilter || selectedFilter?.multiple)
                              }
                              isChecked={isSelected}
                              right={
                                singleSelect ? (
                                  isSelected ? (
                                    <Check className="h-4 w-4" />
                                  ) : (
                                    option.right
                                  )
                                ) : (
                                  option.right
                                )
                              }
                              onSelect={() => selectOption(option.value)}
                            />
                          );
                        }) ?? (
                        // Filter options loading state
                        <Command.Loading>
                          <div
                            className="-m-1 flex items-center justify-center"
                            // dimensions ref is cached width/height for the loading state to avoid layout shift; the value was set by the virtualizer's resize-observer effect.
                            // eslint-disable-next-line react-hooks/refs
                            style={listDimensions.current}
                          >
                            <LoadingSpinner />
                          </div>
                        </Command.Loading>
                      )}

                  {/* Only render CommandEmpty if not loading */}
                  {(!selectedFilter || selectedFilter.options) && (
                    <CommandEmpty
                      search={search}
                      selectedFilter={selectedFilter}
                      onSelect={() => selectOption(search)}
                      askAI={askAI}
                    >
                      {resolveEmptyStateFor(emptyState, selectedFilterKey)}
                    </CommandEmpty>
                  )}
                </Command.List>
              </FilterScroll>
            </Command>
          )}
        </AnimatedSizeContainer>
      }
    >
      {/*
        Epic 57 — the filter trigger carries a visible `F` keyboard
        hint as an inline `<kbd>` chip. A Radix Tooltip wrapper would
        fight Popover's `asChild` trigger ref (both want to attach to
        the same button), so the inline chip is both simpler and more
        durable. Hidden below `md` to preserve the compact mobile
        toolbar layout, and suppressed when filters are active so the
        badge has room.
      */}
      <button
        type="button"
        className={cn(
          "group flex h-10 cursor-pointer appearance-none items-center gap-x-2 truncate rounded-lg border px-3 text-sm outline-none",
          "transition-[color,border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
          "border-border-subtle bg-bg-default text-content-emphasis placeholder:text-content-subtle",
          "focus-visible:border-border-emphasis data-[state=open]:border-border-emphasis data-[state=open]:ring-4 data-[state=open]:ring-ring",
          "active:scale-[0.98] motion-reduce:active:scale-100",
          className,
        )}
        data-filter-trigger
        aria-keyshortcuts="F"
      >
        <ListFilter className="size-4 shrink-0" />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-content-emphasis">
          {children ?? t("filter")}
        </span>
        {(activeFilters?.length ?? 0) +
        (contentSearch && searchValue ? 1 : 0) ? (
          // Count an active content search alongside structured filters so
          // the badge signals "something is filtering" even when the search
          // text lives inside the (closed) dropdown.
          <div className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-emphasis text-[0.625rem] text-content-inverted">
            {(activeFilters?.length ?? 0) +
              (contentSearch && searchValue ? 1 : 0)}
          </div>
        ) : (
          <>
            <kbd
              className={cn(
                "hidden shrink-0 items-center rounded border",
                "border-border-subtle bg-bg-muted px-1.5 py-0.5",
                "text-[10px] font-medium text-content-muted",
                "md:inline-flex",
                "group-data-[state=open]:hidden",
              )}
              aria-hidden="true"
              data-filter-shortcut-hint
            >
              F
            </kbd>
            <ChevronDown
              className={`size-4 shrink-0 text-content-subtle transition-transform duration-100 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none`}
            />
          </>
        )}
      </button>
    </Popover>
  );
}

const CommandInput = (
  props: React.ComponentProps<typeof Command.Input> & {
    onEmptySubmit?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  },
) => {
  const { onEmptySubmit, ...restProps } = props;
  const isEmpty = useCommandState((state) => state.filtered.count === 0);
  return (
    <Command.Input
      {...restProps}
      size={1}
      // P3.3 — the filter/search field shows a "search" return key on
      // mobile keyboards. `restProps` can still override per call site.
      enterKeyHint={restProps.enterKeyHint ?? "search"}
      className="grow border-0 py-3 pl-4 pr-2 outline-none placeholder:text-content-subtle focus:ring-0 sm:text-sm bg-transparent text-content-emphasis"
      onKeyDown={(e) => {
        props.onKeyDown?.(e);

        if (e.key === "Enter" && isEmpty) {
          onEmptySubmit?.(e);
        }
      }}
      autoCapitalize="none"
    />
  );
};

function FilterButton({
  filter,
  option,
  right,
  showCheckbox,
  isChecked,
  onSelect,
}: {
  filter: Filter;
  option?: FilterOption;
  right?: ReactNode;
  showCheckbox?: boolean;
  isChecked?: boolean;
  onSelect: () => void;
}) {
  // The Icon binding is a polymorphic value: either a ReactNode (used
  // verbatim) or a component reference (rendered as `<Icon />`). The
  // capitalised name signals "could be a component"; the static-
  // components rule flags it because the per-render binding could be
  // a fresh component identity. The downstream `isReactNode` branch
  // handles the value case and the component-ref case is stable
  // (always derived from props).

  const Icon = option
    ? option.icon ??
      filter.getOptionIcon?.(option.value, { key: filter.key, option }) ??
      filter.icon
    : filter.icon;

  const label = option
    ? option.label ??
      filter.getOptionLabel?.(option.value, { key: filter.key, option })
    : filter.label;

  return (
    <Command.Item
      className={cn(
        "flex cursor-pointer items-center gap-compact whitespace-nowrap rounded-md px-3 py-2 text-left text-sm",
        "transition-colors duration-100 ease-out motion-reduce:transition-none",
        "active:scale-[0.99] motion-reduce:active:scale-100",
        "text-content-default",
        "data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis",
      )}
      // PR-C — separate the label from the option value with a
      // space so cmdk's fuzzy `commandScore` treats them as
      // independent tokens. Pre-PR-C the concatenated form
      // `${label}${option.value}` would fuse "Alice Smith" with a
      // cuid into "Alice Smithcmcae5l..." — substring scoring then
      // missed clean partial matches against the visible label.
      // Also fall back to the filter key when there is no option
      // value (the top-level filter-type list), so cmdk has a
      // stable searchable token in both modes.
      value={`${label} ${option?.value ?? filter.key}`}
      keywords={[label]}
      onSelect={onSelect}
      onMouseDown={(e) => {
        // Keep the search input focused when selecting with mouse
        e.preventDefault();
      }}
    >
      {showCheckbox && (
        <div
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded border",
            isChecked
              ? "border-brand-emphasis bg-brand-emphasis"
              : "border-border-subtle",
          )}
        >
          {isChecked && <Check className="h-3 w-3 text-content-inverted" />}
        </div>
      )}
      <span className="shrink-0 text-content-muted">
        {/* eslint-disable-next-line react-hooks/static-components -- Icon
            is a polymorphic prop value: ReactNode (used verbatim in the
            true branch) or component reference (rendered as <Icon /> in
            the false branch). Stable across renders since it derives
            from props. */}
        {isReactNode(Icon) ? Icon : <Icon className="h-4 w-4" />}
      </span>
      <span className="flex-1">{truncate(label, 48)}</span>
      <div className="ml-1 flex shrink-0 justify-end text-content-muted">
        {right}
      </div>
    </Command.Item>
  );
}

const CommandEmpty = ({
  search,
  selectedFilter,
  onSelect,
  askAI,
  children,
}: PropsWithChildren<{
  search: string;
  selectedFilter?: Filter | null;
  onSelect: () => void;
  askAI?: boolean;
}>) => {
  const t = useTranslations("ui.filter");
  // If the selected filter has no options (and shouldFilter is true,
  // meaning it's leveraging Command.List's native filtering and not external/async filtering),
  // show the search input as an option
  if (
    selectedFilter &&
    selectedFilter.options &&
    selectedFilter.options.length === 0 &&
    selectedFilter.shouldFilter !== false
  ) {
    if (!search)
      return (
        <Command.Empty className="p-2 text-center text-sm text-content-muted">
          {t("startTyping")}
        </Command.Empty>
      );

    return (
      <FilterButton
        filter={selectedFilter}
        option={{
          value: search,
          label: search,
        }}
        onSelect={onSelect}
      />
    );
  }

  // Ask AI option should only be shown if no filter is selected and the user has typed something in the search input
  if (!selectedFilter && askAI && search) {
    return (
      <Command.Empty className="flex min-w-[180px] items-center space-x-2 rounded-md bg-bg-muted px-3 py-2">
        <Magic className="h-4 w-4" />
        <p className="text-center text-sm text-content-default">
          {t("askAI")} <span className="text-content-emphasis">&quot;{search}&quot;</span>
        </p>
      </Command.Empty>
    );
  }

  return (
    <Command.Empty className="p-2 text-center text-sm text-content-muted">
      {children}
    </Command.Empty>
  );
};

const isReactNode = (element: unknown): element is ReactNode =>
  isValidElement(element);