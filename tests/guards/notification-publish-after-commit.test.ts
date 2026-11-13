/**
 * Every SSE publish happens AFTER the surrounding transaction commits — P7.1 (#1990).
 *
 * ## The defect, which this repo has already paid for once
 *
 * `src/lib/db/after-commit.ts` exists because of it, and its docblock names
 * the publish specifically: `notifyOtherParty` wrote bell rows, published SSE
 * events and enqueued mail from inside the sender's still-open transaction, so
 * "a sender transaction that then rolled back left the other party a
 * notification, an SSE push and an email for a message that does not exist.
 * **The publish is worse than the row: it is unrecallable.**"
 *
 * A bell row written in a doomed transaction disappears with it. A published
 * event is already on the wire.
 *
 * #1990 found a live second instance — `classify-photo.ts` published from
 * inside a `runInTenantContext` — which is the argument for a guard rather
 * than a comment: the mechanism existed, was documented, and a later call site
 * did not use it.
 *
 * ## Why the check is lexical
 *
 * The property is "this call is inside an `afterCommit` callback", which is a
 * question about source structure. Running the publishers would mean standing
 * up a database and a Redis broker to observe an ordering, and the thing under
 * test is the shape.
 *
 * `afterCommit` is safe to use unconditionally — with no transaction frame open
 * it fires immediately — so wrapping every call site costs nothing at the sites
 * that do not need it and makes the property uniform rather than dependent on
 * each caller's context. That uniformity is what makes it checkable here.
 *
 * Comments are blanked first, and it is load-bearing: this file and several
 * publishers discuss `publishNotificationEvent` and `afterCommit` in prose, so
 * a raw-text search would find the explanation and report the opposite of the
 * truth.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT, collectSourceFiles } from '../helpers/collect-files';

/**
 * The publishers this guard ranges over.
 *
 * `publishChannelActivityEvent` joined on #2987 — the channel-activity
 * address, a fourth channel on the same bus. Its one call site queues through
 * `afterCommit`, which it can, because `postToChannel` and `replyToPost` run
 * through `runInUserContext` and that helper OWNS an after-commit scope.
 *
 * ## `publishPersonEvent` is deliberately NOT here
 *
 * Not an omission, and worth saying so because it is the obvious third name.
 * Its two call sites — `direct-messages.ts` and `direct-message-photos.ts` —
 * publish after a bare `prisma.$transaction`, which opens NO after-commit
 * scope: `afterCommit` there fires `void runEffect(...)` un-awaited rather
 * than deferring, which is #1619 verbatim. So the correct shape for them is a
 * directly-awaited call AFTER the transaction closure, and adding the name
 * here would fail two files that are already right.
 *
 * Their ordering is pinned behaviourally instead, by
 * `tests/integration/p8-2-direct-messages.test.ts` — which fails if the
 * publish moves above the early return. Making this guard express "inside
 * `afterCommit` OR outside every transaction span" would cover all three
 * uniformly and is the better guard; it is not done here because it would
 * LOOSEN the rule for `publishNotificationEvent`, whose uniform-wrapping
 * convention is the thing this file argues for above.
 */
const PUBLISHERS = ['publishNotificationEvent(', 'publishChannelActivityEvent('] as const;
const WRAPPER = 'afterCommit(';

/**
 * Character spans of every `afterCommit(...)` call's arguments.
 *
 * Paren-matched rather than regex-bounded: the callback contains its own
 * parens and a non-greedy match would end at the first of them, which would
 * declare a wrapped call unwrapped.
 */
export function wrapperSpans(code: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let from = 0;
    for (;;) {
        const at = code.indexOf(WRAPPER, from);
        if (at === -1) break;
        let depth = 0;
        let i = at + WRAPPER.length - 1; // the '('
        for (; i < code.length; i++) {
            if (code[i] === '(') depth++;
            else if (code[i] === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        spans.push([at, i]);
        from = at + WRAPPER.length;
    }
    return spans;
}

/** Offsets of every publish call that is NOT inside a wrapper span. */
export function unwrappedPublishes(source: string): number[] {
    const code = blankNonCode(source);
    const spans = wrapperSpans(code);
    const out: number[] = [];
    for (const publish of PUBLISHERS) {
        let from = 0;
        for (;;) {
            const at = code.indexOf(publish, from);
            if (at === -1) break;
            if (!spans.some(([s, e]) => at > s && at < e)) out.push(at);
            from = at + publish.length;
        }
    }
    // Sorted, so an offset list reads in source order however many publisher
    // names the loop above walks. The assertions compare against `[]` and so
    // do not depend on it; a diagnostic that jumped backwards would send the
    // next reader to the wrong line.
    return out.sort((a, b) => a - b);
}

const publishers = collectSourceFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
    // The whole src tree, because a publisher can appear anywhere; the floor
    // is the helper's own guard against an exclude predicate eating the
    // population.
    floor: 500,
    exclude: (rel) => rel.endsWith('lib/notifications/notification-bus.ts'),
}).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return PUBLISHERS.some((p) => src.includes(p));
});

describe('every notification publish is after-commit', () => {
    it('found the publishers it is asserting about', () => {
        // Without this the suite passes for free the day the symbol is renamed
        // or the call sites move — the shape of regression it guards, reported
        // as green.
        //
        // 8 → 4, 2026-10-21 (#2142). Seven sites published `{ id:
        // row.dedupeKey }`, which since P7.2 becomes the client's
        // `Last-Event-ID` and resolves to nothing. The fix reads the row back,
        // and doing that seven times would have been seven copies of the same
        // five lines, so the publishes were CONSOLIDATED into
        // `app-layer/notifications/publish-fresh.ts`: 10 publisher files
        // became 4.
        //
        // That is the opposite of the regression this floor guards — call
        // sites vanishing because a symbol was renamed — but the floor cannot
        // tell the two apart, so the number is restated with the reason. Worth
        // being plain: a tripwire at 4 is weaker than one at 8. What narrows
        // the gap is that the property now has ONE home, and
        // `frame-id-is-a-row-id` separately forbids the value that made the
        // consolidation necessary.
        //
        // 4 → 5, 2026-11-13 (#2987): `usecases/channels.ts` joined when
        // `publishChannelActivityEvent` entered `PUBLISHERS`. Raised to my own
        // contribution rather than left at 4 — a floor that admits the state
        // before the change is a floor the change could have skipped.
        expect(publishers.length).toBeGreaterThanOrEqual(5);
    });

    it.each(publishers.map((f) => [path.relative(REPO_ROOT, f), f]))(
        '%s wraps every publish in afterCommit',
        (_rel, file) => {
            const offsets = unwrappedPublishes(fs.readFileSync(file as string, 'utf8'));
            expect(offsets).toEqual([]);
        },
    );

    it('detects a publish OUTSIDE afterCommit', () => {
        // The positive control. Every assertion above is "nothing found",
        // which an extractor returning nothing satisfies for free.
        const bad = `
            await db.thing.create({ data });
            publishNotificationEvent(tenantId, userId, { id });
        `;
        expect(unwrappedPublishes(bad)).toHaveLength(1);
    });

    it('accepts a publish inside afterCommit, parens and all', () => {
        const good = `
            afterCommit('notify.thing', () =>
                publishNotificationEvent(tenantId, userId, { id: row.dedupeKey }),
            );
        `;
        expect(unwrappedPublishes(good)).toEqual([]);
    });

    it('is not fooled by the call appearing in prose', () => {
        const prose = `
            // publishNotificationEvent(tenantId, userId, { id }) must be wrapped.
            /** See publishNotificationEvent( for why. */
            afterCommit('notify.thing', () => publishNotificationEvent(a, b, c));
        `;
        expect(unwrappedPublishes(prose)).toEqual([]);
    });

    it('does not credit a wrapper that CLOSES before the publish', () => {
        // The span check has to be containment, not "a wrapper appears
        // earlier in the file" — otherwise one correctly-wrapped call would
        // vouch for every unwrapped one after it.
        const sequential = `
            afterCommit('a', () => somethingElse());
            publishNotificationEvent(tenantId, userId, { id });
        `;
        expect(unwrappedPublishes(sequential)).toHaveLength(1);
    });
});

describe('the event type carries ids only', () => {
    it('NotificationEvent has exactly one member: id', () => {
        // The wire payload is asserted separately in
        // tests/unit/notifications/notification-bus-redis.test.ts; this is the
        // TYPE, so a content field cannot be reintroduced for a caller to fill.
        const src = fs.readFileSync(
            path.join(REPO_ROOT, 'src/lib/notifications/notification-bus.ts'),
            'utf8',
        );
        const code = blankNonCode(src);
        const open = code.indexOf('export interface NotificationEvent {');
        expect(open).toBeGreaterThan(-1);
        const close = code.indexOf('}', open);
        const body = code.slice(open + 'export interface NotificationEvent {'.length, close);
        const members = body
            .split(';')
            .map((m) => m.trim())
            .filter(Boolean)
            .map((m) => m.split(':')[0].trim());
        expect(members).toEqual(['id']);
    });
});
