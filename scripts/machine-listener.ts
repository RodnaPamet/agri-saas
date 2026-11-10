/**
 * The Codec 8 listener process — #2948 §3.
 *
 * ## This file is deliberately THIN
 *
 * Every decision lives in `src/lib/machines/listener-session.ts`, which is
 * driven by tests with no sockets, no timers and no database. What is left
 * here is socket plumbing and the two effects the session asks for — write
 * these positions, send these bytes — because logic inside an `on('data')`
 * handler is logic nothing can execute. That is this repo's own
 * `ci-failure-issue.sh` lesson: the first version of that notifier put its
 * decisions in workflow YAML and shipped two defects that both fired within
 * two minutes of merging.
 *
 * If you are about to add a branch to this file, add it to the session
 * instead.
 *
 * ## Its own process, and its own CONNECTIONS
 *
 * §3 requires a separate process — a parser bug must not take `app.agrent.bg`
 * down. It also connects DIRECT rather than through pgbouncer, which is a
 * decision recorded on #2948 with the arithmetic: `PG_POOL_MAX` is a budget
 * over a FIXED container count (`floor((25 - 1) / 2) = 12` for `app` and
 * `worker`), so a third pooled consumer makes the worst case `3 x 12 = 36`
 * against 24 available — the #1191 P0.8 deadlock family, where every holder
 * waits and the caller sees `P2028`, which names no pool. `db` sets no
 * `max_connections`, so Postgres defaults to 100 while pgbouncer holds at
 * most 25; these 1-2 direct backends come out of the ~70 spare.
 *
 * ## It writes PRIVILEGED, and the composite FK is what makes that safe
 *
 * The listener is not acting for a user, so there is no session context to
 * run in and `superuser_bypass` applies. The tenant comes from the
 * `MachineTracker` row the IMEI resolved to and from nothing on the wire —
 * and `MachinePosition`'s `[assetId, tenantId] -> Asset[id, tenantId]`
 * composite FK means the database itself refuses a pairing from two different
 * farms, rather than that depending on this file getting its `where` right.
 */
import 'dotenv/config';
import net from 'node:net';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pino from 'pino';

import { ListenerSession, type TrackerIdentity, type DropMetric } from '../src/lib/machines/listener-session';
import { makeTrackerLookup, storePositions } from '../src/lib/machines/ingest';
import { ImeiRateCap } from '../src/lib/machines/imei-rate-cap';
import { assertProductionEncryptionReady } from '../src/lib/security/startup-gate';

// `base` must carry `requestId` or the ops-agent content filter DROPS the
// line — and a dropped line is a missing EVENT, not a missing log (#2091's
// shutdown question was unanswerable for exactly this reason). `pid` and
// `hostname` are restated because pino's `base` REPLACES its defaults rather
// than merging, so setting only `requestId` would silently change the shape
// of every line this process writes. Same block as `scripts/worker.ts`.
const log = pino({
    name: 'machine-listener',
    level: process.env.LOG_LEVEL || 'info',
    base: { pid: process.pid, hostname: os.hostname(), requestId: 'unknown' },
});

const PORT = Number(process.env.MACHINE_LISTENER_PORT ?? 5027);
const HOST = process.env.MACHINE_LISTENER_HOST ?? '0.0.0.0';

/**
 * How long a socket may sit idle before we drop it.
 *
 * A tracker at the documented 30-second cadence is never idle this long, and
 * an idle socket is the only thing a peer holds for free once the buffer
 * ceiling bounds its bytes. 180s rather than 60s because a device in poor GSM
 * coverage legitimately goes quiet between reports.
 */
const IDLE_TIMEOUT_MS = 180_000;

/**
 * ONE connection string, DIRECT. `DIRECT_DATABASE_URL` is the repo's existing
 * name for "not through pgbouncer" — the same one migrations use — so this
 * introduces no new variable and no new place for the two to disagree.
 */
const prisma = new PrismaClient({
    adapter: new PrismaPg({
        connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
        // Two: one for the allowlist lookup, one for a batched insert. The
        // point of connecting direct is NOT to take a large pool.
        max: 2,
    }),
});

/** Counters, flushed to the log on an interval rather than per packet. */
const drops: Record<DropMetric, number> = {
    imei_unknown: 0,
    imei_malformed: 0,
    frame_malformed: 0,
    rate_capped: 0,
    buffer_overflow: 0,
};
let accepted = 0;
let stored = 0;

const lookupTracker = makeTrackerLookup(prisma);
const cap = new ImeiRateCap();

const server = net.createServer((socket) => {
    const session = new ListenerSession({ lookup: lookupTracker, cap });
    socket.setTimeout(IDLE_TIMEOUT_MS);
    // The peer's address is NOT logged per connection: on a public port that
    // is one log line per probe, and the aggregate counters below are what
    // actually answers "is something hammering us".
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());

    socket.on('data', (chunk: Buffer | string) => {
        // `net` hands us a Buffer unless `setEncoding` was called, which it is
        // not — but the TYPE is the union, and asserting past it with `as`
        // would erase the one place a future `setEncoding` would be caught.
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
        // `void` with an internal catch: an `on('data')` handler cannot be
        // awaited, and an unhandled rejection here would take the process down
        // — which is the one outcome §3 exists to prevent.
        void (async () => {
            try {
                const actions = await session.feed(bytes, Date.now());
                for (const a of actions) {
                    if (a.type === 'reply') {
                        socket.write(a.bytes);
                    } else if (a.type === 'count') {
                        drops[a.metric] += 1;
                    } else if (a.type === 'close') {
                        // The reason is logged, never written to the wire: it
                        // would tell an attacker which check refused them.
                        log.info({ reason: a.reason }, 'connection closed');
                        socket.end();
                    } else if (a.type === 'store') {
                        stored += await storePositions(prisma, a.identity, a.positions);
                        accepted += 1;
                    }
                }
            } catch (err) {
                // A write failure must not kill the process, and must not be
                // acked — the device keeps its records and replays them.
                log.error({ err: (err as Error).message }, 'listener failed on a chunk');
                socket.destroy();
            }
        })();
    });
});

/**
 * The reading, on an interval and in LOG FIELDS rather than a `[tag]` console
 * line. The `[tag]` convention is collected by a jest reporter, so a long-lived
 * process using it emits something nothing collects while breaching the
 * no-console rule three guards enforce — the same reasoning P9.3d's auto-hide
 * job records.
 *
 * `dormant` is the field that matters: `stored: 0` is otherwise ambiguous
 * between "no tracker is reporting" and "the listener is not reachable", and
 * on a port nobody has opened yet the second is the likely answer.
 */
const READING_INTERVAL_MS = 300_000;
const reading = setInterval(() => {
    const totalDrops = Object.values(drops).reduce((a, b) => a + b, 0);
    log.info(
        {
            reading: 'machine_listener',
            framesAccepted: accepted,
            positionsStored: stored,
            drops: { ...drops },
            dropsTotal: totalDrops,
            trackedImeis: cap.size,
            dormant: accepted === 0 && totalDrops === 0,
        },
        'machine listener reading',
    );
}, READING_INTERVAL_MS);
reading.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'machine listener shutting down');
    clearInterval(reading);
    // Stop accepting first, then let in-flight writes finish. The other order
    // drops a frame that was already acked, which is the one loss that cannot
    // be replayed.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
    // The same gate `worker.ts` and `scheduler.ts` await. A long-lived process
    // that starts without a usable DATA_ENCRYPTION_KEY is the failure that
    // gate exists for, and the guard holding the list of such processes
    // HARDCODES two names — see #2972, which is why this call is not enough on
    // its own and that guard is being derived from the compose file.
    await assertProductionEncryptionReady(log, process.env);
    server.listen(PORT, HOST, () => {
        log.info({ port: PORT, host: HOST }, 'machine listener accepting Codec 8 connections');
    });
}

main().catch((err) => {
    log.error({ err: (err as Error).message }, 'machine listener failed to start');
    process.exit(1);
});
