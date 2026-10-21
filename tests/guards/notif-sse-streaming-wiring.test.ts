/**
 * 2026-05-27 — PR-C: SSE notification streaming wiring ratchet.
 *
 * Locks the five surfaces this feature crosses so a future
 * refactor can't silently strand the streaming path and leave
 * the bell stuck on the 60s fallback poll.
 *
 *   1. The in-process bus module exists at the canonical path
 *      with `subscribeToNotifications` + `publishNotificationEvent`
 *      + `NotificationEvent` shape exported.
 *   2. The SSE route at `/api/notifications/stream` is a Node-
 *      runtime force-dynamic GET that writes `text/event-stream`,
 *      subscribes on connect, unsubscribes on `req.signal abort`,
 *      and emits a heartbeat comment to keep proxies from
 *      closing the channel.
 *   3. `createTaskDueNotification` publishes to the bus AFTER a
 *      successful insert (count > 0). Duplicates do NOT republish
 *      — the bell would otherwise re-prepend the same item on
 *      every fast-follow assign.
 *   4. The notifications-bell client opens an EventSource, has
 *      onmessage / onerror handlers, falls back to polling when
 *      SSE errors, and tears down on unmount.
 *   5. EventSource is opened via `typeof EventSource !== 'undefined'`
 *      so SSR + jsdom unit tests don't break.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf-8');

describe('PR-C SSE notification streaming wiring', () => {
    describe('1. Notification bus module', () => {
        const PATH_BUS = 'src/lib/notifications/notification-bus.ts';
        it('file exists', () => {
            expect(existsSync(path.join(ROOT, PATH_BUS))).toBe(true);
        });

        it('exports subscribe + publish + the event type', () => {
            const s = read(PATH_BUS);
            expect(s).toMatch(/export function subscribeToNotifications/);
            expect(s).toMatch(/export function publishNotificationEvent/);
            expect(s).toMatch(/export interface NotificationEvent/);
        });

        it('routes by a channel keyed on both tenantId AND userId', () => {
            // Anti-leak, same property, different mechanism — REAIMED by
            // #1990. This asserted `sub.tenantId !== tenantId` comparisons,
            // which was the in-process bus iterating every subscriber. The bus
            // is Redis pub/sub now and routing moved into the channel NAME, so
            // the filter those regexes described no longer exists.
            //
            // The tenant is in the channel rather than only the payload
            // precisely so that cross-tenant delivery is not something a
            // filter has to get right. Keeping the id comparison would also
            // have meant every process receiving every notification in the
            // deployment to discard almost all of it.
            //
            // The behavioural half lives in
            // tests/unit/notifications/notification-bus-redis.test.ts, routed
            // through `publishNotificationEvent` with a positive control —
            // which is what catches a channel key that drops the tenant. A
            // source match cannot.
            const s = read(PATH_BUS);
            expect(s).toMatch(/notif:\$\{tenantId\}:\$\{userId\}/);
            expect(s).toMatch(/function channelFor\(tenantId: string, userId: string\)/);
        });

        it('drops a subscriber whose send() throws (poison-pill recovery)', () => {
            // Same invariant; the set it deletes from is now per-channel
            // (`subs`) rather than one flat `subscribers` set (#1990).
            const s = read(PATH_BUS);
            expect(s).toMatch(/try \{\s*sub\.send/);
            expect(s).toMatch(/subs\.delete\(sub\)/);
        });
    });

    describe('2. SSE route', () => {
        const PATH_ROUTE = 'src/app/api/notifications/stream/route.ts';

        it('file exists at the canonical path', () => {
            expect(existsSync(path.join(ROOT, PATH_ROUTE))).toBe(true);
        });

        it('uses Node runtime + force-dynamic (long-lived stream)', () => {
            const s = read(PATH_ROUTE);
            expect(s).toMatch(/export const runtime = ['"]nodejs['"]/);
            expect(s).toMatch(/export const dynamic = ['"]force-dynamic['"]/);
        });

        it('returns Content-Type: text/event-stream with no-cache + X-Accel-Buffering', () => {
            const s = read(PATH_ROUTE);
            expect(s).toMatch(/['"]Content-Type['"]:\s*['"]text\/event-stream/);
            expect(s).toMatch(/['"]Cache-Control['"]:\s*['"]no-cache, no-transform['"]/);
            expect(s).toMatch(/['"]X-Accel-Buffering['"]:\s*['"]no['"]/);
        });

        it('subscribes on connect + unsubscribes on req abort', () => {
            const s = read(PATH_ROUTE);
            expect(s).toMatch(/subscribeToNotifications\(/);
            expect(s).toMatch(/req\.signal\.addEventListener\(['"]abort['"]/);
        });

        it('emits an SSE heartbeat comment on a fixed cadence (proxy-keep-alive)', () => {
            // The route still OWNS the cadence and still passes it, but the
            // scheduling moved into `createSseResponse` with P7.2 (#1991) —
            // so grepping this file for `setInterval(` stopped describing the
            // system. The check follows the code rather than being deleted:
            // the route must name the interval and hand it over, and the
            // helper must be the thing that schedules it.
            //
            // A text grep is now the weaker of two checks on this property.
            // `tests/unit/realtime/sse-lifecycle.test.ts` drives the helper
            // with fake timers and asserts a comment lands on each tick, which
            // is the behaviour this line can only approximate.
            const s = read(PATH_ROUTE);
            expect(s).toMatch(/HEARTBEAT_INTERVAL_MS/);
            expect(s).toMatch(/heartbeatMs:\s*HEARTBEAT_INTERVAL_MS/);
            expect(read('src/lib/realtime/sse.ts')).toMatch(/setInterval\(/);
            // SSE comment line — starts with `:` per the wire format.
            expect(s).toMatch(/: hb\\n\\n/);
        });

        it('gates the stream on a RUNTIME feature flag, resolved for the CALLER', () => {
            // #1982. The channel had no server gate at all: it was
            // authenticated but ungated, so the only "off" was the client
            // declining to connect. A DB-backed flag read per request is the
            // mechanism P7's standing rules require (#1198), and the one that
            // can actually be flipped without shipping an image.
            const s = read(PATH_ROUTE);
            expect(s).toMatch(/isFeatureEnabled\(/);
            expect(s).toMatch(/['"]notifications\.sse['"]/);
            // `ctx.userId`, not `null`: `FeatureFlag.cohorts` composes with
            // `enabled` as AND, so resolving globally would ignore cohort
            // membership and expose the channel to the whole deployment.
            expect(s).toMatch(
                /isFeatureEnabled\(\s*NOTIFICATIONS_SSE_FLAG,\s*ctx\.userId\s*\)/,
            );
        });

        it('refuses a disabled channel with a NON-stream response, before subscribing', () => {
            // 204 so the browser fails the connection permanently instead of
            // treating it as a blip and reconnecting in a loop. And the gate
            // must precede the subscription, or "off" would still register a
            // bus listener per connection.
            const s = read(PATH_ROUTE);
            const gate = s.indexOf('isFeatureEnabled(');
            const subscribe = s.indexOf('subscribeToNotifications({');
            expect(gate).toBeGreaterThan(-1);
            expect(subscribe).toBeGreaterThan(-1);
            expect(gate).toBeLessThan(subscribe);
            expect(s).toMatch(/status:\s*204/);
        });
    });

    describe('3. createTaskDueNotification publishes to the bus on insert', () => {
        const PATH_HELPER = 'src/app-layer/notifications/task-due.ts';

        /**
         * ── re-pointed 2026-10-21 (#2142) ──
         *
         * These three cases asserted that this file imported
         * `publishNotificationEvent` and called it with
         * `(task.tenantId, task.assigneeUserId, …)`. The publish now goes
         * through `publishFreshNotifications`, because the id it was sending
         * was the dedupeKey — and since P7.2 a frame's id is the client's
         * `Last-Event-ID`, which `replayNotificationIdsAfter` resolves as a
         * `Notification.id`, so a dedupeKey meant the next reconnect replayed
         * nothing.
         *
         * The PROPERTY is unchanged and is what these still assert: a fresh
         * insert reaches the bus for the right (tenant, user), and a
         * dedupe-collapse does not. What changed is the symbol that carries
         * it, which is the difference between a guard pinned to a contract and
         * one pinned to a spelling.
         */
        it('routes the publish through the shared read-back helper', () => {
            const s = read(PATH_HELPER);
            expect(s).toMatch(
                /import\s*\{\s*publishFreshNotifications\s*\}\s*from\s*['"]\.\/publish-fresh['"]/,
            );
            // And NOT directly, which is what sent a dedupeKey.
            expect(s).not.toMatch(/publishNotificationEvent\(/);
        });

        it('publishes ONLY when result.count > 0 (duplicates skip publish)', () => {
            const s = read(PATH_HELPER);
            // Inside the `if (result.count > 0)` branch, so a dedupe-collapse
            // does not re-fan to subscribers — the original already did.
            expect(s).toMatch(
                /if \(result\.count > 0\) \{[\s\S]{0,800}publishFreshNotifications\(/,
            );
        });

        it('addresses the frame to the assignee, in the tenant that owns the task', () => {
            const s = read(PATH_HELPER);
            expect(s).toMatch(
                /tenantId: task\.tenantId,\s*userId: task\.assigneeUserId,\s*dedupeKey:/,
            );
        });
    });

    describe('4. Client (notifications-bell) on the SHARED stream — P7.6 (#1995)', () => {
        const PATH_BELL = 'src/components/layout/notifications-bell.tsx';

        /**
         * This block asserted the bell CONSTRUCTED its own `EventSource`
         * against `/api/notifications/stream`, which was right when the bell
         * was the only consumer and is now the defect.
         *
         * Live Борса adding a second connection would mean two per TAB against
         * a cap of three streams per person (P7.2) — so two tabs would exhaust
         * somebody's budget and a third would be refused. The cap is per
         * person because a person is what costs the server, and that only
         * holds if a person's browser opens ONE connection.
         *
         * So the assertions are inverted: the bell must now NOT construct one,
         * and must go through `useRealtime`. Inverted rather than deleted,
         * because "the bell does not open its own socket" is a property worth
         * keeping a test on — a future author reaching for `new EventSource`
         * here is exactly the regression this block now catches.
         */
        it('does NOT construct an EventSource of its own', () => {
            const code = blankNonCode(read(PATH_BELL));

            expect(code).not.toMatch(/new EventSource\(/);
            // Nor the old path, which the shared hook owns now.
            expect(code).not.toMatch(/api\/notifications\/stream/);
        });

        it('subscribes through the shared hook, to the notification kind', () => {
            const code = blankNonCode(read(PATH_BELL));

            expect(code).toMatch(/useRealtime\(\s*['"]notification['"]/);
            expect(code).toMatch(/from ['"]@\/lib\/realtime\/use-realtime['"]/);
        });

        it('carries NO second, build-time gate of its own', () => {
            const code = blankNonCode(read(PATH_BELL));

            // #1982: `NEXT_PUBLIC_*` is inlined at build and reached no
            // Dockerfile ARG, so a client-side gate made the channel
            // unreachable rather than off. The client always ASKS; the server
            // decides, through a FeatureFlag row the route reads per request.
            expect(code).not.toMatch(/NEXT_PUBLIC_NOTIFICATIONS_SSE/);
        });

        it('refetches on a frame, and does NOT read its payload', () => {
            const code = blankNonCode(read(PATH_BELL));

            // The frame carries ids only, so there is nothing in it to
            // prepend — and reading it to decide whether to refetch would
            // reintroduce a dependency on a shape that has now changed twice.
            expect(code).toMatch(/fetchList\(\)/);
            expect(code).not.toMatch(/JSON\.parse/);
        });

        it('derives the poll cadence from the connection state, not from a flag read once', () => {
            const code = blankNonCode(read(PATH_BELL));

            // #1983 made structural. The cadence used to be chosen once from a
            // health flag read in the same tick the `EventSource` was
            // constructed — `onopen` cannot have fired by then, so the
            // five-minute branch was UNREACHABLE and a healthy stream polled
            // every 60s for ever. As a value derived from `realtimeState`, the
            // effect re-runs on every transition and the dead branch cannot
            // return.
            expect(code).toMatch(/realtimeState/);
            expect(code).toMatch(/NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS/);
            // And the state is in the effect's dependency list, which is what
            // makes it re-run.
            expect(code).toMatch(/\[[^\]]*realtimeState[^\]]*\]/);
        });

        it('clears its interval and listener on unmount', () => {
            const code = blankNonCode(read(PATH_BELL));

            // The connection itself is the hook's to close — the bell no
            // longer owns one, which is the point of the change.
            expect(code).toMatch(/clearInterval\(/);
            expect(code).toMatch(/removeEventListener\(/);
        });
    });
});
