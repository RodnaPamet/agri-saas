/**
 * P8.3 — the chat primitives, rendered (#2797).
 *
 * ## What each viewport is asserting, and why it is stated
 *
 * `tests/rendered/setup.ts` answers `matches: false` to every media query, so
 * the jsdom default is a PHONE. Every block below therefore calls
 * `setViewport` explicitly — not because these primitives branch on the
 * viewport (they do not; they are width-fluid by design, which is itself worth
 * pinning) but because a suite that INHERITS the default is green about a
 * viewport nobody chose. §7 is the one that would notice a future branch
 * appearing: it mounts the same timeline at both and requires identical row
 * structure.
 *
 * ## The two assertions that would survive a rewrite
 *
 * §3 pins the Europe/Sofia day boundary with an instant whose UTC day and
 * Sofia day DIFFER. A `chatDayKey` quietly reimplemented as `toISOString()
 * .slice(0, 10)` passes every other test in this file.
 *
 * §6 pins the windowed branch's node budget, which is Epic 68's whole
 * performance contract and the only thing that distinguishes "virtualized" from
 * "rendered all 1,200 rows inside a div that says virtualized".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { TooltipProvider } from '@/components/ui/tooltip';

import { restoreViewport, setViewport } from './viewport';

import { chatDayKey, DayPill } from '@/components/chat/day-pill';
import { MessageBubble } from '@/components/chat/message-bubble';
import { MessageComposer } from '@/components/chat/message-composer';
import {
    buildTimelineRows,
    MessageTimeline,
    TIMELINE_VIRTUALIZE_THRESHOLD,
    type TimelineMessage,
} from '@/components/chat/message-timeline';
import { NewMessagesDivider } from '@/components/chat/new-messages-divider';
import { useKeyboardInset } from '@/components/chat/use-keyboard-inset';
// EN: setup.ts resolves English whatever the provider is handed; the Bulgarian
// parity is the i18n gate's job, not this suite's.
import messages from '../../messages/en/app.json';

const COPY = messages.chat;

const ME = 'user-me';
const THEM = 'user-them';

/**
 * `TooltipProvider` is here because `src/app/providers.tsx` mounts one around
 * the whole app, and `MessageBubble`'s reaction control is an `<IconAction>`,
 * which is a Radix Tooltip trigger. Rendering the bubble without it throws
 * «`Tooltip` must be used within `TooltipProvider`» — so the provider is part
 * of this component's real environment, not test scaffolding.
 */
function mount(ui: React.ReactElement) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
        </NextIntlClientProvider>,
    );
}

function msg(over: Partial<TimelineMessage> & { id: string }): TimelineMessage {
    return {
        senderUserId: THEM,
        body: `body ${over.id}`,
        createdAt: new Date('2026-11-07T09:00:00Z'),
        ...over,
    };
}

afterEach(restoreViewport);

// ───────────────────────── §1 DayPill ─────────────────────────

describe('DayPill', () => {
    beforeEach(() => setViewport('mobile'));

    const NOW = new Date('2026-11-07T12:00:00Z');

    // Each case UNMOUNTS before the next. Three `mount` calls in one block
    // leave three pills in the document, so the "anything older" case found
    // the first case's «Today» and the negative assertion was about the wrong
    // element — green would have been the lucky direction.
    it.each([
        ['today', '2026-11-07T08:00:00Z', COPY.today],
        ['yesterday', '2026-11-06T08:00:00Z', COPY.yesterday],
    ])('names %s', (_label, iso, expected) => {
        const view = mount(<DayPill at={new Date(iso)} now={NOW} />);
        expect(screen.getByText(expected)).toBeInTheDocument();
        view.unmount();
    });

    it('dates anything older than yesterday', () => {
        mount(<DayPill at={new Date('2026-10-30T08:00:00Z')} now={NOW} />);
        expect(screen.queryByText(COPY.today)).not.toBeInTheDocument();
        expect(screen.queryByText(COPY.yesterday)).not.toBeInTheDocument();
        expect(screen.getByText(/2026/)).toBeInTheDocument();
    });

    it('carries the real date in aria-label even when the text says Today', () => {
        // A screen-reader user scrolling a long thread gets no benefit from
        // "Today" repeated at every pill; the date is what locates them.
        const { container } = mount(<DayPill at={new Date('2026-11-07T08:00:00Z')} now={NOW} />);
        const label = container.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
        expect(screen.getByText(COPY.today)).toBeInTheDocument();
        expect(label).not.toBe(COPY.today);
        expect(label).toMatch(/2026/);
    });
});

// ─────────────────── §2 divider and bubble ───────────────────

describe('NewMessagesDivider', () => {
    beforeEach(() => setViewport('mobile'));

    it('is a separator carrying the localised label', () => {
        mount(<NewMessagesDivider />);
        expect(screen.getByRole('separator')).toBeInTheDocument();
        expect(screen.getByText(COPY.newMessages)).toBeInTheDocument();
    });
});

describe('MessageBubble', () => {
    beforeEach(() => setViewport('mobile'));

    const AT = new Date('2026-11-07T09:00:00Z');

    it('gives the two parties different, REAL background tokens', () => {
        const mine = mount(<MessageBubble body="mine" createdAt={AT} mine />);
        const theirs = mount(<MessageBubble body="theirs" createdAt={AT} mine={false} />);

        const classOf = (c: HTMLElement, text: string) =>
            Array.from(c.querySelectorAll<HTMLElement>('*')).find((el) =>
                el.className?.toString?.().includes('bg-bg-'),
            )?.className ?? '';

        const mineClass = classOf(mine.container, 'mine');
        const theirsClass = classOf(theirs.container, 'theirs');
        expect(mineClass).not.toBe(theirsClass);
        // Tailwind drops an unknown class silently, so a bubble with NO
        // background is indistinguishable from a styled one in jsdom unless the
        // token names themselves are asserted.
        expect(`${mineClass} ${theirsClass}`).toContain('bg-bg-muted');
        expect(`${mineClass} ${theirsClass}`).toContain('bg-bg-default');
    });

    it('shows the deleted copy instead of the body, and no edited marker', () => {
        mount(
            <MessageBubble
                body="the original text"
                createdAt={AT}
                editedAt={AT}
                deletedAt={AT}
                mine
            />,
        );
        expect(screen.getByText(COPY.messageDeleted)).toBeInTheDocument();
        expect(screen.queryByText('the original text')).not.toBeInTheDocument();
        expect(screen.queryByText(COPY.edited)).not.toBeInTheDocument();
    });

    it('collapses one reaction row PER PERSON into one pill with a count', () => {
        // `MessageReaction` is unique on (message, user, emoji), so three
        // people liking a message arrive as three rows. One pill each would
        // put three identical glyphs on the bubble.
        const { container } = mount(
            <MessageBubble
                body="hello"
                createdAt={AT}
                mine={false}
                reactions={[
                    { userId: 'u1', emoji: '👍' },
                    { userId: 'u2', emoji: '👍' },
                    { userId: 'u3', emoji: '🌾' },
                    { userId: 'u4', emoji: '👍' },
                ]}
            />,
        );
        const pills = Array.from(container.querySelectorAll('.rounded-full')).map(
            (el) => el.textContent,
        );
        expect(pills).toEqual(['👍 3', '🌾']);
    });

    it('renders no reaction row at all when there are none', () => {
        const { container } = mount(<MessageBubble body="hello" createdAt={AT} mine />);
        expect(container.querySelectorAll('.rounded-full')).toHaveLength(0);
    });

    it('marks an edited message that is not deleted', () => {
        mount(<MessageBubble body="hello" createdAt={AT} editedAt={AT} mine />);
        expect(screen.getByText(COPY.edited)).toBeInTheDocument();
        expect(screen.getByText('hello')).toBeInTheDocument();
    });
});

// ──────────── §3 the Sofia day boundary (the load-bearing one) ────────────

describe('chatDayKey', () => {
    it('cuts the day at Europe/Sofia midnight, not UTC midnight', () => {
        // 21:00Z is 23:00 Sofia the SAME day; 22:30Z is 00:30 Sofia the NEXT.
        // Both are the same UTC day, so a UTC-based key makes them equal.
        const before = chatDayKey(new Date('2026-03-15T21:00:00Z'));
        const after = chatDayKey(new Date('2026-03-15T22:30:00Z'));
        expect(before).not.toBe(after);
        expect(before).toBe('2026-03-15');
        expect(after).toBe('2026-03-16');
    });
});

// ───────────────── §4 row structure: days, grouping, divider ─────────────────

describe('buildTimelineRows', () => {
    it('opens with a day pill and groups a consecutive run by one sender', () => {
        const rows = buildTimelineRows(
            [
                msg({ id: 'a', createdAt: new Date('2026-11-07T09:00:00Z') }),
                msg({ id: 'b', createdAt: new Date('2026-11-07T09:01:00Z') }),
                msg({ id: 'c', senderUserId: ME, createdAt: new Date('2026-11-07T09:02:00Z') }),
            ],
            ME,
        );

        expect(rows.map((r) => r.kind)).toEqual(['day', 'message', 'message', 'message']);
        const bubbles = rows.filter((r) => r.kind === 'message');
        expect(bubbles.map((r) => (r as { grouped: boolean }).grouped)).toEqual([
            false,
            true,
            false,
        ]);
        expect(bubbles.map((r) => (r as { mine: boolean }).mine)).toEqual([false, false, true]);
    });

    it('breaks a same-sender run across a Sofia midnight', () => {
        const rows = buildTimelineRows(
            [
                msg({ id: 'a', createdAt: new Date('2026-03-15T21:00:00Z') }),
                msg({ id: 'b', createdAt: new Date('2026-03-15T22:30:00Z') }),
            ],
            ME,
        );

        // Two pills, and the second message is NOT grouped — a grouped bubble
        // renders with no sender label and tight spacing, so grouping it across
        // a visible date pill would read as one continuous run.
        expect(rows.map((r) => r.kind)).toEqual(['day', 'message', 'day', 'message']);
        const second = rows[3] as { grouped: boolean };
        expect(second.grouped).toBe(false);
    });

    it('places the divider before the first unread and un-groups it', () => {
        const rows = buildTimelineRows(
            [
                msg({ id: 'a', createdAt: new Date('2026-11-07T09:00:00Z') }),
                msg({ id: 'b', createdAt: new Date('2026-11-07T09:01:00Z') }),
                msg({ id: 'c', createdAt: new Date('2026-11-07T09:02:00Z') }),
            ],
            ME,
            'b',
        );

        expect(rows.map((r) => r.kind)).toEqual([
            'day',
            'message',
            'divider',
            'message',
            'message',
        ]);
        expect((rows[3] as { grouped: boolean }).grouped).toBe(false);
        // …and the one AFTER it groups again, so the divider breaks the run
        // without resetting the whole thread.
        expect((rows[4] as { grouped: boolean }).grouped).toBe(true);
    });

    it('emits no divider for a null cursor or an id that is not on the page', () => {
        const input = [msg({ id: 'a' }), msg({ id: 'b' })];
        for (const cursor of [null, undefined, 'not-here']) {
            const rows = buildTimelineRows(input, ME, cursor);
            expect(rows.some((r) => r.kind === 'divider')).toBe(false);
        }
    });
});

// ───────────────── §5/§6 the virtualization threshold and budget ─────────────

function manyMessages(count: number): TimelineMessage[] {
    const base = Date.parse('2026-11-07T09:00:00Z');
    return Array.from({ length: count }, (_, i) =>
        msg({
            id: `m${i}`,
            // Alternate senders so grouping does not collapse the run, and keep
            // every message inside one Sofia day so the row count is
            // count + 1 (one day pill).
            senderUserId: i % 2 === 0 ? ME : THEM,
            createdAt: new Date(base + i * 1000),
        }),
    );
}

describe('MessageTimeline virtualization', () => {
    beforeEach(() => setViewport('desktop'));

    it('renders plain DOM below the threshold', () => {
        const { container } = mount(
            <MessageTimeline messages={manyMessages(20)} myUserId={ME} height={600} />,
        );
        expect(container.querySelector('[data-timeline-mode="plain"]')).not.toBeNull();
        expect(container.querySelector('[data-timeline-mode="virtualized"]')).toBeNull();
    });

    it('windows above the threshold and keeps the node budget', () => {
        const count = TIMELINE_VIRTUALIZE_THRESHOLD + 200;
        const { container } = mount(
            <MessageTimeline messages={manyMessages(count)} myUserId={ME} height={600} />,
        );
        expect(container.querySelector('[data-timeline-mode="virtualized"]')).not.toBeNull();

        // Epic 68's contract: ≤30 row nodes regardless of dataset size.
        const rendered = container.querySelectorAll('[data-timeline-mode] > div > div');
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered.length).toBeLessThanOrEqual(30);
        expect(rendered.length).toBeLessThan(count);
    });

    it('keeps the node budget after PREPENDING older pages', () => {
        // A chat timeline is the one surface that stresses this primitive: it
        // grows at the TOP while the viewport is pinned to the BOTTOM, which is
        // the opposite of every other windowed list in the product. Paging up
        // three times re-indexes every row that was already on screen, so the
        // question is whether the ≤30-node invariant survives the re-index —
        // the static mount above cannot answer it.
        const newest = manyMessages(TIMELINE_VIRTUALIZE_THRESHOLD + 200);
        const { container, rerender } = mount(
            <MessageTimeline messages={newest} myUserId={ME} height={600} />,
        );

        const base = Date.parse('2026-11-07T09:00:00Z');
        let all = newest;
        for (let page = 1; page <= 3; page += 1) {
            const older = Array.from({ length: 200 }, (_, i) =>
                msg({
                    id: `older-${page}-${i}`,
                    senderUserId: i % 2 === 0 ? ME : THEM,
                    // Earlier than everything already loaded, and still inside
                    // the same Sofia day so the row count stays predictable.
                    createdAt: new Date(base - (page * 200 - i) * 1000),
                }),
            );
            all = [...older, ...all];
            rerender(
                <NextIntlClientProvider locale="en" messages={messages}>
                    <TooltipProvider delayDuration={0}>
                        <MessageTimeline messages={all} myUserId={ME} height={600} />
                    </TooltipProvider>
                </NextIntlClientProvider>,
            );

            const rendered = container.querySelectorAll('[data-timeline-mode] > div > div');
            expect(rendered.length).toBeGreaterThan(0);
            expect(rendered.length).toBeLessThanOrEqual(30);
        }

        expect(all.length).toBe(TIMELINE_VIRTUALIZE_THRESHOLD + 800);
        expect(container.querySelector('[data-timeline-mode="virtualized"]')).not.toBeNull();
    });

    it('honours virtualize={false} at 1200 rows and a custom threshold at 3', () => {
        const forced = mount(
            <MessageTimeline
                messages={manyMessages(TIMELINE_VIRTUALIZE_THRESHOLD + 200)}
                myUserId={ME}
                virtualize={false}
                height={600}
            />,
        );
        expect(forced.container.querySelector('[data-timeline-mode="plain"]')).not.toBeNull();

        const lowered = mount(
            <MessageTimeline
                messages={manyMessages(3)}
                myUserId={ME}
                virtualize={{ threshold: 2 }}
                height={600}
            />,
        );
        expect(lowered.container.querySelector('[data-timeline-mode="virtualized"]')).not.toBeNull();
    });
});

// ───────────── §7 the same timeline at both viewports ─────────────

describe('MessageTimeline is width-fluid', () => {
    it('renders the same rows on a phone and on a desktop', () => {
        const input = [
            msg({ id: 'a', createdAt: new Date('2026-11-07T09:00:00Z') }),
            msg({ id: 'b', senderUserId: ME, createdAt: new Date('2026-11-07T09:01:00Z') }),
        ];

        setViewport('mobile');
        const phone = mount(<MessageTimeline messages={input} myUserId={ME} />);
        const phoneText = screen.getAllByText(/body [ab]/).map((el) => el.textContent);
        phone.unmount();
        restoreViewport();

        setViewport('desktop');
        mount(<MessageTimeline messages={input} myUserId={ME} />);
        const deskText = screen.getAllByText(/body [ab]/).map((el) => el.textContent);

        expect(phoneText).toEqual(['body a', 'body b']);
        expect(deskText).toEqual(phoneText);
    });
});

// ───────────────────────── §8 the composer ─────────────────────────

describe('MessageComposer', () => {
    beforeEach(() => setViewport('mobile'));

    function mountComposer(props: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
        const onSend = jest.fn();
        const view = mount(
            <MessageComposer
                onSend={onSend}
                placeholder="Write a message…"
                sendLabel="Send"
                {...props}
            />,
        );
        return { onSend, view };
    }

    it('refuses to send a blank or whitespace-only body', () => {
        const { onSend } = mountComposer();
        const send = screen.getByRole('button', { name: 'Send' });
        expect(send).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Write a message…'), { target: { value: '   ' } });
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        expect(onSend).not.toHaveBeenCalled();
    });

    it('sends the TRIMMED body once, then clears', () => {
        const { onSend } = mountComposer();
        const box = screen.getByLabelText('Write a message…') as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: '  добра реколта  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onSend).toHaveBeenCalledWith('добра реколта');
        expect(box.value).toBe('');
    });

    it('inserts a newline on bare Enter and sends on Ctrl+Enter', () => {
        const { onSend } = mountComposer();
        const box = screen.getByLabelText('Write a message…');

        fireEvent.change(box, { target: { value: 'line one' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        // A phone's return key carries no modifier, so a bare-Enter send would
        // make a two-line message impossible to type on the operator's device.
        expect(onSend).not.toHaveBeenCalled();

        fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
        expect(onSend).toHaveBeenCalledWith('line one');
    });

    it('stays inert while pending, keeping the text rather than clearing it', () => {
        const { onSend } = mountComposer({ pending: true });
        const box = screen.getByLabelText('Write a message…') as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: 'in flight' } });
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

        expect(onSend).not.toHaveBeenCalled();
        expect(box.value).toBe('in flight');
    });

    it('replaces itself with the disabled reason and offers no send control', () => {
        mountComposer({ disabledReason: 'This person is not accepting messages.' });
        expect(screen.getByText('This person is not accepting messages.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Write a message…')).not.toBeInTheDocument();
    });
});

// ─────────────── §9 the keyboard inset, which jsdom cannot reach ───────────────

describe('useKeyboardInset through the composer', () => {
    const listeners: Record<string, Array<() => void>> = {};

    function installVisualViewport(height: number, offsetTop = 0) {
        const vv = {
            height,
            offsetTop,
            addEventListener: (type: string, fn: () => void) => {
                (listeners[type] ??= []).push(fn);
            },
            removeEventListener: () => undefined,
        };
        Object.defineProperty(window, 'visualViewport', {
            value: vv,
            configurable: true,
            writable: true,
        });
        return vv;
    }

    beforeEach(() => {
        setViewport('mobile');
        for (const key of Object.keys(listeners)) delete listeners[key];
    });

    afterEach(() => {
        Object.defineProperty(window, 'visualViewport', {
            value: undefined,
            configurable: true,
            writable: true,
        });
    });

    it('pads the composer by the covered height', () => {
        // jsdom defines no visualViewport at all, so WITHOUT this stub the
        // whole branch is dead code and a test over it would assert nothing.
        installVisualViewport(window.innerHeight - 320);
        const { container } = mount(
            <MessageComposer onSend={jest.fn()} placeholder="p" sendLabel="s" />,
        );
        expect((container.firstChild as HTMLElement).style.paddingBottom).toBe('320px');
    });

    it('counts offsetTop as covered too', () => {
        installVisualViewport(window.innerHeight - 300, 40);
        const { container } = mount(
            <MessageComposer onSend={jest.fn()} placeholder="p" sendLabel="s" />,
        );
        expect((container.firstChild as HTMLElement).style.paddingBottom).toBe('260px');
    });

    it('clamps a negative reading to zero — asserted on the HOOK, not the style', () => {
        // Transiently true during a rotation. This has to read the hook's
        // value: CSS forbids negative padding, so jsdom's CSSOM DROPS the
        // declaration and `style.paddingBottom` is `''` whether or not the
        // clamp exists. Asserting the rendered style here passed the
        // unclamped mutation — it was grading the browser's sanitisation.
        installVisualViewport(window.innerHeight + 120);
        const { result } = renderHook(() => useKeyboardInset());
        expect(result.current).toBe(0);
    });

    it('reports the covered height through the hook as well', () => {
        installVisualViewport(window.innerHeight - 220, 30);
        const { result } = renderHook(() => useKeyboardInset());
        expect(result.current).toBe(190);
    });

    it('applies no padding when the API is absent', () => {
        const { container } = mount(
            <MessageComposer onSend={jest.fn()} placeholder="p" sendLabel="s" />,
        );
        expect((container.firstChild as HTMLElement).style.paddingBottom).toBe('');
    });
});

// ────────── §10 the one property jsdom cannot express ──────────

describe('the windowed branch MEASURES its rows', () => {
    it('passes dynamicRowHeight and never a fixed itemSize', () => {
        // jsdom has no layout engine, so every row is 0px tall and a fixed
        // `itemSize` produces exactly the same DOM as a measured one. The
        // failure is only visible in a real browser, where react-window
        // absolute-positions rows from the height it was given and a wrong
        // number makes bubbles overlap or leaves gaps between them. So this is
        // asserted on the SOURCE — the precedent is the `take: limit + 1`
        // bound in `p8-2-direct-messages`, which was likewise invisible in the
        // response.
        const source = readFileSync(
            path.join(process.cwd(), 'src/components/chat/message-timeline.tsx'),
            'utf8',
        );
        // LINE comments FIRST, then block (#1497). A block-first stripper is
        // capped by `tests/guards/comment-stripper-order.test.ts`, and the
        // reason is that `// a /* b` opens a block comment that was never
        // opened: block-first consumes from there to the next `*/` anywhere
        // later in the file, deleting real code in between. This file's first
        // draft had it the wrong way round and that guard caught it.
        // LINE comments FIRST, then block (#1497, capped by
        // `comment-stripper-order`). Block-first is the hazard: `// a /* b`
        // opens a block that was never meant to open, and the block pass then
        // consumes everything to the next `*/` anywhere later in the file,
        // deleting real code in between. This file's first draft had it the
        // wrong way round and that guard caught it in CI.
        const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

        expect(code).toContain('dynamicRowHeight={{');
        expect(code).not.toMatch(/\bitemSize\s*=/);
    });
});

// ────── §11 the coarse-pointer gesture, which jsdom hides by default ──────

/**
 * `tests/rendered/setup.ts` answers `matches: false` to EVERY query, so
 * `useLongPress` resolves `coarse: false` and the entire gesture is dead code
 * under jsdom — the exact gap through which the #449 tooltip touch regression
 * shipped green. Every test below installs its own `matchMedia` before
 * rendering, and the fine-pointer case installs the opposite stub so the two
 * paths are asserted against each other rather than one being assumed.
 */
const COARSE_FEATURE_RE = /hover:\s*none|pointer:\s*coarse/;

describe('MessageBubble long-press reaction gesture', () => {
    const AT = new Date('2026-11-07T09:00:00Z');
    let originalMatchMedia: typeof window.matchMedia;

    beforeEach(() => {
        originalMatchMedia = window.matchMedia;
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        // Plain assignment: jsdom installs `matchMedia` as
        // `{ writable: true, configurable: false }`, so redefining throws.
        window.matchMedia = originalMatchMedia;
    });

    function installPointerClass(coarse: boolean) {
        window.matchMedia = ((query: string) =>
            ({
                matches: coarse && COARSE_FEATURE_RE.test(query),
                media: query,
                onchange: null,
                addListener: () => {},
                removeListener: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                dispatchEvent: () => false,
            }) as unknown as MediaQueryList) as typeof window.matchMedia;
    }

    function mountBubble(coarse: boolean, over: Record<string, unknown> = {}) {
        installPointerClass(coarse);
        const onRequestReactions = jest.fn();
        mount(
            <MessageBubble
                body="hello"
                createdAt={AT}
                mine={false}
                onRequestReactions={onRequestReactions}
                {...over}
            />,
        );
        return {
            onRequestReactions,
            bubble: screen.getByText(over.deletedAt ? COPY.messageDeleted : 'hello'),
        };
    }

    function hold(el: HTMLElement, ms: number, to = { clientX: 10, clientY: 10 }) {
        fireEvent.pointerDown(el, { clientX: 10, clientY: 10 });
        if (to.clientX !== 10 || to.clientY !== 10) fireEvent.pointerMove(el, to);
        act(() => {
            jest.advanceTimersByTime(ms);
        });
    }

    it('fires after a hold on a coarse pointer', () => {
        const { onRequestReactions, bubble } = mountBubble(true);
        hold(bubble, 600);
        expect(onRequestReactions).toHaveBeenCalledTimes(1);
    });

    it('does not fire on a tap', () => {
        const { onRequestReactions, bubble } = mountBubble(true);
        fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10 });
        act(() => {
            jest.advanceTimersByTime(120);
        });
        fireEvent.pointerUp(bubble);
        act(() => {
            jest.advanceTimersByTime(1000);
        });
        // The release must CANCEL the pending timer, not merely stop adding to
        // it — otherwise every tap fires a reaction half a second later.
        expect(onRequestReactions).not.toHaveBeenCalled();
    });

    it('does not fire when the finger drifts, because that is a scroll', () => {
        const { onRequestReactions, bubble } = mountBubble(true);
        hold(bubble, 600, { clientX: 10, clientY: 90 });
        expect(onRequestReactions).not.toHaveBeenCalled();
    });

    it('never attaches on a FINE pointer', () => {
        const { onRequestReactions, bubble } = mountBubble(false);
        hold(bubble, 600);
        // A mouse user has never expected to hold a button down, and the hold
        // would compete with text selection. Desktop uses the control below.
        expect(onRequestReactions).not.toHaveBeenCalled();
    });

    it('offers a FOCUSABLE control for the same action on both pointer classes', () => {
        for (const coarse of [true, false]) {
            const { onRequestReactions } = mountBubble(coarse);
            // `<SwipeRow>`'s rule: a gesture is invisible to a keyboard and to
            // a screen reader, so a gesture-only action is one some people
            // cannot perform. The button is in the DOM either way.
            const control = screen.getByRole('button', { name: COPY.addReaction });
            control.focus();
            expect(control).toHaveFocus();
            fireEvent.click(control);
            expect(onRequestReactions).toHaveBeenCalledTimes(1);
            screen.getByText('hello').remove();
            document.body.innerHTML = '';
        }
    });

    it('offers neither gesture nor control on a deleted message', () => {
        const { onRequestReactions } = mountBubble(true, { deletedAt: AT });
        expect(screen.queryByRole('button', { name: COPY.addReaction })).not.toBeInTheDocument();
        hold(screen.getByText(COPY.messageDeleted), 600);
        expect(onRequestReactions).not.toHaveBeenCalled();
    });

    it('renders neither when no callback is supplied', () => {
        installPointerClass(true);
        mount(<MessageBubble body="hello" createdAt={AT} mine={false} />);
        expect(screen.queryByRole('button', { name: COPY.addReaction })).not.toBeInTheDocument();
    });
});

// ────── §12 «Сигнализирай» per message, and the rule it must not forget ──────

/**
 * #2833. The gating lives in `MessageBubble` rather than at the call site,
 * because P5.3's rule is about the CONTROL and not about one surface: never on
 * your own message, never on a deleted one. A caller may therefore pass the
 * callback unconditionally — which `DmConversationClient` does — and `mine` is
 * the half a caller would forget.
 */
describe('MessageBubble — the report control (#2833)', () => {
    const AT = new Date('2026-11-07T09:00:00Z');
    const LABEL = 'Report this message';

    it('is offered on SOMEBODY ELSE’S message', () => {
        const onRequestReport = jest.fn();
        mount(
            <MessageBubble
                body="заплаха"
                createdAt={AT}
                mine={false}
                onRequestReport={onRequestReport}
                reportLabel={LABEL}
            />,
        );
        const btn = screen.getByRole('button', { name: LABEL });
        fireEvent.click(btn);
        expect(onRequestReport).toHaveBeenCalledTimes(1);
    });

    it('is NOT offered on your OWN message — `remove` is the control for that', () => {
        mount(
            <MessageBubble
                body="my own words"
                createdAt={AT}
                mine
                onRequestReport={jest.fn()}
                reportLabel={LABEL}
            />,
        );
        expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    });

    it('is NOT offered on a DELETED message — nothing to capture', () => {
        // A deleted message's snapshot would be an empty body indistinguishable
        // from a capture failure, which is the state #2833 exists to remove.
        mount(
            <MessageBubble
                body=""
                createdAt={AT}
                deletedAt={AT}
                mine={false}
                onRequestReport={jest.fn()}
                reportLabel={LABEL}
            />,
        );
        expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    });

    it('renders nothing when no callback is supplied — the control', () => {
        // Without this the three assertions above are satisfied by a control
        // that never renders for anybody.
        mount(<MessageBubble body="hello" createdAt={AT} mine={false} />);
        expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    });

    it('is a real focusable BUTTON, not a gesture — it has no long press', () => {
        // `<SwipeRow>`'s rule: a gesture is an enhancement over a control,
        // never the control. A long press already means reactions, and two
        // gestures on one bubble is a guess about which the operator made — so
        // this control is keyboard-reachable and has no touch-only path.
        mount(
            <MessageBubble
                body="заплаха"
                createdAt={AT}
                mine={false}
                onRequestReport={jest.fn()}
                reportLabel={LABEL}
            />,
        );
        const btn = screen.getByRole('button', { name: LABEL });
        // `opacity-0`, NOT `hidden` — hidden is not tabbable, which is the
        // whole reason the reaction control uses opacity too.
        expect(btn.className).toContain('opacity-0');
        btn.focus();
        expect(btn).toHaveFocus();
    });
});
