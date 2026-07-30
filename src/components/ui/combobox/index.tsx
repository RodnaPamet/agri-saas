"use client";
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
/**
 * Epic 55 — shared <Combobox> platform.
 *
 * Single-select, multi-select, async-create, keyboard-navigated
 * searchable option picker built on `cmdk` inside the Epic-54 Popover
 * (desktop dialog / mobile Vaul Drawer). Visually and semantically
 * aligned with the Epic 55 Prompt 1 primitives (Input, Button,
 * ScrollContainer, FormField).
 *
 * Highlights:
 *   - `<Combobox multiple>` — multi-select with in-place toggle chips.
 *   - `<Combobox onCreate>` — async "Create <search>" affordance with
 *     loading spinner; sticky at the bottom for single-select, inline
 *     at the top of the results for multi-select.
 *   - `<Combobox loading>` — render a spinner in the results panel
 *     while async option loading is in flight.
 *   - `<Combobox invalid>` — paints the trigger on error-border tokens
 *     and forwards `aria-invalid` so `<FormField>` drives styling
 *     without a bespoke branch.
 *   - `id` / `name` / `aria-labelledby` / `aria-describedby` /
 *     `aria-required` passthrough so this is a drop-in replacement for
 *     native `<select>` inside `<FormField>`-wrapped forms. When `name`
 *     is set we render a hidden input carrying the selected value(s)
 *     for native `<form onSubmit>` consumers.
 *
 * Accessibility:
 *   - The default trigger is a `<Button>` that Radix Popover.Trigger
 *     augments with `aria-expanded` / `aria-controls`. We additionally
 *     set `aria-haspopup="listbox"` so screen readers announce the
 *     select-like affordance correctly.
 *   - The trigger's accessible NAME comes from `aria-labelledby` when
 *     one is available — `<FormField>` injects the id of its visible
 *     `<Label>`. WAI-ARIA puts the name on the label and conveys the
 *     VALUE separately (trigger content + `aria-expanded`), so the name
 *     stays stable while the user changes the selection. Only when no
 *     label is reachable does the `aria-label` fallback take over.
 *   - The popover body uses cmdk's `Command` + `Command.List` (role
 *     `listbox`) and `Command.Item` (role `option`, aria-selected).
 *   - `Escape` / `Backspace`-on-empty-search close the popover.
 *   - Selected options announce selection via cmdk + explicit
 *     aria-selected attributes.
 */

import { cn } from "@/lib/cn";
import { Command, useCommandState } from "cmdk";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
    cloneElement,
    forwardRef,
    HTMLProps,
    isValidElement,
    PropsWithChildren,
    ReactElement,
    ReactNode,
    useCallback,
    useEffect,
    useState,
} from "react";
import { AnimatedSizeContainer } from "../animated-size-container";
import { Button, ButtonProps } from "../button";
import { useMediaQuery } from "../hooks";
import {
    Check2,
    CheckboxCheckedFill,
    CheckboxUnchecked,
    Icon,
    LoadingSpinner,
    Plus,
} from "../icons";
import { Popover, PopoverProps } from "../popover";
import { ScrollContainer } from "../scroll-container";
import { Tooltip } from "../tooltip";
import { COMBOBOX_DEFAULT_MESSAGES } from "./messages";
import {
    COMBOBOX_VIRTUALIZE_THRESHOLD,
    VirtualizedComboboxOptions,
} from "./virtualized-options";

export { COMBOBOX_VIRTUALIZE_THRESHOLD } from "./virtualized-options";

export {
    COMBOBOX_DEFAULT_MESSAGES,
    getComboboxMessages,
    type ComboboxMessages,
} from "./messages";

// ─── Option type ────────────────────────────────────────────────────

export type ComboboxOption<TMeta = unknown> = {
    label: string | ReactNode;
    value: string;
    icon?: Icon | ReactNode;
    disabledTooltip?: ReactNode;
    meta?: TMeta;
    separatorAfter?: boolean;
    /** Pin to the top of the unfiltered list. */
    first?: boolean;
};

// ─── Props ──────────────────────────────────────────────────────────

type A11yProps = {
    /**
     * ID applied to the trigger element. `<FormField>` injects this so
     * the label's `htmlFor` points at the trigger. Use when the
     * combobox is the control inside a form field.
     */
    id?: string;
    /** Hidden form-input name; value is serialised as comma-separated. */
    name?: string;
    disabled?: boolean;
    required?: boolean;
    /** Paint the trigger on error-border tokens + set aria-invalid. */
    invalid?: boolean;
    /** Explicit override; usually inferred from `invalid`. */
    "aria-invalid"?: boolean | "true" | "false";
    /**
     * Id of the element holding this control's visible label.
     * `<FormField>` injects the id of its own `<Label>`, which is what
     * gives the trigger a STABLE accessible name (see the precedence
     * comment on `triggerAriaLabel` below). Set it by hand only when
     * the label lives outside a `<FormField>`.
     */
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-required"?: boolean;
};

export type ComboboxProps<
    TMultiple extends boolean | undefined = boolean | undefined,
    TMeta = unknown,
> = PropsWithChildren<
    A11yProps & {
        multiple?: TMultiple;
        selected: TMultiple extends true
            ? ComboboxOption<TMeta>[]
            : ComboboxOption<TMeta> | null;
        setSelected?: TMultiple extends true
            ? (options: ComboboxOption<TMeta>[]) => void
            : (option: ComboboxOption<TMeta> | null) => void;
        onSelect?: (option: ComboboxOption<TMeta>) => void;
        maxSelected?: number;
        /** Undefined options = loading state (spinner rendered). */
        options?: ComboboxOption<TMeta>[];
        /**
         * Explicit loading indicator. When true the results panel shows
         * a spinner even if `options` is defined — useful for async
         * refetches on search input.
         */
        loading?: boolean;
        trigger?: ReactNode;
        icon?: Icon | ReactNode;
        placeholder?: ReactNode;
        searchPlaceholder?: string;
        emptyState?: ReactNode;
        createLabel?: (search: string) => ReactNode;
        createIcon?: Icon;
        onCreate?: (search: string) => Promise<boolean>;
        buttonProps?: ButtonProps;
        labelProps?: { className?: string };
        iconProps?: { className?: string };
        popoverProps?: { contentClassName?: string };
        shortcutHint?: string;
        caret?: boolean | ReactNode;
        side?: PopoverProps["side"];
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        onSearchChange?: (search: string) => void;
        shouldFilter?: boolean;
        inputRight?: ReactNode;
        inputClassName?: string;
        optionRight?: (option: ComboboxOption<TMeta>) => ReactNode;
        optionClassName?: string;
        optionDescription?: (option: ComboboxOption<TMeta>) => ReactNode;
        matchTriggerWidth?: boolean;
        hideSearch?: boolean;
        forceDropdown?: boolean;
    }
>;

function isMultipleSelection(
    multiple: boolean | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSelected: any,
): setSelected is (tags: ComboboxOption[]) => void {
    return multiple === true;
}

// ─── Component ──────────────────────────────────────────────────────

export function Combobox<
    TMultiple extends boolean | undefined = undefined,
    TMeta = unknown,
>({
    multiple,
    selected: selectedProp,
    setSelected,
    onSelect,
    maxSelected,
    options,
    loading = false,
    trigger,
    icon: IconProp,
    placeholder = COMBOBOX_DEFAULT_MESSAGES.placeholder,
    searchPlaceholder = COMBOBOX_DEFAULT_MESSAGES.searchPlaceholder,
    emptyState,
    createLabel,
    createIcon: CreateIcon = Plus,
    onCreate,
    buttonProps,
    labelProps,
    iconProps,
    popoverProps,
    shortcutHint,
    caret,
    side,
    open,
    onOpenChange,
    onSearchChange,
    shouldFilter = true,
    inputRight,
    inputClassName,
    optionRight,
    optionClassName,
    optionDescription,
    matchTriggerWidth,
    hideSearch = false,
    forceDropdown = false,
    // ── a11y / form ──
    id,
    name,
    disabled,
    required,
    invalid,
    "aria-invalid": ariaInvalid,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    "aria-required": ariaRequired,
    children,
}: ComboboxProps<TMultiple, TMeta>) {
    const t = useTranslations("ui");
    const isMultiple = isMultipleSelection(multiple, setSelected);

    // Coerce selectedProp into an array so our internal bookkeeping
    // doesn't branch on single-vs-multi.
    const selected = Array.isArray(selectedProp)
        ? (selectedProp as ComboboxOption<TMeta>[])
        : selectedProp
          ? [selectedProp as ComboboxOption<TMeta>]
          : [];

    const { isMobile } = useMediaQuery();

    const [isOpenInternal, setIsOpenInternal] = useState(false);
    const isOpen = open ?? isOpenInternal;
    const setIsOpen = onOpenChange ?? setIsOpenInternal;

    const [search, setSearch] = useState("");
    // Epic 68 — ref to the search <input>. When the option count
    // exceeds the threshold the virtualized renderer attaches a
    // capture-phase keydown handler here for ArrowDown / ArrowUp /
    // Enter so cmdk's nav (which assumes items are mounted in the
    // DOM) doesn't dead-end at the visible edge.
    const searchInputRef = React.useRef<HTMLInputElement | null>(null);
    const [shouldSortOptions, setShouldSortOptions] = useState(false);
    const [sortedOptions, setSortedOptions] = useState<
        ComboboxOption<TMeta>[] | undefined
    >(undefined);
    const [isCreating, setIsCreating] = useState(false);

    const handleSelect = (option: ComboboxOption<TMeta>) => {
        const isAlreadySelected = isMultiple
            ? selected.some(({ value }) => value === option.value)
            : selected.length > 0 && selected[0]?.value === option.value;

        if (!isAlreadySelected && maxSelected && selected.length >= maxSelected)
            return;

        onSelect?.(option);

        if (isMultiple) {
            if (!setSelected) return;

            (setSelected as (opts: ComboboxOption<TMeta>[]) => void)(
                isAlreadySelected
                    ? selected.filter(({ value }) => value !== option.value)
                    : [...selected, option],
            );
        } else {
            (
                setSelected as
                    | ((opt: ComboboxOption<TMeta> | null) => void)
                    | undefined
            )?.(
                selected.length && selected[0]?.value === option.value
                    ? null
                    : option,
            );
            setIsOpen(false);
        }
    };

    const sortOptions = useCallback(
        (opts: ComboboxOption<TMeta>[], searchText: string) =>
            searchText === ""
                ? [
                      ...opts.filter(
                          (o) =>
                              o.first &&
                              !selected.some((s) => s.value === o.value),
                      ),
                      ...selected,
                      ...opts.filter(
                          (o) =>
                              !o.first &&
                              !selected.some((s) => s.value === o.value),
                      ),
                  ]
                : opts,
        [selected],
    );

    useEffect(() => {
        if (shouldSortOptions) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSortedOptions(options ? sortOptions(options, search) : options);
            setShouldSortOptions(false);
        }
    }, [shouldSortOptions, options, sortOptions, search]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setShouldSortOptions(true);
    }, [JSON.stringify(options?.map((o) => o.value))]);

    // Reset search + re-sort on close.
    useEffect(() => {
        if (isOpen) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSearch("");
        setShouldSortOptions(true);
    }, [isOpen]);

    useEffect(() => onSearchChange?.(search), [search]);

    const effectiveInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";

    const createOptionItem = (
        <Command.Item
            className={cn(
                "text-content-default flex cursor-pointer items-center gap-compact whitespace-nowrap rounded-md px-3 py-2 text-left text-sm",
                "data-[selected=true]:bg-bg-subtle",
                optionClassName,
            )}
            onSelect={async () => {
                setIsCreating(true);
                const success = await onCreate?.(search);
                if (success) {
                    setSearch("");
                    setIsOpen(false);
                }
                setIsCreating(false);
            }}
        >
            {isCreating ? (
                <LoadingSpinner className="size-4 shrink-0" />
            ) : (
                <CreateIcon className="size-4 shrink-0" />
            )}
            <div className="grow truncate">
                {createLabel?.(search) ??
                    COMBOBOX_DEFAULT_MESSAGES.createLabel(search)}
            </div>
        </Command.Item>
    );

    // Hidden form input so `<Combobox name>` works inside native forms.
    const hiddenInputValue = isMultiple
        ? selected.map((o) => o.value).join(",")
        : (selected[0]?.value ?? "");
    const hiddenInput = name ? (
        <input type="hidden" name={name} value={hiddenInputValue} />
    ) : null;

    // ─── Trigger plumbing ──
    //
    // Both the default Button and a caller-provided trigger need the
    // same a11y + form props injected. For the default Button we pass
    // them directly; for a custom trigger we cloneElement and inject.

    // Compute an accessible name for the trigger. Three sources, in
    // strict precedence order:
    //
    //   1. `buttonProps["aria-label"]` — the caller named the control
    //      outright, so nothing outranks it.
    //   2. `aria-labelledby` — normally injected by `<FormField>`,
    //      pointing at the field's visible `<Label>`. WAI-ARIA is
    //      explicit that a combobox's NAME comes from its label while
    //      its VALUE is conveyed separately (the trigger's own text
    //      content plus `aria-expanded`). This is the branch that keeps
    //      the name STABLE across a selection change.
    //   3. the collapsed-selection label, then the placeholder — the
    //      LAST-RESORT fallback. It exists so axe's `button-name` rule
    //      can never fail even when the Button's children render as a
    //      ReactNode tree that assistive tech doesn't flatten into
    //      text. Do not remove it; it is what covers every combobox
    //      that is neither hand-labelled nor inside a `<FormField>`.
    //
    // Historically (3) was the only fallback, so an unlabelled
    // combobox was named after whatever the user had just selected —
    // a name that changed as they used the control, and one that made
    // `getByRole('combobox', { name })` useless as a locator.
    //
    // Exactly ONE of `aria-label` / `aria-labelledby` is ever emitted.
    // An element carrying both, pointing at different text, is
    // ambiguous for assistive tech (aria-labelledby wins, so the
    // aria-label silently does nothing) and makes the computed name
    // hard to predict.
    const explicitAriaLabel = (
        buttonProps as { "aria-label"?: string } | undefined
    )?.["aria-label"];
    const selectedTriggerText =
        selected.map((option) =>
            typeof option.label === "string" ? option.label : option.value,
        ).join(", ");
    const fallbackAriaLabel =
        selectedTriggerText ||
        (typeof placeholder === "string"
            ? placeholder
            : t("combobox.selectAriaFallback"));
    const triggerAriaLabelledBy = explicitAriaLabel
        ? undefined
        : ariaLabelledBy;
    const triggerAriaLabel =
        explicitAriaLabel ??
        (triggerAriaLabelledBy ? undefined : fallbackAriaLabel);

    const triggerA11yProps = {
        id,
        disabled,
        // WAI-ARIA 1.2: a trigger that opens a listbox should carry
        // `role="combobox"` alongside `aria-haspopup="listbox"`.
        // Radix Popover.Trigger only emits `aria-expanded` /
        // `aria-controls` — we supply the role explicitly so assistive
        // tech announces "combobox, collapsed" / "combobox, expanded".
        role: "combobox" as const,
        "aria-haspopup": "listbox" as const,
        "aria-label": triggerAriaLabel,
        "aria-labelledby": triggerAriaLabelledBy,
        "aria-invalid": effectiveInvalid || undefined,
        "aria-describedby": ariaDescribedBy,
        "aria-required": required || ariaRequired || undefined,
        "data-invalid": effectiveInvalid ? "" : undefined,
    };

    const resolvedTrigger: ReactNode =
        trigger && isValidElement(trigger)
            ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
                  ...triggerA11yProps,
                  ...((trigger.props as Record<string, unknown>) ?? {}),
              })
            : trigger ?? (
                  <Button
                      variant="secondary"
                      {...buttonProps}
                      {...triggerA11yProps}
                      disabled={disabled || buttonProps?.disabled}
                      className={cn(
                          buttonProps?.className,
                          "flex gap-tight",
                          effectiveInvalid &&
                              "border-border-error focus-visible:ring-border-error",
                      )}
                      textWrapperClassName={cn(
                          buttonProps?.textWrapperClassName,
                          "w-full flex items-center justify-start",
                      )}
                      text={
                          <>
                              <div
                                  className={cn(
                                      "min-w-0 grow truncate text-left",
                                      labelProps?.className,
                                  )}
                              >
                                  {children ||
                                      selected
                                          .map((option) => option.label)
                                          .join(", ") ||
                                      placeholder}
                              </div>
                              {caret &&
                                  (caret === true ? (
                                      <ChevronDown
                                          className={`text-content-muted ml-1 size-4 shrink-0 transition-transform duration-75 group-data-[state=open]:rotate-180`}
                                      />
                                  ) : (
                                      caret
                                  ))}
                          </>
                      }
                      icon={
                          IconProp ? (
                              isReactNode(IconProp) ? (
                                  IconProp
                              ) : (
                                  <IconProp
                                      className={cn(
                                          "size-4 shrink-0",
                                          iconProps?.className,
                                      )}
                                  />
                              )
                          ) : undefined
                      }
                  />
              );

    const showLoading = loading || sortedOptions === undefined;

    return (
        <>
            {hiddenInput}
            <Popover
                openPopover={isOpen}
                setOpenPopover={setIsOpen}
                align="start"
                side={side}
                forceDropdown={forceDropdown}
                onWheel={(e) => {
                    // Allows scrolling to work when the popover's in a modal.
                    e.stopPropagation();
                }}
                popoverContentClassName={cn(
                    matchTriggerWidth &&
                        "sm:w-[var(--radix-popover-trigger-width)]",
                    popoverProps?.contentClassName,
                )}
                content={
                    <AnimatedSizeContainer
                        width={!isMobile && !matchTriggerWidth}
                        height
                        style={{ transform: "translateZ(0)" }}
                        transition={{ ease: "easeInOut", duration: 0.1 }}
                        className="pointer-events-auto"
                    >
                        <Command loop shouldFilter={shouldFilter}>
                            {!hideSearch && (
                                <div className="border-border-subtle flex items-center overflow-hidden rounded-t-lg border-b">
                                    <Command.Input
                                        ref={searchInputRef}
                                        placeholder={searchPlaceholder}
                                        // P3.3 — mobile keyboards show a
                                        // "search" return key for this filter
                                        // field instead of a generic Enter.
                                        enterKeyHint="search"
                                        value={search}
                                        onValueChange={setSearch}
                                        className={cn(
                                            "text-content-emphasis placeholder:text-content-muted grow border-0 bg-transparent py-3 pl-4 pr-2 outline-none focus:ring-0 sm:text-sm",
                                            inputClassName,
                                        )}
                                        onKeyDown={(e) => {
                                            if (
                                                e.key === "Escape" ||
                                                (e.key === "Backspace" &&
                                                    !search)
                                            ) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                setIsOpen(false);
                                            }
                                        }}
                                    />
                                    {inputRight && (
                                        <div className="mr-2">{inputRight}</div>
                                    )}
                                    {shortcutHint && (
                                        <kbd className="border-border-subtle bg-bg-subtle text-content-subtle mr-2 hidden shrink-0 rounded border px-2 py-0.5 text-xs font-light md:block">
                                            {shortcutHint}
                                        </kbd>
                                    )}
                                </div>
                            )}
                            <ScrollContainer
                                className={cn(
                                    "max-h-[min(50vh,250px)]",
                                    onCreate &&
                                        !multiple &&
                                        "max-h-[calc(min(50vh,250px)-3.5rem)]",
                                )}
                            >
                                <Command.List
                                    className={cn(
                                        "flex w-full min-w-[100px] flex-col gap-1 p-1",
                                    )}
                                >
                                    {showLoading ? (
                                        <Command.Loading>
                                            <div
                                                className="flex h-12 items-center justify-center"
                                                data-combobox-loading
                                            >
                                                <LoadingSpinner />
                                            </div>
                                        </Command.Loading>
                                    ) : sortedOptions!.length >
                                      COMBOBOX_VIRTUALIZE_THRESHOLD ? (
                                        // Epic 68 — virtualized branch.
                                        // Only the visible window of
                                        // options renders to DOM;
                                        // keyboard navigation runs from
                                        // a bespoke handler bound to the
                                        // search input.
                                        <>
                                            <VirtualizedComboboxOptions<TMeta>
                                                options={sortedOptions!}
                                                selected={selected}
                                                onSelect={handleSelect}
                                                multiple={isMultiple}
                                                maxSelected={maxSelected}
                                                optionRight={optionRight}
                                                optionDescription={optionDescription}
                                                optionClassName={optionClassName}
                                                searchInputRef={searchInputRef}
                                            />
                                            {onCreate &&
                                                multiple &&
                                                search.length > 0 &&
                                                createOptionItem}
                                        </>
                                    ) : (
                                        <>
                                            {sortedOptions!.map((option) => {
                                                const isSelected = selected.some(
                                                    ({ value }) =>
                                                        value === option.value,
                                                );
                                                return (
                                                    <Option
                                                        key={`${option.label}, ${option.value}`}
                                                        option={option}
                                                        multiple={isMultiple}
                                                        selected={isSelected}
                                                        onSelect={() =>
                                                            handleSelect(option)
                                                        }
                                                        disabled={Boolean(
                                                            !isSelected &&
                                                                maxSelected &&
                                                                selected.length >=
                                                                    maxSelected,
                                                        )}
                                                        right={optionRight?.(
                                                            option,
                                                        )}
                                                        description={optionDescription?.(
                                                            option,
                                                        )}
                                                        className={optionClassName}
                                                    />
                                                );
                                            })}
                                            {onCreate &&
                                                multiple &&
                                                search.length > 0 &&
                                                createOptionItem}
                                            {shouldFilter ? (
                                                <Empty className="text-content-subtle flex min-h-12 items-center justify-center text-sm">
                                                    {emptyState ??
                                                        COMBOBOX_DEFAULT_MESSAGES.emptyState}
                                                </Empty>
                                            ) : sortedOptions!.length === 0 ? (
                                                <div
                                                    className="text-content-subtle flex min-h-12 items-center justify-center text-sm"
                                                    data-combobox-empty
                                                >
                                                    {emptyState ??
                                                        COMBOBOX_DEFAULT_MESSAGES.emptyState}
                                                </div>
                                            ) : null}
                                        </>
                                    )}
                                </Command.List>
                            </ScrollContainer>
                            {onCreate && !multiple && (
                                <div className="border-border-subtle bg-bg-default rounded-b-lg border-t p-1">
                                    {createOptionItem}
                                </div>
                            )}
                        </Command>
                    </AnimatedSizeContainer>
                }
            >
                {resolvedTrigger}
            </Popover>
        </>
    );
}

// ─── Internal: Option ───────────────────────────────────────────────

function Option<TMeta>({
    option,
    onSelect,
    multiple,
    selected,
    disabled,
    right,
    description,
    className,
}: {
    option: ComboboxOption<TMeta>;
    onSelect: () => void;
    multiple: boolean;
    selected: boolean;
    disabled?: boolean;
    right?: ReactNode;
    description?: ReactNode;
    className?: string;
}) {
    const hasDescription = Boolean(description);
    return (
        <>
            <DisabledTooltip disabledTooltip={option.disabledTooltip}>
                <Command.Item
                    className={cn(
                        "flex cursor-pointer items-center gap-compact rounded-md px-3 py-2 text-left text-sm",
                        // Let long option labels wrap to a second line
                        // instead of truncating with an ellipsis — a
                        // narrow (e.g. matchTriggerWidth) dropdown was
                        // clipping full entity names like asset titles.
                        hasDescription ? "whitespace-normal py-2.5" : "whitespace-normal",
                        "data-[selected=true]:bg-bg-subtle",
                        Boolean(disabled || option.disabledTooltip) &&
                            "cursor-not-allowed opacity-50",
                        className,
                    )}
                    disabled={disabled || !!option.disabledTooltip}
                    onSelect={onSelect}
                    aria-selected={selected}
                    value={option.label + option?.value}
                >
                    {multiple && (
                        <div className="text-content-default shrink-0">
                            {selected ? (
                                <CheckboxCheckedFill className="text-content-default size-4" />
                            ) : (
                                <CheckboxUnchecked className="text-content-muted size-4" />
                            )}
                        </div>
                    )}
                    <div
                        className={cn(
                            "flex min-w-0 grow items-center gap-tight",
                            hasDescription &&
                                "flex-col items-start gap-0.5",
                        )}
                    >
                        {option.icon && (
                            <span className="text-content-default shrink-0">
                                {isReactNode(option.icon) ? (
                                    option.icon
                                ) : (
                                    <option.icon className="h-4 w-4" />
                                )}
                            </span>
                        )}
                        <span
                            className={cn(
                                "grow break-words",
                                hasDescription
                                    ? "text-content-emphasis"
                                    : "text-content-default",
                            )}
                        >
                            {option.label}
                        </span>
                        {hasDescription && (
                            <span className="text-content-subtle text-sm">
                                {description}
                            </span>
                        )}
                    </div>
                    {right}
                    {!multiple && selected && (
                        <Check2 className="text-content-default size-4 shrink-0" />
                    )}
                </Command.Item>
            </DisabledTooltip>
            {option.separatorAfter && (
                <Command.Separator className="bg-border-subtle -mx-1 my-1 h-px" />
            )}
        </>
    );
}

const DisabledTooltip = ({
    children,
    disabledTooltip,
}: PropsWithChildren<{ disabledTooltip: ReactNode }>) => {
    return disabledTooltip ? (
        <Tooltip content={disabledTooltip}>
            <div>{children}</div>
        </Tooltip>
    ) : (
        children
    );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isReactNode = (element: any): element is ReactNode =>
    isValidElement(element);

// Custom Empty component because our current cmdk version has an issue
// with first render (https://github.com/pacocoursey/cmdk/issues/149).
const Empty = forwardRef<HTMLDivElement, HTMLProps<HTMLDivElement>>(
    (props, forwardedRef) => {
        const render = useCommandState((state) => state.filtered.count === 0);

        if (!render) return null;
        return (
            <div
                ref={forwardedRef}
                cmdk-empty=""
                role="presentation"
                data-combobox-empty
                {...props}
            />
        );
    },
);
Empty.displayName = "ComboboxEmpty";
