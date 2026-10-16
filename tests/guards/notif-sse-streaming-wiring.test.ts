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
            const s = read(PATH_ROUTE);
            expect(s).toMatch(/HEARTBEAT_INTERVAL_MS/);
            expect(s).toMatch(/setInterval\(/);
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

        it('imports publishNotificationEvent', () => {
            const s = read(PATH_HELPER);
            expect(s).toMatch(
                /import\s*\{\s*publishNotificationEvent\s*\}\s*from\s*['"]@\/lib\/notifications\/notification-bus['"]/,
            );
        });

        it('calls publish ONLY when result.count > 0 (duplicates skip publish)', () => {
            const s = read(PATH_HELPER);
            // The publish call must be inside an `if (result.count > 0)`
            // branch so dedupe-collapses don't re-fan to subscribers.
            expect(s).toMatch(
                /if \(result\.count > 0\) \{[\s\S]{0,500}publishNotificationEvent\(/,
            );
        });

        it('publishes with the canonical (tenantId, userId, event) signature', () => {
            const s = read(PATH_HELPER);
            expect(s).toMatch(
                /publishNotificationEvent\(\s*task\.tenantId,\s*task\.assigneeUserId,/,
            );
        });
    });

    describe('4. Client (notifications-bell) cutover to EventSource', () => {
        const PATH_BELL = 'src/components/layout/notifications-bell.tsx';

        it('opens an EventSource against /api/notifications/stream', () => {
            const s = read(PATH_BELL);
            expect(s).toMatch(
                /new EventSource\(['"]\/api\/notifications\/stream['"]/,
            );
        });

        it('guards EventSource construction with typeof check (SSR + jsdom safe)', () => {
            const s = read(PATH_BELL);
            expect(s).toMatch(/typeof EventSource !== ['"]undefined['"]/);
        });

        it('carries NO second, build-time gate of its own', () => {
            // REAIMED by #1982. This used to assert the OPPOSITE — that the
            // client reads `env.NEXT_PUBLIC_NOTIFICATIONS_SSE === '1'` — and
            // it passed for months while the channel was dead. The thing it
            // checked was present; the thing that mattered, whether that flag
            // could ever be set, was not expressible as a source match on
            // this file. `NEXT_PUBLIC_*` is inlined at `next build` and the
            // variable reached no Dockerfile `ARG` and no `ghcr-publish.yml`
            // build-arg, so every image baked it `undefined`.
            //
            // The switch now lives in the route (see section 2). Two gates is
            // how a surface comes to be off for a reason nobody can find, so
            // the client must not reintroduce one.
            //
            // Comments stripped first: the docblock explains the retired
            // variable by NAME, so a raw-text search finds it in the prose and
            // reports the opposite of the truth.
            const code = blankNonCode(read(PATH_BELL));
            expect(code).not.toMatch(/NEXT_PUBLIC_NOTIFICATIONS_SSE/);
        });

        it('wires onmessage to REFETCH, and not to read the payload', () => {
            // REAIMED by #1990. This asserted `JSON.parse(msg.data)` — the
            // bell prepending the event into state — and the event carries ids
            // only now, so there is no row in it to prepend.
            //
            // The negative half is the point. Reading the body to decide
            // whether to refetch would reintroduce a dependency on a shape
            // that just changed, and it was also a bug: a prepended payload is
            // a copy, so a notification edited or deleted between publish and
            // render was displayed anyway with no version to compare.
            // Whitespace collapsed, not the window widened. `blankNonCode`
            // replaces each comment character with a space, so the docblock
            // explaining this handler becomes ~700 characters of filler
            // between `onmessage` and the call — and widening the window to
            // clear it would let the match reach an unrelated `fetchList()`
            // elsewhere in the file. Collapsing keeps the window tight around
            // actual code.
            const code = blankNonCode(read(PATH_BELL)).replace(/\s+/g, ' ');
            expect(code).toMatch(/es\.onmessage\s*=/);
            expect(code).toMatch(/es\.onmessage[^;]{0,120}?fetchList\(\)/);
            expect(code).not.toMatch(/JSON\.parse\(msg\.data\)/);
        });

        it('throttles fallback poll to 5min when SSE is healthy', () => {
            const s = read(PATH_BELL);
            // Constant name pin + value (5 * 60_000 = 300_000ms).
            expect(s).toMatch(
                /NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS\s*=\s*5\s*\*\s*60_000/,
            );
        });

        it('cleans up EventSource + interval on unmount', () => {
            const s = read(PATH_BELL);
            expect(s).toMatch(/if \(es\) es\.close\(\)/);
            expect(s).toMatch(/window\.clearInterval\(intervalId\)/);
        });
    });
});
