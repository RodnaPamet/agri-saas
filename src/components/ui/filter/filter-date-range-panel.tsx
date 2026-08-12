"use client";

/**
 * Epic 53 — the `dateRange` facet body.
 *
 * ── Why a second panel, not a mode on the numeric one ────────────────
 *
 * `FilterRangePanel` is a pair of min/max NUMBER inputs, and its codec
 * (`encodeRangeToken`) runs `Math.trunc` on each bound. `Math.trunc` of an
 * ISO date is `NaN`, so the numeric facet cannot carry a date at all — and
 * the obvious workaround (store epoch milliseconds) would put a 13-digit
 * integer in the URL where a person is meant to read a window. A date facet
 * is a different panel with a different codec, not a flag on the numeric
 * one.
 *
 * What the two DO share is the token SHAPE — `"lo|hi"`, with `"|"` as the
 * empty sentinel — so `filterStateToUrlParams`, the active-filter plumbing
 * and the pill all treat both alike. `isRangeType()` in `./types` is how
 * they ask; nothing tests the two literals by hand.
 *
 * ── Why it does not mount `<DateRangePicker>` ────────────────────────
 *
 * `<DateRangePicker>` is a trigger plus its OWN `<Popover>`. This panel is
 * already inside the filter popover, and nesting one dismissable layer in
 * another gives two of them racing for the same Escape key and the same
 * outside-click. So it mounts the `<Calendar>` primitive directly — the
 * same calendar `<DateRangePicker>` renders, one layer shallower.
 *
 * ── The interaction ──────────────────────────────────────────────────
 *
 * Every click commits something the user can read back:
 *
 *   1st click            → `day|day`, a single-day filter. "What did I
 *                          spend on the 12th" is a real question, and a
 *                          panel that applied nothing until a second click
 *                          would make the user guess whether it registered.
 *   2nd click            → the window between the two, ordered.
 *   click after a window → starts over at the new day.
 *
 * The range is driven from OUR click count, not from react-day-picker's
 * range inference — `<DateRangePicker>` learned the same lesson (its
 * `handleCalendarSelect` says so): rdp's inference differs between v8 and
 * v9 and does not reproduce under jsdom, so a test would be asserting the
 * library's behaviour rather than ours.
 *
 * The codec is Epic 58's own `toRangeToken` / `parseRangeToken` from
 * `date-picker/date-utils`, which already emit exactly `"YYYY-MM-DD|…"` and
 * are UTC-anchored — so a farmer in UTC+3 and the server agree on which
 * calendar day was picked. Re-spelling it here would be a second definition
 * of one format.
 *
 * An OPEN-ended token (`"2026-03-01|"`) round-trips correctly through the
 * panel and the pill even though the calendar cannot produce one: a shared
 * or hand-edited URL can carry it, and rendering it as "1 Mar 2026 – no max"
 * is cheaper than deciding what a half-parsed filter means at read time.
 */

import { formatDate } from "@/lib/format-date";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, type Ref } from "react";
import type { DateRange as RDPDateRange } from "react-day-picker";

import { Calendar } from "../date-picker/calendar";
import {
  fromDateRangeValue,
  normalizeRange,
  parseRangeToken as parseDateRangeToken,
  toDateRangeValue,
  toRangeToken as encodeDateRangeToken,
} from "../date-picker/date-utils";
import { FilterPanelHeader } from "./filter-range-panel";
import { FilterScroll } from "./filter-scroll";
import type { Filter } from "./types";

export type FilterDateRangePanelProps = {
  filter: Filter;
  /** `"YYYY-MM-DD|YYYY-MM-DD"`, either side optionally blank. */
  activeToken: string | undefined;
  onApply: (token: string) => void;
  onBack: () => void;
  onClear?: () => void;
  scrollRef?: Ref<HTMLDivElement | null>;
};

export function FilterDateRangePanel({
  filter,
  activeToken,
  onApply,
  onBack,
  onClear,
  scrollRef,
}: FilterDateRangePanelProps) {
  const t = useTranslations("ui.filter");

  const value = useMemo(
    () => normalizeRange(parseDateRangeToken(activeToken)),
    [activeToken],
  );

  /** The same window in react-day-picker's LOCAL-midnight space. */
  const rdpRange = useMemo(() => fromDateRangeValue(value), [value]);

  const handleSelect = useCallback(
    (_next: RDPDateRange | undefined, clickedDay: Date) => {
      // react-day-picker emits a LOCAL-midnight Date. `toDateRangeValue` is
      // the documented bridge that re-anchors it to UTC-midnight on the same
      // calendar day — without it a click on the 20th is stored as the 19th
      // in any timezone ahead of UTC, which is most of this product's users.
      const { from: clicked } = toDateRangeValue({
        from: clickedDay,
        to: undefined,
      });
      if (!clicked) return;

      // A window is still an ANCHOR while it spans one day (`X|X`, what the
      // first click commits) or has an open end (`X|`, which only a shared
      // URL produces). A real multi-day window is FINISHED, so the next
      // click starts over rather than silently widening it.
      const anchor =
        value.from &&
        (!value.to || value.to.getTime() === value.from.getTime())
          ? value.from
          : null;

      const next = anchor
        ? clicked.getTime() < anchor.getTime()
          ? { from: clicked, to: anchor }
          : { from: anchor, to: clicked }
        : { from: clicked, to: clicked };
      onApply(encodeDateRangeToken(normalizeRange(next)));
    },
    [onApply, value.from, value.to],
  );

  const summary =
    value.from || value.to
      ? `${value.from ? formatDate(value.from) : t("noMin")} – ${
          value.to ? formatDate(value.to) : t("noMax")
        }`
      : t("anyDate");

  return (
    <>
      <FilterPanelHeader label={filter.label} onBack={onBack} onClear={onClear} />
      <FilterScroll ref={scrollRef}>
        <div className="p-2">
          <p
            className="px-1 pb-2 text-xs text-content-muted"
            aria-live="polite"
          >
            {summary}
          </p>
          <Calendar
            mode="range"
            numberOfMonths={1}
            selected={rdpRange}
            onSelect={handleSelect}
            // The LOCAL-anchored `from`, not the UTC one. react-day-picker
            // reads local components off `defaultMonth`, so handing it a
            // UTC-midnight date opens the calendar on the PREVIOUS month for
            // every user west of UTC — a window starting 1 August would
            // open on July.
            defaultMonth={rdpRange.from}
          />
        </div>
      </FilterScroll>
    </>
  );
}
