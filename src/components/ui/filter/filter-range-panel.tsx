"use client";

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { cn } from "@/lib/cn";
import { useTranslations } from "next-intl";
import { ChevronLeft } from "lucide-react";
import { Tooltip } from "../tooltip";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type Ref,
} from "react";
import { FilterScroll } from "./filter-scroll";
import {
  normalizeRangeBounds,
  sanitizeNumericDraft,
  storageToDraft,
} from "./filter-range-utils";
import { encodeRangeToken, parseRangeToken, type Filter } from "./types";

type RangeBound = "min" | "max";

/**
 * The back-chevron + label + Clear row every token-valued facet panel wears.
 *
 * Exported because `FilterDateRangePanel` needs the identical row — a second
 * copy would be a second definition of one header, and the two would drift
 * the first time either is restyled.
 */
export function FilterPanelHeader({
  label,
  onBack,
  onClear,
}: {
  label: string;
  onBack: () => void;
  onClear?: () => void;
}) {
  const t = useTranslations("ui.filter");
  return (
    <div className="flex items-center justify-between px-2 pt-2">
      <div className="flex items-center gap-1">
        <Tooltip content={t("backToFilterList")}>
          <button
            type="button"
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md p-2 text-content-muted",
              "transition-[transform,color,background-color] duration-150 ease-out motion-reduce:transition-none",
              "hover:bg-bg-muted hover:text-content-emphasis",
              "active:scale-[0.97] motion-reduce:active:scale-100",
            )}
            onClick={() => onBack()}
            aria-label={t("backToFilterList")}
          >
            <ChevronLeft className="size-3 shrink-0" />
          </button>
        </Tooltip>

        <span className="text-sm font-medium text-content-emphasis">{label}</span>
      </div>

      {onClear && (
        <button
          type="button"
          className="text-content-emphasis hover:border-border-subtle flex h-7 items-center justify-center rounded-lg border border-transparent px-2.5 py-2 text-sm font-medium transition-colors"
          onClick={onClear}
          aria-label={t("clear")}
        >
          {t("clear")}
        </button>
      )}
    </div>
  );
}

function RangeEndPractice({
  bound,
  value,
  unboundedLabel,
  parseInput,
  displayScale,
  step,
  onCommit,
  inputRef,
  onEmptyMinBackspace,
  onFocusNextField,
  onFocusPreviousField,
  onEscapeCloseFilter,
}: {
  bound: RangeBound;
  value: number | undefined;
  unboundedLabel: string;
  parseInput: (raw: string) => number;
  displayScale: number;
  step: number | string;
  onCommit: (next: number | undefined) => void;
  inputRef?: Ref<HTMLInputElement | null>;
  onEmptyMinBackspace?: () => void;
  onFocusNextField?: () => void;
  onFocusPreviousField?: () => void;
  onEscapeCloseFilter?: () => void;
}) {
  const t = useTranslations("ui.filter");
  const [draft, setDraft] = useState(() => storageToDraft(value, displayScale));

  // Forwarded-ref bridge — same shape as TreeView. Setting `.current`
  // on a forwarded ref is the documented contract for ref forwarding;
  // the React Compiler immutability rule fires on the entire useCallback
  // (declaration AND inner assignment AND deps array) — wrap the whole
  // block in disable/enable to suppress all three.
  /* eslint-disable react-hooks/immutability */
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (!inputRef) {
        return;
      }
      if (typeof inputRef === "function") {
        inputRef(node);
      } else {
        (inputRef as MutableRefObject<HTMLInputElement | null>).current = node;
      }
    },
    [inputRef],
  );
  /* eslint-enable react-hooks/immutability */

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(storageToDraft(value, displayScale));
  }, [value, displayScale]);

  const commitDraft = useCallback(() => {
    const raw = draft.trim();
    if (raw === "") {
      onCommit(undefined);
      return;
    }
    const n = parseInput(raw);
    if (!Number.isFinite(n)) {
      setDraft(storageToDraft(value, displayScale));
      return;
    }
    onCommit(n);
  }, [draft, onCommit, parseInput, value, displayScale]);

  const parsedStep = typeof step === "string" ? Number.parseFloat(step) : step;
  const stepNum =
    Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1;

  return (
    <div
      className={cn(
        "border-border-subtle flex h-10 min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border bg-bg-default",
        "transition-[border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
        "focus-within:border-border-emphasis focus-within:ring-4 focus-within:ring-ring",
      )}
    >
      <input
        ref={setInputRef}
        type="text"
        inputMode={displayScale === 1 ? "numeric" : "decimal"}
        autoComplete="off"
        aria-label={bound === "min" ? t("minimumValue") : t("maximumValue")}
        placeholder={unboundedLabel}
        id={`filter-range-input-${bound}`}
        className="min-w-0 flex-1 border-0 bg-transparent px-3 py-1 text-sm text-content-emphasis outline-none placeholder:text-content-subtle focus:ring-0"
        value={draft}
        onChange={(e) => {
          setDraft(sanitizeNumericDraft(e.target.value, displayScale));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();

          if (e.key === "Backspace" && onEmptyMinBackspace && draft === "") {
            e.preventDefault();
            onEmptyMinBackspace();
            return;
          }

          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const raw = draft.trim();
            const displayVal =
              raw === ""
                ? 0
                : displayScale === 1
                  ? Number.parseInt(raw, 10)
                  : Number.parseFloat(raw);
            if (!Number.isFinite(displayVal)) {
              return;
            }
            const delta = e.key === "ArrowUp" ? stepNum : -stepNum;
            const nextDisplay = Math.max(0, displayVal + delta);
            const nextDraft =
              displayScale === 1
                ? String(Math.round(nextDisplay))
                : String(Number(nextDisplay.toFixed(2)));
            setDraft(nextDraft);
            return;
          }

          const inputEl = e.currentTarget;
          const rangeStart = inputEl.selectionStart;
          const rangeEnd = inputEl.selectionEnd;
          const hasCaret =
            rangeStart !== null && rangeEnd !== null && rangeStart === rangeEnd;

          // Only move between fields when we know caret position (`?? 0` would fake "at start" when APIs return null).
          if (hasCaret) {
            if (
              bound === "min" &&
              e.key === "ArrowRight" &&
              onFocusNextField &&
              rangeStart === draft.length
            ) {
              e.preventDefault();
              onFocusNextField();
              return;
            }

            if (
              bound === "max" &&
              (e.key === "ArrowLeft" || e.key === "Backspace") &&
              onFocusPreviousField &&
              rangeStart === 0
            ) {
              e.preventDefault();
              onFocusPreviousField();
              return;
            }
          }

          if (e.key === "Escape" && onEscapeCloseFilter) {
            e.preventDefault();
            onEscapeCloseFilter();
            return;
          }

          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          }
        }}
        onBlur={() => {
          commitDraft();
        }}
      />
    </div>
  );
}

function FilterRangeContent({
  filter,
  activeToken,
  onApply,
  onNavigateBack,
  onCloseFilter,
}: {
  filter: Filter;
  activeToken: string | undefined;
  onApply: (token: string) => void;
  onNavigateBack: () => void;
  /** When the applied range has both min and max, Escape closes the outer filter instead of going back. */
  onCloseFilter?: () => void;
}) {
  const t = useTranslations("ui.filter");
  const { min, max } = parseRangeToken(activeToken);
  const rangeFullyApplied = min != null && max != null;
  const parse =
    filter.parseRangeInput ??
    ((raw: string) => {
      const n = Number.parseInt(raw.replace(/[^\d-]/g, ""), 10);
      return Number.isFinite(n) ? n : Number.NaN;
    });

  const displayScale = filter.rangeDisplayScale ?? 1;
  const step = filter.rangeNumberStep ?? (displayScale === 1 ? 1 : 0.01);

  const commitBoth = useCallback(
    (nextMin?: number, nextMax?: number) => {
      const { min: a, max: b } = normalizeRangeBounds(nextMin, nextMax);
      onApply(encodeRangeToken(a, b));
    },
    [onApply],
  );

  const commitMin = useCallback(
    (next: number | undefined) => {
      const { min: a, max: b } = normalizeRangeBounds(next, max);
      commitBoth(a, b);
    },
    [max, commitBoth],
  );

  const commitMax = useCallback(
    (next: number | undefined) => {
      const { min: a, max: b } = normalizeRangeBounds(min, next);
      commitBoth(a, b);
    },
    [min, commitBoth],
  );

  const minInputRef = useRef<HTMLInputElement>(null);
  const maxInputRef = useRef<HTMLInputElement>(null);

  const focusMinAtEnd = useCallback(() => {
    const el = minInputRef.current;
    if (!el) {
      return;
    }
    el.focus();
    const len = el.value.length;
    queueMicrotask(() => {
      el.setSelectionRange(len, len);
    });
  }, []);

  const focusMaxAtStart = useCallback(() => {
    const el = maxInputRef.current;
    if (!el) {
      return;
    }
    el.focus();
    queueMicrotask(() => {
      el.setSelectionRange(0, 0);
    });
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      minInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className="flex w-full min-w-[282px] max-w-[282px] flex-col gap-compact p-2"
      onKeyDownCapture={(e) => {
        if (e.key !== "Backspace" && e.key !== "Delete") {
          return;
        }
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable=true]")) {
          return;
        }
        e.preventDefault();
        onNavigateBack();
      }}
    >
      <div className="flex items-end gap-tight">
        <div className="min-w-0 flex-1">
          <RangeEndPractice
            bound="min"
            value={min}
            unboundedLabel={t("noMin")}
            parseInput={parse}
            displayScale={displayScale}
            step={step}
            onCommit={commitMin}
            inputRef={minInputRef}
            onEmptyMinBackspace={onNavigateBack}
            onFocusNextField={focusMaxAtStart}
            onEscapeCloseFilter={rangeFullyApplied ? onCloseFilter : undefined}
          />
        </div>

        <span className="shrink-0 pb-2.5 text-xs text-content-muted">{t("to")}</span>

        <div className="min-w-0 flex-1">
          <RangeEndPractice
            bound="max"
            value={max}
            unboundedLabel={t("noMax")}
            parseInput={parse}
            displayScale={displayScale}
            step={step}
            onCommit={commitMax}
            inputRef={maxInputRef}
            onFocusPreviousField={focusMinAtEnd}
            onEscapeCloseFilter={rangeFullyApplied ? onCloseFilter : undefined}
          />
        </div>
      </div>
    </div>
  );
}

export type FilterRangePanelProps = {
  filter: Filter;
  activeToken: string | undefined;
  onApply: (token: string) => void;
  onBack: () => void;
  onClear?: () => void;
  onCloseOuter?: () => void;
  scrollRef?: Ref<HTMLDivElement | null>;
};

export function FilterRangePanel({
  filter,
  activeToken,
  onApply,
  onBack,
  onClear,
  onCloseOuter,
  scrollRef,
}: FilterRangePanelProps) {
  return (
    <>
      <FilterPanelHeader
        label={filter.label}
        onBack={onBack}
        onClear={onClear}
      />
      <FilterScroll ref={scrollRef}>
        <FilterRangeContent
          filter={filter}
          activeToken={activeToken}
          onApply={onApply}
          onNavigateBack={onBack}
          onCloseFilter={onCloseOuter}
        />
      </FilterScroll>
    </>
  );
}
