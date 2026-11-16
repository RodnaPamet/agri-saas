/**
 * #3063 — a channel card's «Отвори», rendered.
 *
 * ## Why this surface and not «За Вас»
 *
 * A NEWS card's payload has always carried a `url`. «За Вас» rendered
 * `channels.card.open` for it; the channel FEED could not, because
 * `TimelineMessage.body` is a plain string and there was nowhere to put a
 * link. So the url was contract-only on that one surface: documented, returned,
 * consumed by agrent-ios, and not clickable — a farmer could read a headline in
 * the feed with no way to open it.
 *
 * ## The assertion that matters most is the NEGATIVE one
 *
 * Widening a shared Epic 68 primitive is only safe if the surfaces that pass
 * nothing render exactly as before, and `MessageTimeline` is shared with P8.3's
 * DM thread. So §1 compares the rendered HTML of a message with no action
 * against the same message before the field existed — byte for byte, not
 * "looks the same".
 *
 * ## The jsdom default is a PHONE
 *
 * `tests/rendered/setup.ts` answers `matches: false` to every media query, so
 * every block sets its viewport explicitly rather than inheriting a default
 * nobody chose — `chat-primitives`' rule, and the reason three suites were once
 * green about a branch they never ran.
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { TooltipProvider } from '@/components/ui/tooltip';
import { MessageBubble } from '@/components/chat/message-bubble';
import { MessageTimeline, type TimelineMessage } from '@/components/chat/message-timeline';

import { restoreViewport, setViewport } from './viewport';

const messages = JSON.parse(
    readFileSync(path.join(process.cwd(), 'messages/en/app.json'), 'utf8'),
) as Record<string, unknown>;

const ME = 'u-me';
const THEM = 'u-them';

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

const ACTION = { label: 'Open', href: 'https://example.test/article' };

afterEach(restoreViewport);

describe('§1 a message with NO action renders exactly as before', () => {
    it('is byte-identical whether the field is absent or null', () => {
        // The load-bearing negative. A shared primitive gaining a field must
        // not shift a single byte for the surfaces that pass nothing — and the
        // DM thread passes nothing. `undefined` and `null` are both compared
        // because the adapter can produce either.
        setViewport('mobile');
        const absent = mount(
            <MessageTimeline messages={[msg({ id: 'a' })]} myUserId={ME} height={600} />,
        ).container.innerHTML;
        const explicitNull = mount(
            <MessageTimeline
                messages={[msg({ id: 'a', action: null })]}
                myUserId={ME}
                height={600}
            />,
        ).container.innerHTML;
        expect(explicitNull).toBe(absent);
        // And the control: the comparison is capable of SEEING a difference,
        // so an equal result means something. Without this, a render that
        // produced the empty string for both would pass.
        const withAction = mount(
            <MessageTimeline
                messages={[msg({ id: 'a', action: ACTION })]}
                myUserId={ME}
                height={600}
            />,
        ).container.innerHTML;
        expect(withAction).not.toBe(absent);
        expect(absent.length).toBeGreaterThan(100);
    });
});

describe('§2 the link itself', () => {
    it('is a real anchor, with the href and the label', () => {
        setViewport('mobile');
        mount(<MessageTimeline messages={[msg({ id: 'b', action: ACTION })]} myUserId={ME} height={600} />);
        const a = screen.getByRole('link', { name: 'Open' });
        expect(a).toBeTruthy();
        expect(a.getAttribute('href')).toBe('https://example.test/article');
    });

    it('opens in a new tab WITHOUT leaking the referrer', () => {
        // `noreferrer` as well as `noopener`: the target is a third-party news
        // site and the referrer would otherwise carry the tenant-scoped
        // channel URL the reader was on.
        setViewport('mobile');
        mount(<MessageTimeline messages={[msg({ id: 'c', action: ACTION })]} myUserId={ME} height={600} />);
        const rel = screen.getByRole('link', { name: 'Open' }).getAttribute('rel') ?? '';
        expect(rel).toContain('noopener');
        expect(rel).toContain('noreferrer');
        expect(screen.getByRole('link', { name: 'Open' }).getAttribute('target')).toBe('_blank');
    });

    it('is KEYBOARD reachable, because a gesture is never the only way', () => {
        // `<SwipeRow>`'s rule, which P8.3 restated: a gesture is an
        // enhancement over a control. An anchor is focusable by construction,
        // and this pins that it did not become a `<div onClick>`.
        setViewport('desktop');
        mount(<MessageTimeline messages={[msg({ id: 'd', action: ACTION })]} myUserId={ME} height={600} />);
        const a = screen.getByRole('link', { name: 'Open' });
        expect(a.tagName).toBe('A');
        expect(a.getAttribute('href')).toBeTruthy();
    });

    it('renders at BOTH viewports — the primitive is width-fluid', () => {
        for (const vp of ['mobile', 'desktop'] as const) {
            setViewport(vp);
            const { unmount } = mount(
                <MessageTimeline messages={[msg({ id: `e-${vp}`, action: ACTION })]} myUserId={ME} height={600} />,
            );
            expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
            unmount();
        }
    });
});

describe('§3 when it must NOT appear', () => {
    it('not on a DELETED card', () => {
        // Same reason P5.3 does not offer «Сигнализирай» on a deleted message:
        // there is nothing left to open, and a link to the source of content
        // that has been taken down is the one place it would still be
        // reachable.
        setViewport('mobile');
        mount(
            <MessageTimeline
                messages={[msg({ id: 'f', action: ACTION, deleted: true })]}
                myUserId={ME}
                height={600}
            />,
        );
        expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
    });

    it('not when the bubble is deleted by TIMESTAMP either', () => {
        // The DM shape. `MessageBubble` accepts either, and a test that only
        // covered the boolean would miss half of it.
        setViewport('mobile');
        mount(
            <MessageBubble
                body="gone"
                createdAt={new Date('2026-11-07T09:00:00Z')}
                deletedAt={new Date('2026-11-07T10:00:00Z')}
                mine={false}
                action={ACTION}
            />,
        );
        expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
    });
});
