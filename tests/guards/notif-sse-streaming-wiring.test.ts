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

        it('filters publishes by both tenantId AND userId', () => {
            // Anti-leak: a cross-tenant or cross-user fan-out would
            // surface another user's notification text to the bell.
            const s = read(PATH_BUS);
            expect(s).toMatch(/sub\.tenantId !== tenantId/);
            expect(s).toMatch(/sub\.userId !== userId/);
        });

        it('drops a subscriber whose send() throws (poison-pill recovery)', () => {
            const s = read(PATH_BUS);
            expect(s).toMatch(/try \{\s*sub\.send/);
            expect(s).toMatch(/subscribers\.delete\(sub\)/);
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

        it('gates SSE client behind NEXT_PUBLIC_NOTIFICATIONS_SSE=1 feature flag', () => {
            // Initial rollout: server-side bus + endpoint are wired
            // but the client cutover is opt-in. Default (flag absent)
            // keeps the 60s poll so E2E specs that wait on
            // `networkidle` aren't blocked by a long-lived stream.
            // Flip the env var when client integration has been
            // manually verified end-to-end.
            //
            // The flag MUST be read via the validated `@/env` module
            // (zod schema in `src/env.ts`), NOT raw `process.env.X` —
            // the `no-fallbacks` ratchet bans raw access.
            const s = read(PATH_BELL);
            expect(s).toMatch(
                /env\.NEXT_PUBLIC_NOTIFICATIONS_SSE === ['"]1['"]/,
            );
            expect(s).toMatch(
                /import\s*\{[\s\S]{0,80}env[\s\S]{0,80}\}\s*from\s+['"]@\/env['"]/,
            );
        });

        it('wires onmessage to prepend the parsed event into state', () => {
            const s = read(PATH_BELL);
            expect(s).toMatch(/es\.onmessage\s*=/);
            expect(s).toMatch(/JSON\.parse\(msg\.data\)/);
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
