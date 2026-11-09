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

    it('KEEPS the text when onSend returns false synchronously', () => {
        // The contract is "return `false` to keep the text", and a SYNCHRONOUS
        // `false` is a legal use of it. No live caller does — the DM page
        // returns a promise — so this branch is unreachable from the product
        // and a mutation that cleared unconditionally on the sync path
        // survived 92 cases. A contract with an untested arm is a trap for the
        // next caller, not a feature.
        const onSend = jest.fn(() => false);
        mount(
            <MessageComposer
                onSend={onSend}
                placeholder="write"
                sendLabel="send"
            />,
        );
        const box = screen.getByRole('textbox');
        fireEvent.change(box, { target: { value: 'задръж това' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));
        expect(onSend).toHaveBeenCalledWith('задръж това');
        expect(box).toHaveValue('задръж това');
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
        //
        // `classList` since #2829, and the change is not cosmetic: measured by
        // mutation, `className.toContain('opacity-0')` is satisfied by
        // `IconAction`'s own `before:opacity-0` / `disabled:opacity-0` base
        // classes, so this assertion passed with `className="hidden"` passed
        // in. It graded nothing. Whole-token comparison plus the explicit
        // absence of `hidden` is what makes it fail.
        expect(btn.classList.contains('opacity-0')).toBe(true);
        expect(btn.classList.contains('hidden')).toBe(false);
        btn.focus();
        expect(btn).toHaveFocus();
    });
});

// ────── §13 the reply half — the quote, the control, and the swipe ──────

/**
 * #2829's component stage. Three things landed together and the grouping is
 * the point rather than convenience:
 *
 *   · the QUOTE, because a reply with no visible context is a message only
 *     the sender can read;
 *   · the CONTROL, because a swipe is invisible to a keyboard and to a screen
 *     reader — `<SwipeRow>`'s rule, which every gesture in this product
 *     inherits;
 *   · the SWIPE, which is the part jsdom hides: `tests/rendered/setup.ts`
 *     answers `matches: false` to every query, so the coarse branch is dead
 *     code unless a test installs its own `matchMedia`. That is the gap the
 *     #449 tooltip regression shipped through.
 *
 * The case that is easiest to get wrong is the last one in this block: both
 * gestures live on the SAME element, and `{...a} {...b}` keeps only the second
 * set — silently, with no warning and no type error.
 */
describe('MessageBubble reply — quote, control and gesture', () => {
    const AT = new Date('2026-11-07T09:00:00Z');
    const REPLY_LABEL = 'Отговори';
    let originalMatchMedia: typeof window.matchMedia;

    beforeEach(() => {
        originalMatchMedia = window.matchMedia;
        setViewport('mobile');
    });

    afterEach(() => {
        window.matchMedia = originalMatchMedia;
        restoreViewport();
    });

    /** Same shape as §11's: a stub that answers only the coarse features. */
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
        const onRequestReply = jest.fn();
        const onRequestReactions = jest.fn();
        mount(
            <MessageBubble
                body="hello"
                createdAt={AT}
                mine={false}
                onRequestReply={onRequestReply}
                replyLabel={REPLY_LABEL}
                onRequestReactions={onRequestReactions}
                reactionsLabel="React"
                {...over}
            />,
        );
        return { onRequestReply, onRequestReactions };
    }

    /** Drag from (x0,y0) by (dx,dy) and release. */
    function swipe(el: HTMLElement, dx: number, dy = 0) {
        fireEvent.pointerDown(el, { clientX: 100, clientY: 100 });
        fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 100 + dy });
        fireEvent.pointerUp(el);
    }

    describe('the quoted preview', () => {
        it('renders the quoted body above the message', () => {
            mount(
                <MessageBubble
                    body="480 €/t"
                    createdAt={AT}
                    mine={false}
                    replyTo={{ senderLabel: 'Иван', body: 'Колко искате?', deleted: false }}
                />,
            );
            expect(screen.getByText(/Колко искате\?/)).toBeInTheDocument();
            expect(screen.getByText('Иван:')).toBeInTheDocument();
            expect(screen.getByText('480 €/t')).toBeInTheDocument();
        });

        it('renders the DELETED copy for a retracted target, not its old body', () => {
            // `deleted` is read rather than `!body`, and this is the case that
            // separates them: the API withholds the body AND sets the flag, so
            // a component reading only the body cannot tell this from a
            // photo-only message.
            mount(
                <MessageBubble
                    body="отговор"
                    createdAt={AT}
                    mine={false}
                    replyTo={{ senderLabel: 'Иван', body: null, deleted: true }}
                />,
            );
            expect(screen.getByText(COPY.messageDeleted)).toBeInTheDocument();
        });

        it('does NOT render the deleted copy for a photo-only target', () => {
            // The control for the case above. A photo-only message has a null
            // body too (P8.6 made the column nullable), so a component that
            // inferred "deleted" from the body would call a photograph a
            // retraction — and the assertion above would pass either way.
            mount(
                <MessageBubble
                    body="хубава снимка"
                    createdAt={AT}
                    mine={false}
                    replyTo={{ senderLabel: 'Иван', body: null, deleted: false }}
                />,
            );
            expect(screen.queryByText(COPY.messageDeleted)).not.toBeInTheDocument();
            expect(screen.getByText('хубава снимка')).toBeInTheDocument();
        });

        it('renders no quote at all when the message is not a reply', () => {
            // Without this the three above are satisfied by a component that
            // always renders a quote block, empty or not.
            mount(<MessageBubble body="hello" createdAt={AT} mine={false} />);
            expect(screen.getByText('hello')).toBeInTheDocument();
            expect(screen.queryByText('Иван:')).not.toBeInTheDocument();
        });
    });

    describe('the focusable control — the keyboard path', () => {
        it('is a real button, reachable by Tab, on a FINE pointer where no gesture exists', () => {
            // The whole reason the control exists. On a desktop the swipe is
            // not attached at all, so this button is the only way to reply.
            const { onRequestReply } = mountBubble(false);
            const btn = screen.getByRole('button', { name: REPLY_LABEL });
            // `classList`, NOT `className.toContain`. MEASURED: `IconAction`'s
            // own base classes include `before:opacity-0` and
            // `disabled:opacity-0`, so a SUBSTRING match is satisfied whatever
            // this call site passes — swapping the prop for `hidden` left the
            // assertion green. `classList` compares whole tokens, so
            // `before:opacity-0` is a different class and cannot stand in.
            //
            // The ABSENCE of `hidden` is the half that carries the property:
            // jsdom applies no CSS, so `hidden` here would still be focusable
            // in the test and not in a browser — the className is the only
            // observable, and it has to be read exactly.
            expect(btn.classList.contains('opacity-0')).toBe(true);
            expect(btn.classList.contains('hidden')).toBe(false);
            btn.focus();
            expect(btn).toHaveFocus();
            fireEvent.click(btn);
            expect(onRequestReply).toHaveBeenCalledTimes(1);
        });

        it('is ALSO in the DOM on a coarse pointer, beside the gesture', () => {
            // A gesture is an enhancement over a control, never a replacement:
            // a screen-reader user on a phone has the gesture and cannot use
            // it, so removing the button on touch would be the defect.
            mountBubble(true);
            expect(screen.getByRole('button', { name: REPLY_LABEL })).toBeInTheDocument();
        });

        it('is offered on your OWN message, unlike «Сигнализирай»', () => {
            // The deliberate asymmetry with the report control. Replying to
            // something you said is ordinary, and there is no competing
            // control to confuse it with.
            mountBubble(false, { mine: true });
            expect(screen.getByRole('button', { name: REPLY_LABEL })).toBeInTheDocument();
        });

        it('is NOT offered on a DELETED message', () => {
            // The API accepts a deleted TARGET so a reply survives a
            // retraction — not so one can be started against a message with
            // nothing left in it, which would quote «изтрито» before anybody
            // read what was being answered.
            mountBubble(false, { body: '', deletedAt: AT });
            expect(screen.queryByRole('button', { name: REPLY_LABEL })).not.toBeInTheDocument();
        });

        it('renders nothing when no callback is supplied — the control', () => {
            mount(<MessageBubble body="hello" createdAt={AT} mine={false} />);
            expect(screen.queryByRole('button', { name: REPLY_LABEL })).not.toBeInTheDocument();
        });
    });

    describe('the swipe gesture', () => {
        it('fires on release past the threshold, on a coarse pointer', () => {
            const { onRequestReply } = mountBubble(true);
            swipe(screen.getByText('hello'), -70);
            expect(onRequestReply).toHaveBeenCalledTimes(1);
        });

        it('works in EITHER direction', () => {
            // Direction-agnostic by design: a right-to-left swipe is the
            // convention on one platform and the opposite on another, and the
            // action is the same either way.
            const { onRequestReply } = mountBubble(true);
            swipe(screen.getByText('hello'), 70);
            expect(onRequestReply).toHaveBeenCalledTimes(1);
        });

        it('does NOT fire below the threshold — the gesture is abortable', () => {
            // It fires on RELEASE rather than at the threshold, so a thumb
            // that crosses a line it cannot see and comes back has not acted.
            const { onRequestReply } = mountBubble(true);
            swipe(screen.getByText('hello'), -20);
            expect(onRequestReply).not.toHaveBeenCalled();
        });

        it('does NOT fire when the drag is dragged BACK under the threshold', () => {
            // Past the threshold and back again. `completed` has to be
            // recomputed on every move, not latched on first crossing.
            const { onRequestReply } = mountBubble(true);
            const el = screen.getByText('hello');
            fireEvent.pointerDown(el, { clientX: 100, clientY: 100 });
            fireEvent.pointerMove(el, { clientX: 20, clientY: 100 });
            fireEvent.pointerMove(el, { clientX: 95, clientY: 100 });
            fireEvent.pointerUp(el);
            expect(onRequestReply).not.toHaveBeenCalled();
        });

        it('does NOT fire on a VERTICAL drag, because that is a scroll', () => {
            // The false-alarm direction, and the one a user cannot undo
            // without noticing: flicking a timeline to scroll must never file
            // a reply. The horizontal travel here is past the threshold, so a
            // threshold-only rule would fire.
            const { onRequestReply } = mountBubble(true);
            swipe(screen.getByText('hello'), -70, -200);
            expect(onRequestReply).not.toHaveBeenCalled();
        });

        it('does NOT fire on a FINE pointer, however far the drag goes', () => {
            // The branch jsdom hides by default. Asserted against the coarse
            // case above rather than assumed — a mouse user has never expected
            // to drag a message sideways, and they have the button.
            const { onRequestReply } = mountBubble(false);
            swipe(screen.getByText('hello'), -200);
            expect(onRequestReply).not.toHaveBeenCalled();
        });

        it('does NOT fire on a deleted message even on a coarse pointer', () => {
            const { onRequestReply } = mountBubble(true, { body: '', deletedAt: AT });
            swipe(screen.getByText(COPY.messageDeleted), -70);
            expect(onRequestReply).not.toHaveBeenCalled();
        });
    });

    describe('TWO gestures on ONE element', () => {
        it('a swipe fires the reply and a hold fires the reactions, from the same node', () => {
            // THE CASE THIS BLOCK EXISTS FOR. Both hooks return the same four
            // pointer handlers, and `{...press} {...swipe}` keeps only the
            // second set — a plain object spread, no composition, no warning,
            // no type error. One gesture then stops working and the only
            // symptom is a feature that silently does nothing on a phone.
            //
            // Asserted as a PAIR in one test rather than two, because each
            // alone passes under the broken spread: whichever set survived is
            // the one that works.
            jest.useFakeTimers();
            try {
                const { onRequestReply, onRequestReactions } = mountBubble(true);
                const el = screen.getByText('hello');

                swipe(el, -70);
                expect(onRequestReply).toHaveBeenCalledTimes(1);

                fireEvent.pointerDown(el, { clientX: 100, clientY: 100 });
                act(() => {
                    jest.advanceTimersByTime(600);
                });
                expect(onRequestReactions).toHaveBeenCalledTimes(1);
            } finally {
                jest.useRealTimers();
            }
        });

        it('a horizontal drag CANCELS the hold, so one gesture cannot fire both', () => {
            // They do not need to know about each other: a drag passes
            // `useLongPress`'s 10px move tolerance and cancels it. Without
            // this, a slow swipe would file a reply AND open the reaction
            // picker, and the operator chose one.
            jest.useFakeTimers();
            try {
                const { onRequestReply, onRequestReactions } = mountBubble(true);
                const el = screen.getByText('hello');
                fireEvent.pointerDown(el, { clientX: 100, clientY: 100 });
                fireEvent.pointerMove(el, { clientX: 30, clientY: 100 });
                act(() => {
                    jest.advanceTimersByTime(600);
                });
                fireEvent.pointerUp(el);
                expect(onRequestReply).toHaveBeenCalledTimes(1);
                expect(onRequestReactions).not.toHaveBeenCalled();
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
