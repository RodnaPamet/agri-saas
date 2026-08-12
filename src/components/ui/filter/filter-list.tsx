'use client';

import { cn } from "@/lib/cn";
import { pluralize, truncate } from "@/lib/text-utils";
import { useTranslations } from "next-intl";
import { Command } from "cmdk";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { ReactNode, isValidElement, useCallback, useState } from "react";
import { AnimatedSizeContainer } from "../animated-size-container";
import { useKeyboardShortcut } from "../hooks";
import { Check } from "../icons";
import { Popover } from "../popover";
import { formatDate } from "@/lib/format-date";
import { parseYMD } from "../date-picker/date-utils";
import { FilterDateRangePanel } from "./filter-date-range-panel";
import { rangeTokenBounds } from "./filter-range-utils";
import { FilterRangePanel } from "./filter-range-panel";
import {
  ActiveFilterInput,
  Filter,
  FilterOperator,
  FilterOption,
  isRangeType,
  normalizeActiveFilter,
} from "./types";

type FilterListProps = {
  filters: Filter[];
  activeFilters?: ActiveFilterInput[];
  onRemove: (key: string, value: FilterOption["value"]) => void;
  onRemoveFilter?: (key: string) => void;
  onRemoveAll: () => void;
  onSelect?: (
    key: string,
    value: FilterOption["value"] | FilterOption["value"][],
  ) => void;
  onToggleOperator?: (key: string) => void;
  isAdvancedFilter?: boolean;
  className?: string;
};

export function FilterList({
  filters,
  activeFilters,
  onRemove,
  onRemoveFilter,
  onRemoveAll,
  onSelect,
  onToggleOperator,
  isAdvancedFilter = false,
  className,
}: FilterListProps) {
  const t = useTranslations("ui.filter");
  // Epic 57 — Escape clears all active filters. Priority 1 so the
  // selection-toolbar clear (priority 2) wins when rows are selected,
  // and any overlay's native Radix/Vaul Escape handler wins when a
  // modal or sheet is open (our global-scope hook is skipped while
  // an overlay is mounted).
  useKeyboardShortcut("Escape", onRemoveAll, {
    priority: 1,
    scope: "global",
    description: "Clear all filters",
  });
  const normalizedFilters = activeFilters?.map(normalizeActiveFilter) ?? [];

  return (
    <AnimatedSizeContainer
      height
      className="w-full"
      transition={{
        type: "tween",
        duration: 0.2,
        ease: [0.23, 1, 0.32, 1],
      }}
    >
      <div
        className={cn(
          "flex w-full flex-wrap items-start gap-default sm:flex-nowrap",
          className,
        )}
      >
        <div className="flex grow flex-wrap gap-x-4 gap-y-2">
          <AnimatePresence>
            {normalizedFilters.map(({ key, values, operator }) => {
              if (key === "loader") {
                return (
                  <motion.div
                    key={`loader-${values?.[0] ?? 0}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="h-9 w-48 animate-pulse rounded-md border border-border-default bg-bg-muted"
                  />
                );
              }

              const filter = filters.find((f) => f.key === key);
              if (!filter) {
                console.error(
                  "Filter.List received an activeFilter without a corresponding filter",
                );
                return null;
              }

              const isSingleValue = values.length === 1;
              const displayValues = values.slice(0, 3);

              const displayLabel = isSingleValue
                ? (() => {
                    const value = values[0];
                    const option = filter.options?.find((o) =>
                      typeof o.value === "string" && typeof value === "string"
                        ? o.value.toLowerCase() === value.toLowerCase()
                        : o.value === value,
                    );
                    return (
                      option?.label ??
                      filter.getOptionLabel?.(value, {
                        key: filter.key,
                        option,
                      }) ??
                      String(value)
                    );
                  })()
                : `${values.length} ${filter.labelPlural ?? pluralize(filter.label, values.length)}`;

              const OptionDisplay = ({ className }: { className?: string }) => {
                let iconDisplay;
                let permalinkDisplay;

                if (isSingleValue) {
                  const value = values[0];
                  const option = filter.options?.find((o) =>
                    typeof o.value === "string" && typeof value === "string"
                      ? o.value.toLowerCase() === value.toLowerCase()
                      : o.value === value,
                  );

                  permalinkDisplay =
                    option?.permalink ??
                    filter.getOptionPermalink?.(value) ??
                    null;

                  const OptionIcon =
                    option?.icon ??
                    filter.getOptionIcon?.(value, {
                      key: filter.key,
                      option,
                    }) ??
                    filter.icon;

                  iconDisplay = (
                    <span className="shrink-0 text-content-muted">
                      {isReactNode(OptionIcon) ? (
                        OptionIcon
                      ) : (
                        <OptionIcon className="h-4 w-4" />
                      )}
                    </span>
                  );
                } else if (!filter.hideMultipleIcons) {
                  iconDisplay = (
                    <div className="flex shrink-0 -space-x-1">
                      {displayValues.map((value, idx) => {
                        const option = filter.options?.find((o) =>
                          typeof o.value === "string" &&
                          typeof value === "string"
                            ? o.value.toLowerCase() === value.toLowerCase()
                            : o.value === value,
                        );

                        const OptionIcon =
                          option?.icon ??
                          filter.getOptionIcon?.(value, {
                            key: filter.key,
                            option,
                          }) ??
                          filter.icon;

                        return (
                          <span
                            key={idx}
                            className="inline-flex text-content-muted"
                            style={{ zIndex: displayValues.length - idx }}
                          >
                            {isReactNode(OptionIcon) ? (
                              OptionIcon
                            ) : (
                              <OptionIcon className="h-4 w-4" />
                            )}
                          </span>
                        );
                      })}
                    </div>
                  );
                } else {
                  iconDisplay = (
                    <span className="shrink-0 text-content-muted">
                      {isReactNode(filter.icon) ? (
                        filter.icon
                      ) : (
                        <filter.icon className="h-4 w-4" />
                      )}
                    </span>
                  );
                }

                return (
                  <div
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2",
                      className,
                    )}
                  >
                    {iconDisplay}
                    {permalinkDisplay ? (
                      <Link
                        href={permalinkDisplay}
                        target="_blank"
                        className="cursor-alias decoration-dotted underline-offset-2 hover:underline"
                      >
                        {truncate(displayLabel, 30)}
                      </Link>
                    ) : (
                      truncate(displayLabel, 30)
                    )}
                  </div>
                );
              };

              return (
                <OperatorFilterPill
                  key={key}
                  filterKey={key}
                  filter={filter}
                  values={values}
                  operator={operator}
                  OptionDisplay={OptionDisplay}
                  onRemove={onRemove}
                  onRemoveFilter={onRemoveFilter}
                  onSelect={onSelect}
                  onToggleOperator={onToggleOperator}
                  isAdvancedFilter={isAdvancedFilter}
                />
              );
            })}
          </AnimatePresence>
        </div>
        {normalizedFilters.length !== 0 && (
          <button
            type="button"
            className={cn(
              "group mt-px flex h-[38px] items-center gap-tight whitespace-nowrap rounded-lg border border-transparent px-3 py-2 text-sm text-content-muted",
              "transition-[color,border-color,background-color,transform] duration-150 ease-out motion-reduce:transition-none",
              "hover:border-border-emphasis hover:bg-bg-muted hover:text-content-emphasis [@media(hover:none)]:hover:border-transparent [@media(hover:none)]:hover:bg-transparent",
              "active:scale-[0.98] motion-reduce:active:scale-100",
              "focus:outline-none",
            )}
            onClick={onRemoveAll}
          >
            {t("clearFilters")}
            <kbd className="rounded-md border border-border-subtle px-1.5 py-0.5 text-xs text-content-emphasis group-hover:bg-bg-muted">
              ESC
            </kbd>
          </button>
        )}
      </div>
    </AnimatedSizeContainer>
  );
}

function OperatorFilterPill({
  filterKey,
  filter,
  values,
  operator,
  OptionDisplay,
  onRemove,
  onRemoveFilter,
  onSelect,
  onToggleOperator,
  isAdvancedFilter = false,
}: {
  filterKey: string;
  filter: Filter;
  values: FilterOption["value"][];
  operator: FilterOperator;
  OptionDisplay: ({ className }: { className?: string }) => ReactNode;
  onRemove: (key: string, value: FilterOption["value"]) => void;
  onRemoveFilter?: (key: string) => void;
  onSelect?: (
    key: string,
    value: FilterOption["value"] | FilterOption["value"][],
  ) => void;
  onToggleOperator?: (key: string) => void;
  isAdvancedFilter?: boolean;
}) {
  const t = useTranslations("ui.filter");
  const [operatorDropdownOpen, setOperatorDropdownOpen] = useState(false);
  const [valueDropdownOpen, setValueDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [initialSelectedValues, setInitialSelectedValues] = useState<
    Set<FilterOption["value"]>
  >(new Set());
  const [rangeEditOpen, setRangeEditOpen] = useState(false);

  const openValueDropdown = useCallback(() => {
    setInitialSelectedValues(new Set(values));
    setValueDropdownOpen(true);
  }, [values]);

  const toggleValue = useCallback(
    (value: FilterOption["value"]) => {
      const isSelected = values.includes(value);
      if (isSelected) {
        onRemove(filterKey, value);
      } else {
        onSelect?.(filterKey, value);
      }

      if (!isAdvancedFilter && !filter.multiple) setValueDropdownOpen(false);
    },
    [filterKey, values, onSelect, onRemove, isAdvancedFilter, filter.multiple],
  );

  if (isRangeType(filter.type)) {
    const token = String(values[0] ?? "|");
    const isDate = filter.type === "dateRange";
    // Bounds as VALIDATED strings, per kind — a `dateRange` token's sides
    // are ISO dates, and the numeric parser turns those into NaN, which is
    // how a date pill would come to show the raw token.
    const { lo, hi } = rangeTokenBounds(token, isDate);
    const fmt = isDate
      ? (raw: string) => formatDate(parseYMD(raw))
      : filter.formatRangeBound
        ? (raw: string) => filter.formatRangeBound!(Number(raw))
        : (raw: string) => String(Math.trunc(Number(raw)));
    const rangeFullyApplied = lo != null && hi != null;
    const rangeHasAppliedValue = lo != null || hi != null;
    const rangeLabel =
      filter.formatRangePillLabel?.(token) ??
      (lo != null && hi != null
        ? `${fmt(lo)} – ${fmt(hi)}`
        : lo != null
          ? `${fmt(lo)} – ${t("noMax")}`
          : hi != null
            ? `${t("noMin")} – ${fmt(hi)}`
            : token);

    // One definition each, used by whichever panel the kind selects — the
    // token IS the value, so nothing here is kind-specific.
    const rangePillClear = rangeHasAppliedValue
      ? () =>
          onRemoveFilter
            ? onRemoveFilter(filterKey)
            : onRemove(filterKey, token)
      : undefined;

    const rangePillApply = (next: string) => {
      if (next === "|") {
        if (onRemoveFilter) {
          onRemoveFilter(filterKey);
        } else {
          onRemove(filterKey, token);
        }
      } else {
        onSelect?.(filterKey, next);
      }
    };

    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex min-h-9 items-stretch divide-x divide-border-default overflow-hidden rounded-md border border-border-default bg-bg-default text-sm text-content-emphasis"
      >
        <div className="flex items-center gap-2.5 px-3 py-2">
          <span className="shrink-0 text-content-muted">
            {isReactNode(filter.icon) ? (
              filter.icon
            ) : (
              <filter.icon className="size-4" />
            )}
          </span>

          <span className="text-sm font-medium text-content-emphasis">
            {filter.label}
          </span>
        </div>

        <div className="flex items-center px-3 py-2 text-sm text-content-muted">
          {t("is")}
        </div>

        <Popover
          openPopover={rangeEditOpen}
          setOpenPopover={setRangeEditOpen}
          align="start"
          onEscapeKeyDown={(e) => {
            if (rangeFullyApplied) {
              e.preventDefault();
              setRangeEditOpen(false);
            }
          }}
          content={
            <AnimatedSizeContainer width height className="rounded-[inherit]">
              {isDate ? (
                <FilterDateRangePanel
                  key={filterKey}
                  filter={filter}
                  activeToken={token}
                  onBack={() => setRangeEditOpen(false)}
                  onClear={rangePillClear}
                  onApply={rangePillApply}
                />
              ) : (
                <FilterRangePanel
                  key={filterKey}
                  filter={filter}
                  activeToken={token}
                  onBack={() => setRangeEditOpen(false)}
                  onClear={rangePillClear}
                  onCloseOuter={
                    rangeFullyApplied ? () => setRangeEditOpen(false) : undefined
                  }
                  onApply={rangePillApply}
                />
              )}
            </AnimatedSizeContainer>
          }
        >
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center px-3 py-2 text-left text-sm font-medium tracking-tight text-content-emphasis",
              "transition-[background-color,transform] duration-150 ease-out motion-reduce:transition-none",
              "hover:bg-bg-muted active:scale-[0.99] motion-reduce:active:scale-100 [@media(hover:none)]:hover:bg-transparent",
            )}
          >
            <span className="truncate">{rangeLabel}</span>
          </button>
        </Popover>

        <button
          type="button"
          className={cn(
            "h-full rounded-r-md p-2 text-content-muted ring-inset ring-border-emphasis",
            "transition-[color,background-color,transform] duration-150 ease-out motion-reduce:transition-none",
            "hover:bg-bg-muted hover:text-content-emphasis [@media(hover:none)]:hover:bg-transparent",
            "active:scale-[0.97] motion-reduce:active:scale-100",
            "focus:outline-none focus-visible:ring-2",
          )}
          onClick={() => {
            if (onRemoveFilter) {
              onRemoveFilter(filterKey);
            } else {
              values.forEach((v) => onRemove(filterKey, v));
            }
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center divide-x divide-border-default rounded-lg border border-border-default bg-bg-default text-sm text-content-emphasis"
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="shrink-0 text-content-muted">
          {isReactNode(filter.icon) ? (
            filter.icon
          ) : (
            <filter.icon className="h-4 w-4" />
          )}
        </span>
        {filter.label}
      </div>

      {(isAdvancedFilter || filter.multiple) &&
      !filter.singleSelect &&
      !filter.hideOperator ? (
        <Popover
          openPopover={operatorDropdownOpen}
          setOpenPopover={setOperatorDropdownOpen}
          content={
            <div className="w-32 p-1">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-md px-3 py-2 text-left text-sm",
                  "transition-[background-color,transform] duration-100 ease-out motion-reduce:transition-none",
                  "hover:bg-bg-muted [@media(hover:none)]:hover:bg-transparent",
                  "active:scale-[0.99] motion-reduce:active:scale-100",
                  !operator.includes("NOT") && "bg-bg-subtle",
                )}
                onClick={() => {
                  if (operator.includes("NOT")) {
                    onToggleOperator?.(filterKey);
                  }
                  setOperatorDropdownOpen(false);
                }}
              >
                {t("is")}
              </button>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-md px-3 py-2 text-left text-sm",
                  "transition-[background-color,transform] duration-100 ease-out motion-reduce:transition-none",
                  "hover:bg-bg-muted [@media(hover:none)]:hover:bg-transparent",
                  "active:scale-[0.99] motion-reduce:active:scale-100",
                  operator.includes("NOT") && "bg-bg-subtle",
                )}
                onClick={() => {
                  if (!operator.includes("NOT")) {
                    onToggleOperator?.(filterKey);
                  }
                  setOperatorDropdownOpen(false);
                }}
              >
                {t("isNot")}
              </button>
            </div>
          }
          align="center"
        >
          <button
            type="button"
            className={cn(
              "px-3 py-2 text-content-muted",
              "transition-[color,background-color,transform] duration-150 ease-out motion-reduce:transition-none",
              "hover:bg-bg-muted hover:text-content-default [@media(hover:none)]:hover:bg-transparent",
              "active:scale-[0.98] motion-reduce:active:scale-100",
            )}
          >
            {t(operator.includes("NOT") ? "isNot" : "is")}
          </button>
        </Popover>
      ) : (
        <div className="px-3 py-2 text-content-muted">{t("is")}</div>
      )}

      <Popover
        openPopover={valueDropdownOpen}
        setOpenPopover={(open) => {
          setValueDropdownOpen(open);
          if (!open) {
            setSearch("");
            setInitialSelectedValues(new Set());
          }
        }}
        content={
          <div>
            <AnimatedSizeContainer width height className="rounded-[inherit]">
              <Command loop shouldFilter={false}>
                <div className="flex items-center overflow-hidden rounded-t-lg border-b border-border-subtle">
                  <Command.Input
                    placeholder={`${filter.label}...`}
                    value={search}
                    onValueChange={setSearch}
                    className="grow border-0 py-3 pl-4 pr-2 outline-none placeholder:text-content-subtle focus:ring-0 sm:text-sm bg-transparent text-content-emphasis"
                    autoCapitalize="none"
                  />
                </div>
                <div className="scrollbar-hide max-h-[50vh] w-screen overflow-y-scroll sm:w-auto">
                  <Command.List className="flex w-full min-w-[180px] flex-col gap-1 p-1">
                    {(() => {
                      const filteredOptions =
                        filter.options?.filter((option) => {
                          if (!search) return true;
                          const optionLabel = (
                            option.label ??
                            filter.getOptionLabel?.(option.value, {
                              key: filter.key,
                              option,
                            }) ??
                            String(option.value)
                          ).toLowerCase();
                          return optionLabel.includes(search.toLowerCase());
                        }) ?? [];

                      const selectedOptions = filteredOptions.filter((option) =>
                        initialSelectedValues.has(option.value),
                      );
                      const unselectedOptions = filteredOptions.filter(
                        (option) => !initialSelectedValues.has(option.value),
                      );

                      const renderOption = (option: FilterOption) => {
                        const isSelected = values.includes(option.value);
                        const OptionIcon =
                          option.icon ??
                          filter.getOptionIcon?.(option.value, {
                            key: filter.key,
                            option,
                          }) ??
                          filter.icon;

                        const optionLabel =
                          option.label ??
                          filter.getOptionLabel?.(option.value, {
                            key: filter.key,
                            option,
                          }) ??
                          String(option.value);

                        return (
                          <Command.Item
                            key={option.value}
                            className={cn(
                              "flex cursor-pointer items-center gap-compact whitespace-nowrap rounded-md px-3 py-2 text-left text-sm",
                              "transition-[background-color] duration-100 ease-out motion-reduce:transition-none",
                              "active:scale-[0.99] motion-reduce:active:scale-100",
                              "text-content-default",
                              "data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis",
                            )}
                            onSelect={() => {
                              toggleValue(option.value);
                            }}
                            onPointerDown={(e) => {
                              e.preventDefault();
                            }}
                            value={optionLabel + option.value}
                          >
                            {(isAdvancedFilter || filter.multiple) &&
                              !filter.singleSelect && (
                                <div
                                  className={cn(
                                    "flex h-4 w-4 items-center justify-center rounded border",
                                    isSelected
                                      ? "border-brand-emphasis bg-brand-emphasis"
                                      : "border-border-subtle",
                                  )}
                                >
                                  {isSelected && (
                                    <Check className="h-3 w-3 text-content-inverted" />
                                  )}
                                </div>
                              )}
                            <span className="shrink-0 text-content-muted">
                              {isReactNode(OptionIcon) ? (
                                OptionIcon
                              ) : (
                                <OptionIcon className="h-4 w-4" />
                              )}
                            </span>
                            <span className="flex-1">
                              {truncate(optionLabel, 48)}
                            </span>
                            <div className="ml-1 flex shrink-0 justify-end text-content-muted">
                              {(isAdvancedFilter || filter.multiple) &&
                              !filter.singleSelect ? (
                                option.right
                              ) : isSelected ? (
                                <Check className="h-4 w-4" />
                              ) : (
                                option.right
                              )}
                            </div>
                          </Command.Item>
                        );
                      };

                      return (
                        <>
                          {selectedOptions.map(renderOption)}

                          {(isAdvancedFilter || filter.multiple) &&
                            !filter.singleSelect &&
                            selectedOptions.length > 0 &&
                            unselectedOptions.length > 0 && (
                              <Command.Separator className="-mx-1 my-1 border-b border-border-subtle" />
                            )}

                          {unselectedOptions.map(renderOption)}
                        </>
                      );
                    })()}
                  </Command.List>
                </div>
              </Command>
            </AnimatedSizeContainer>
          </div>
        }
        align="start"
      >
        <button
          type="button"
          onClick={openValueDropdown}
          disabled={filter.options?.length === 0}
          className={cn(
            "flex items-center",
            filter.options?.length &&
              "transition-[background-color,transform] duration-150 ease-out hover:bg-bg-muted active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:none)]:hover:bg-transparent",
          )}
        >
          {!filter.options ? (
            <div className="flex items-center gap-2.5 px-3 py-2">
              <div className="h-5 w-12 animate-pulse rounded-md bg-bg-muted" />
            </div>
          ) : (
            OptionDisplay({ className: "cursor-pointer" })
          )}
        </button>
      </Popover>

      <button
        type="button"
        className={cn(
          "h-full rounded-r-lg p-2 text-content-muted ring-inset ring-border-emphasis",
          "transition-[color,background-color,transform] duration-150 ease-out motion-reduce:transition-none",
          "hover:bg-bg-muted hover:text-content-emphasis [@media(hover:none)]:hover:bg-transparent",
          "active:scale-[0.97] motion-reduce:active:scale-100",
          "focus:outline-none focus-visible:ring-2",
        )}
        onClick={() => {
          if (onRemoveFilter) {
            onRemoveFilter(filterKey);
          } else {
            values.forEach((value) => {
              onRemove(filterKey, value);
            });
          }
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

const isReactNode = (element: unknown): element is ReactNode =>
  isValidElement(element);