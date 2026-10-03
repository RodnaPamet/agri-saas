/**
 * Epic 63 — `<TimestampTooltip>` primitive.
 *
 * Verifies the visible-text + tooltip-content + hydration contract:
 *
 *   - past dates render relative phrasing ("about 2 hours ago")
 *   - future dates render "in X" phrasing
 *   - "just now" / sub-minute deltas render "less than a minute ago"
 *   - prefix prepends to the relative phrasing
 *   - tooltip content carries the long-form exact timestamp
 *   - null / undefined / unparseable dates render the empty placeholder
 *     and DON'T mount the Tooltip wrapper
 *   - hydration-safe: with `now=null` (mimicking the SSR + first-render
 *     window) the visible text falls back to the deterministic exact
 *     timestamp instead of a relative string the server would compute
 *     differently from the client
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

// Mock the Tooltip primitive so the test can read `content` directly
// from the DOM rather than driving Radix portals open. The real
// primitive's behaviour is covered in `tests/rendered/tooltip.test.tsx`.
jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({
        children,
        content,
    }: {
        children: React.ReactNode;
        content: React.ReactNode;
    }) => (
        <span data-testid="tooltip-mock">
            {children}
            <span data-testid="tooltip-content">{content}</span>
        </span>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    InfoTooltip: () => null,
}));

import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';

const NOW = new Date('2026-05-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('TimestampTooltip — visible text', () => {
    it('renders past dates with the "X ago" suffix', () => {
        const date = new Date(NOW.getTime() - 2 * HOUR);
        const { container } = render(
            <TimestampTooltip date={date} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/2 hours ago/);
    });

    it('renders future dates with the "in X" prefix', () => {
        const date = new Date(NOW.getTime() + 3 * DAY);
        const { container } = render(
            <TimestampTooltip date={date} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/in 3 days/);
    });

    it('renders sub-minute deltas as "less than a minute ago"', () => {
        const date = new Date(NOW.getTime() - 5_000);
        const { container } = render(
            <TimestampTooltip date={date} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        // includeSeconds: true → "less than a minute ago" / "less than 5 seconds ago"
        expect(visible?.textContent).toMatch(/less than/);
    });

    it('renders future sub-minute deltas with "in" phrasing', () => {
        const date = new Date(NOW.getTime() + 5_000);
        const { container } = render(
            <TimestampTooltip date={date} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/^in /);
    });
});

describe('TimestampTooltip — prefix', () => {
    it('prepends the prefix string to the relative phrasing', () => {
        const date = new Date(NOW.getTime() - 2 * HOUR);
        const { container } = render(
            <TimestampTooltip date={date} now={NOW} prefix="Updated" />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/^Updated /);
        expect(visible?.textContent).toMatch(/2 hours ago/);
    });

    it('handles "Due" prefix on a future date', () => {
        const date = new Date(NOW.getTime() + 7 * DAY);
        const { container } = render(
            <TimestampTooltip date={date} now={NOW} prefix="Due" />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/^Due in 7 days/);
    });
});

describe('TimestampTooltip — tooltip content', () => {
    it('exposes the long-form exact timestamp in the tooltip', () => {
        // 2026-04-16T08:00:45Z — known fixture matching format-date.ts docs.
        const { getByTestId } = render(
            <TimestampTooltip
                date="2026-04-16T08:00:45Z"
                now={NOW}
            />,
        );
        const tooltip = getByTestId('tooltip-content');
        // formatDateTimeLong produces "Thursday, 16 April 2026 at 11:00:45"
        // (en-GB, Europe/Sofia). Do not pin the exact Intl string (separator
        // varies across CLDR data) but require the load-bearing parts.
        expect(tooltip.textContent).toMatch(/16 April 2026/);
        expect(tooltip.textContent).toMatch(/11:00:45/);
        expect(tooltip.textContent).toMatch(/Thursday/);
    });
});

describe('TimestampTooltip — empty / invalid', () => {
    it('renders the default "—" placeholder for null', () => {
        const { container, queryByTestId } = render(
            <TimestampTooltip date={null} now={NOW} />,
        );
        expect(container.textContent).toBe('—');
        // No Tooltip wrapper when there's no useful tooltip content.
        expect(queryByTestId('tooltip-mock')).toBeNull();
    });

    it('renders the default "—" placeholder for undefined', () => {
        const { container } = render(
            <TimestampTooltip date={undefined} now={NOW} />,
        );
        expect(container.textContent).toBe('—');
    });

    it('renders the default "—" placeholder for unparseable strings', () => {
        const { container, queryByTestId } = render(
            <TimestampTooltip date="not-a-date" now={NOW} />,
        );
        expect(container.textContent).toBe('—');
        expect(queryByTestId('tooltip-mock')).toBeNull();
    });

    it('honours a custom `empty` prop', () => {
        const { container } = render(
            <TimestampTooltip date={null} now={NOW} empty="Never" />,
        );
        expect(container.textContent).toBe('Never');
    });
});

describe('TimestampTooltip — hydration safety', () => {
    it('falls back to the exact timestamp when now=null (SSR window)', () => {
        const { container, getByTestId } = render(
            <TimestampTooltip
                date="2026-04-16T08:00:45Z"
                now={null}
            />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        // No relative phrasing on the SSR / first-client render —
        // would otherwise compute differently on each side and
        // trip a hydration mismatch warning.
        expect(visible?.textContent).not.toMatch(/ ago$/);
        expect(visible?.textContent).not.toMatch(/^in /);
        // Visible text mirrors the tooltip — both the deterministic
        // long-form exact string.
        expect(visible?.textContent).toMatch(/16 April 2026/);
        expect(getByTestId('tooltip-content').textContent).toBe(
            visible?.textContent,
        );
    });

    it('prefix still applies during the SSR fallback', () => {
        const { container } = render(
            <TimestampTooltip
                date="2026-04-16T08:00:45Z"
                now={null}
                prefix="Updated"
            />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/^Updated /);
        expect(visible?.textContent).toMatch(/16 April 2026/);
    });
});

describe('TimestampTooltip — additional edge cases', () => {
    it('renders the same instant as "now" without crashing or saying "in"', () => {
        const { container } = render(
            <TimestampTooltip date={NOW} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        // Zero delta — date-fns produces "less than a minute ago".
        expect(visible?.textContent).toMatch(/less than/);
        expect(visible?.textContent).not.toMatch(/^in /);
    });

    it('renders distant past with year-scale phrasing', () => {
        const distant = new Date(NOW.getTime() - 3 * 365 * DAY);
        const { container } = render(
            <TimestampTooltip date={distant} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/3 years ago/);
    });

    it('renders distant future with year-scale phrasing', () => {
        const distant = new Date(NOW.getTime() + 5 * 365 * DAY);
        const { container } = render(
            <TimestampTooltip date={distant} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        // date-fns: "in 5 years" / "in about 5 years" / "in almost 5 years"
        // depending on rounding — accept all three to stay robust to
        // minor library updates.
        expect(visible?.textContent).toMatch(
            /in (5|about 5|almost 5) years/,
        );
    });

    it('handles year-rollover (Dec 30 → Jan 2 next year)', () => {
        const lateDec = new Date('2026-12-30T12:00:00Z');
        const earlyJan = new Date('2027-01-02T12:00:00Z');
        // 3 days across the year boundary — confirms the helper
        // doesn't lose a day or revert to year-scale phrasing
        // when the calendar year flips.
        const { container, getByTestId } = render(
            <TimestampTooltip date={lateDec} now={earlyJan} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/3 days ago/);
        // Tooltip carries the long-form 2026 timestamp across the
        // year boundary.
        expect(getByTestId('tooltip-content').textContent).toMatch(
            /December 2026/,
        );
    });

    it('treats the 60-second boundary as "1 minute" rather than seconds', () => {
        const past = new Date(NOW.getTime() - 65_000);
        const { container } = render(
            <TimestampTooltip date={past} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        // Past the "less than a minute" cliff.
        expect(visible?.textContent).toMatch(/1 minute ago/);
    });

    it('handles ISO strings with millisecond precision', () => {
        const past = new Date(NOW.getTime() - 2 * HOUR);
        const { container, getByTestId } = render(
            <TimestampTooltip date={past.toISOString()} now={NOW} />,
        );
        const visible = container.querySelector(
            '[data-timestamp-tooltip]',
        );
        expect(visible?.textContent).toMatch(/2 hours ago/);
        // Tooltip carries the long-form, hydration-stable timestamp.
        expect(getByTestId('tooltip-content').textContent).toMatch(
            /2026/,
        );
    });

    it('tooltip text is identical regardless of past/future direction', () => {
        const past = new Date(NOW.getTime() - 6 * HOUR);
        const future = new Date(NOW.getTime() + 6 * HOUR);
        const { getByTestId: getPast, unmount } = render(
            <TimestampTooltip date={past} now={NOW} />,
        );
        const pastTooltip = getPast('tooltip-content').textContent;
        unmount();
        const { getByTestId: getFut } = render(
            <TimestampTooltip date={future} now={NOW} />,
        );
        const futureTooltip = getFut('tooltip-content').textContent;
        // Tooltip is the absolute timestamp — it changes by date,
        // not by direction-of-time. Both should be 16-character-ish
        // long-form strings, NOT relative phrases.
        expect(pastTooltip).not.toMatch(/ago/);
        expect(futureTooltip).not.toMatch(/^in /);
        expect(pastTooltip).toMatch(/2026/);
        expect(futureTooltip).toMatch(/2026/);
    });
});

describe('TimestampTooltip — passthrough props', () => {
    it('forwards data-testid to the trigger span', () => {
        const { getByTestId } = render(
            <TimestampTooltip
                date={new Date(NOW.getTime() - HOUR)}
                now={NOW}
                data-testid="evidence-row-updated"
            />,
        );
        expect(getByTestId('evidence-row-updated')).toBeInTheDocument();
    });

    it('forwards className to the trigger span', () => {
        const { container } = render(
            <TimestampTooltip
                date={new Date(NOW.getTime() - HOUR)}
                now={NOW}
                className="text-content-muted"
            />,
        );
        expect(
            container.querySelector('[data-timestamp-tooltip]')
                ?.className,
        ).toContain('text-content-muted');
    });
});
