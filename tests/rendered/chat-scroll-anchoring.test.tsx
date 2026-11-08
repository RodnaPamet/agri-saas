/**
 * Prepending older messages must not move the reader (#2826).
 *
 * ## The defect, and why the obvious fix does not work
 *
 * `react-window@2.5.3` keys its measurement cache by INDEX —
 * `getRowHeight(index)` / `setRowHeight(index, size)` — and v2 removed
 * `itemKey`. So inserting a page of older messages above the viewport
 * re-points every cached height at a DIFFERENT message. `observeRowElements`
 * re-measures what is on screen, so the visible window corrects itself; the
 * estimated extent of everything ABOVE stays wrong until it has been scrolled
 * through. Restoring a scroll OFFSET therefore restores a number that no
 * longer means what it meant.
 *
 * So the anchor is a ROW IDENTITY plus how far below the viewport's top edge
 * it was sitting, and `restore()` recomputes the offset from where that row
 * has ended up.
 *
 * ## What jsdom can and cannot say here
 *
 * There is no layout engine: `offsetTop` and `offsetHeight` are 0 for every
 * element, so a test that scrolled and asserted a pixel would be grading
 * jsdom's zeros. Two halves instead:
 *
 *   1. `anchoredScrollTop` is a PURE function and is tested as one, including
 *      the clamp — a prepend can leave the anchor nearer the top than it was.
 *   2. the DOM half is exercised with `offsetTop` / `offsetHeight` DEFINED on
 *      the row elements, which jsdom permits. That is not a simulation of
 *      layout: it is supplying the one input the algorithm reads, so what runs
 *      is the real `anchor()` / `restore()` against real elements.
 *
 * `rowTopOf` prefers an inline `style.top` because the windowed branch
 * absolute-positions rows from one — react-window writes the position it
 * decided, and `offsetTop` is the browser's reading of it.
 */
import { render } from '@testing-library/react';
import * as React from 'react';

import {
    MessageTimeline,
    anchoredScrollTop,
    rowTopOf,
    type MessageTimelineHandle,
    type TimelineMessage,
} from '@/components/chat/message-timeline';

import { restoreViewport, setViewport } from './viewport';

const ME = 'u-me';
const THEM = 'u-them';

function msg(n: number, who = THEM): TimelineMessage {
    return {
        id: `m${n}`,
        senderUserId: who,
        body: `message ${n}`,
        // Same day for every row, so no day pill splits the run and the row
        // keys stay one-to-one with the messages.
        createdAt: new Date(Date.UTC(2026, 10, 8, 9, n)),
    };
}

afterEach(restoreViewport);

describe('anchoredScrollTop — the arithmetic', () => {
    it('puts the row back at the same distance below the top edge', () => {
        expect(anchoredScrollTop(1000, 40)).toBe(960);
        expect(anchoredScrollTop(40, 40)).toBe(0);
    });

    it('CLAMPS at zero', () => {
        // A prepend can leave the anchor nearer the top than it was: the
        // reader was already at the very top and asked for more. A negative
        // `scrollTop` is silently coerced by the browser, which would make a
        // wrong answer look right — so the clamp is here, where it can be
        // asserted.
        expect(anchoredScrollTop(10, 40)).toBe(0);
        expect(anchoredScrollTop(0, 0)).toBe(0);
    });
});

describe('rowTopOf — which position is authoritative', () => {
    it('prefers an inline style.top, because react-window WROTE it', () => {
        const el = document.createElement('div');
        el.style.top = '320px';
        Object.defineProperty(el, 'offsetTop', { value: 999, configurable: true });
        expect(rowTopOf(el)).toBe(320);
    });

    it('falls back to offsetTop in the plain branch, which sets no inline top', () => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetTop', { value: 77, configurable: true });
        expect(rowTopOf(el)).toBe(77);
    });

    it('ignores an inline top that is not a pixel length', () => {
        // `top: auto` is what an unpositioned element reports, and
        // `parseFloat('auto')` is NaN — which would propagate into a
        // `scrollTop` assignment and move the reader to the top of the thread.
        const el = document.createElement('div');
        el.style.top = 'auto';
        Object.defineProperty(el, 'offsetTop', { value: 55, configurable: true });
        expect(rowTopOf(el)).toBe(55);
    });
});

/** Give every row a height and a stacked top, which jsdom will not. */
function layOut(scroller: HTMLElement, rowPx = 50): void {
    const rows = scroller.querySelectorAll<HTMLElement>('[data-row-key]');
    rows.forEach((el, i) => {
        Object.defineProperty(el, 'offsetTop', { value: i * rowPx, configurable: true });
        Object.defineProperty(el, 'offsetHeight', { value: rowPx, configurable: true });
    });
}

describe('anchor() / restore() across a PREPEND', () => {
    it('returns the reader to the row they were looking at', () => {
        const ref = React.createRef<MessageTimelineHandle>();
        const first = [msg(10), msg(11), msg(12), msg(13)];
        const { rerender } = render(
            <MessageTimeline ref={ref} messages={first} myUserId={ME} virtualize={false} />,
        );

        const scroller = document.querySelector<HTMLElement>('[data-timeline-mode="plain"]')!;
        layOut(scroller);

        // THE DAY PILL IS A ROW, which is the whole point of
        // `buildTimelineRows` flattening the timeline: react-window addresses
        // rows by index, so a nested "day → messages" tree has no index to
        // address. So the rows here are
        //
        //     0 day:2026-11-08   1 m10   2 m11   3 m12   4 m13
        //
        // at 50px each. The first draft of this test expected `m12` at
        // scrollTop 120 and got `m11`; the implementation was right and the
        // expectation had forgotten the pill.
        const keysBefore = [...scroller.querySelectorAll<HTMLElement>('[data-row-key]')]
            .map((el) => el.dataset.rowKey);
        expect(keysBefore).toEqual(['day:2026-11-08', 'm10', 'm11', 'm12', 'm13']);

        // The reader is 20px into row 2 (top 100 ⇒ `m11`).
        scroller.scrollTop = 120;
        const anchor = ref.current!.anchor();
        expect(anchor).toEqual({ key: 'm11', offsetInViewport: -20 });

        // PREPEND two older messages. Every index shifts by two, which is
        // exactly what the measurement cache cannot survive.
        rerender(
            <MessageTimeline
                ref={ref}
                messages={[msg(8), msg(9), ...first]}
                myUserId={ME}
                virtualize={false}
            />,
        );
        layOut(scroller);

        // CONTROL: without restoring, the offset now points at a DIFFERENT
        // message — which is the jump this phase is about. Row 2 was `m11`
        // and is now `m9`.
        expect(scroller.scrollTop).toBe(120);
        const atOldOffset = scroller.querySelectorAll<HTMLElement>('[data-row-key]')[2];
        expect(atOldOffset.dataset.rowKey).toBe('m9');

        ref.current!.restore(anchor);
        // `m11` is now index 4 ⇒ top 200, and the reader was 20px past its
        // top, so 220. Two rows prepended × 50px is exactly the 100px shift.
        expect(scroller.scrollTop).toBe(220);
    });

    it('anchors the TOPMOST row still in view, not one scrolled past', () => {
        const ref = React.createRef<MessageTimelineHandle>();
        render(
            <MessageTimeline
                ref={ref}
                messages={[msg(1), msg(2), msg(3)]}
                myUserId={ME}
                virtualize={false}
            />,
        );
        const scroller = document.querySelector<HTMLElement>('[data-timeline-mode="plain"]')!;
        layOut(scroller);

        // Exactly at the boundary: row 0 (the day pill) occupies 0–50, so at
        // 50 it is fully past and row 1 — `m1` — is the one being read.
        // Anchoring to row 0 would scroll the reader BACKWARDS by its height
        // on every restore.
        scroller.scrollTop = 50;
        expect(ref.current!.anchor()).toEqual({ key: 'm1', offsetInViewport: 0 });
    });

    it('is a NO-OP when the anchor row is gone, rather than guessing', () => {
        const ref = React.createRef<MessageTimelineHandle>();
        render(
            <MessageTimeline
                ref={ref}
                messages={[msg(1), msg(2)]}
                myUserId={ME}
                virtualize={false}
            />,
        );
        const scroller = document.querySelector<HTMLElement>('[data-timeline-mode="plain"]')!;
        layOut(scroller);
        scroller.scrollTop = 25;

        ref.current!.restore({ key: 'm-deleted', offsetInViewport: 10 });
        // Unchanged. A row that vanished between capture and restore means
        // guessing a position for it, and leaving the reader put is better.
        expect(scroller.scrollTop).toBe(25);
    });

    it('restore(null) does nothing — a failed page must not move anybody', () => {
        const ref = React.createRef<MessageTimelineHandle>();
        render(
            <MessageTimeline ref={ref} messages={[msg(1)]} myUserId={ME} virtualize={false} />,
        );
        const scroller = document.querySelector<HTMLElement>('[data-timeline-mode="plain"]')!;
        layOut(scroller);
        scroller.scrollTop = 17;
        ref.current!.restore(null);
        expect(scroller.scrollTop).toBe(17);
    });

    it('anchor() is null on an EMPTY timeline', () => {
        const ref = React.createRef<MessageTimelineHandle>();
        render(<MessageTimeline ref={ref} messages={[]} myUserId={ME} virtualize={false} />);
        expect(ref.current!.anchor()).toBeNull();
    });
});

describe('the timeline OWNS its scroller in both branches', () => {
    it('the plain branch scrolls itself', () => {
        render(
            <MessageTimeline messages={[msg(1)]} myUserId={ME} virtualize={false} />,
        );
        const el = document.querySelector<HTMLElement>('[data-timeline-mode="plain"]')!;
        // The page used to supply this. With both branches live there were two
        // scrollers and a prepend had to be anchored in whichever one happened
        // to be real.
        expect(el.className).toContain('overflow-y-auto');
    });

    it('every row carries its KEY, which is what survives a prepend', () => {
        setViewport('desktop');
        render(
            <MessageTimeline
                messages={[msg(1), msg(2)]}
                myUserId={ME}
                virtualize={false}
            />,
        );
        const keys = [...document.querySelectorAll<HTMLElement>('[data-row-key]')]
            .map((el) => el.dataset.rowKey);
        // An INDEX is exactly what a prepend invalidates — the whole defect —
        // so the attribute is the row's own key.
        expect(keys).toEqual(['day:2026-11-08', 'm1', 'm2']);
    });
});
