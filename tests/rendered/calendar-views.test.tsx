/**
 * Epic 49 — render tests for the calendar UI surfaces.
 *
 * Covers:
 *   - CalendarMonth — grid shape, selection, double-click
 *   - CalendarMonth — event dots, multi-event days, +N more, today ring
 *   - GanttTimeline — duration bars, today marker, empty state
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/calendar',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CalendarMonth } from '@/components/ui/CalendarMonth';
import { GanttTimeline } from '@/components/ui/GanttTimeline';
import type { CalendarEvent } from '@/app-layer/schemas/calendar.schemas';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        id: 'TASK:t-1:task-due',
        type: 'task-due',
        category: 'task',
        titleKey: 'taskDue',
        titleParams: { name: 'Task' },
        date: '2026-06-15T00:00:00.000Z',
        status: 'scheduled',
        entityType: 'TASK',
        entityId: 't-1',
        href: '/t/acme/farm-tasks/t-1',
        ...overrides,
    };
}

// ─── CalendarMonth ───────────────────────────────────────────────────

describe('<CalendarMonth />', () => {
    const MONTH = new Date('2026-06-15T00:00:00Z');
    const TODAY = new Date('2026-06-15T00:00:00Z');

    it('renders 7 weekday headers + a 6×7 day grid (or 5×7 when month fits)', () => {
        render(<CalendarMonth month={MONTH} events={[]} today={TODAY} />);
        expect(screen.getByText('Sun')).toBeInTheDocument();
        expect(screen.getByText('Sat')).toBeInTheDocument();
        const grid = screen.getByTestId('calendar-month');
        // June 2026 has 30 days. Total cells = padStart + 30 + padEnd.
        const cells = grid.querySelectorAll('[data-ymd]');
        expect(cells.length % 7).toBe(0);
    });

    it('renders one event dot per event and respects maxDotsPerDay overflow', () => {
        const events: CalendarEvent[] = Array.from({ length: 5 }).map((_, i) =>
            makeEvent({
                id: `t-${i}`,
                date: '2026-06-15T00:00:00.000Z',
                titleKey: 'raw', titleParams: { name: `Event ${i}` },
            }),
        );
        const { container } = render(
            <CalendarMonth
                month={MONTH}
                events={events}
                today={TODAY}
                maxDotsPerDay={3}
            />,
        );
        const cell = container.querySelector('[data-ymd="2026-06-15"]')!;
        const eventLinks = cell.querySelectorAll('[data-event-id]');
        expect(eventLinks).toHaveLength(3);
        expect(cell.textContent).toMatch(/\+2 more/);
    });

    it('marks today with the data-today attribute', () => {
        const { container } = render(
            <CalendarMonth month={MONTH} events={[]} today={TODAY} />,
        );
        const todayCell = container.querySelector('[data-today="true"]');
        expect(todayCell).toBeInTheDocument();
        expect(todayCell?.getAttribute('data-ymd')).toBe('2026-06-15');
    });

    it('fires onSelectDate when a day-number button is clicked', async () => {
        const user = userEvent.setup();
        const onSelectDate = jest.fn();
        render(
            <CalendarMonth
                month={MONTH}
                events={[]}
                today={TODAY}
                onSelectDate={onSelectDate}
            />,
        );
        // Click day 15 button. The label includes "<ymd>: 0 events".
        const dayBtn = screen.getByRole('button', {
            name: /2026-06-15: 0 events/i,
        });
        await user.click(dayBtn);
        expect(onSelectDate).toHaveBeenCalledWith('2026-06-15');
    });

    // v2-fu-6 — the entire cell must be clickable (not just the
    // number). User reported that clicking the empty area in a day
    // box did nothing.
    it('fires onSelectDate when an empty area inside the cell is clicked', async () => {
        const user = userEvent.setup();
        const onSelectDate = jest.fn();
        render(
            <CalendarMonth
                month={MONTH}
                events={[]}
                today={TODAY}
                onSelectDate={onSelectDate}
            />,
        );
        // Click the cell `<div data-ymd>` directly — NOT the
        // number button. The cell is the outer container; clicking
        // anywhere inside it (other than a child link/button) should
        // fire onSelectDate.
        const cell = document.querySelector(
            '[data-ymd="2026-06-15"]',
        ) as HTMLElement;
        expect(cell).not.toBeNull();
        await user.click(cell);
        expect(onSelectDate).toHaveBeenCalledWith('2026-06-15');
    });

    it('does NOT fire onSelectDate when an event link inside the cell is clicked', async () => {
        const user = userEvent.setup();
        const onSelectDate = jest.fn();
        render(
            <CalendarMonth
                month={MONTH}
                events={[
                    makeEvent({
                        id: 'TASK:t-1:task',
                        titleKey: 'raw', titleParams: { name: 'Pay invoice' },
                        category: 'task',
                        date: '2026-06-15T00:00:00.000Z',
                    }),
                ]}
                today={TODAY}
                onSelectDate={onSelectDate}
            />,
        );
        // Click the event link — should navigate (we just check
        // onSelectDate is NOT fired; navigation is a Next.js Link).
        const eventLink = screen.getByTitle(/Pay invoice/);
        await user.click(eventLink);
        expect(onSelectDate).not.toHaveBeenCalled();
    });

    it('shows cursor-pointer + hover on cells when onSelectDate is supplied', () => {
        const { container } = render(
            <CalendarMonth
                month={MONTH}
                events={[]}
                today={TODAY}
                onSelectDate={() => undefined}
            />,
        );
        const cell = container.querySelector('[data-ymd="2026-06-15"]');
        expect(cell?.className).toContain('cursor-pointer');
    });

    it('does NOT add cursor-pointer when onSelectDate is omitted (read-only calendar)', () => {
        const { container } = render(
            <CalendarMonth month={MONTH} events={[]} today={TODAY} />,
        );
        const cell = container.querySelector('[data-ymd="2026-06-15"]');
        expect(cell?.className).not.toContain('cursor-pointer');
    });
});

// ─── GanttTimeline ───────────────────────────────────────────────────

describe('<GanttTimeline />', () => {
    const FROM = new Date('2026-01-01T00:00:00Z');
    const TO = new Date('2026-12-31T00:00:00Z');
    const TODAY = new Date('2026-06-15T00:00:00Z');

    it('renders a bar per duration event', () => {
        const events = [
            makeEvent({
                id: 'AUDIT_CYCLE:c-1:audit-cycle',
                category: 'audit',
                titleKey: 'raw', titleParams: { name: 'Q3 SOC2' },
                date: '2026-06-01T00:00:00.000Z',
                end: '2026-08-31T00:00:00.000Z',
                entityType: 'AUDIT_CYCLE',
                entityId: 'c-1',
                href: '/t/acme/audits/cycles/c-1',
            }),
        ];
        render(
            <GanttTimeline
                from={FROM}
                to={TO}
                events={events}
                today={TODAY}
            />,
        );
        const bar = screen.getByRole('listitem');
        expect(bar).toBeInTheDocument();
        expect(bar.textContent).toContain('Q3 SOC2');
    });

    it('renders the today marker when today falls inside the range', () => {
        render(
            <GanttTimeline
                from={FROM}
                to={TO}
                events={[
                    makeEvent({
                        id: 'AUDIT_CYCLE:c-1:audit-cycle',
                        category: 'audit',
                        titleKey: 'raw', titleParams: { name: 'A' },
                        date: '2026-06-01T00:00:00.000Z',
                        end: '2026-08-31T00:00:00.000Z',
                    }),
                ]}
                today={TODAY}
            />,
        );
        expect(screen.getByTestId('gantt-today-marker')).toBeInTheDocument();
    });

    it('renders the empty state when no events are in range', () => {
        render(<GanttTimeline from={FROM} to={TO} events={[]} today={TODAY} />);
        const root = screen.getByTestId('gantt-timeline');
        expect(root.textContent).toMatch(/no timeline events/i);
    });
});
