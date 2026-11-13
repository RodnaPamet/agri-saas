/**
 * #2948 stage 6 — the listener PROCESS honours what the session decides.
 *
 * Stage 6 asks for three properties: "an IMEI that is not allowlisted writes
 * nothing, a forged tenant is impossible, the sweep's denominator is printed".
 * Measured before building, two of the three were already covered and the
 * third was done:
 *
 *   · `tests/unit/machines/listener-session.test.ts` §2 — seven cases proving
 *     an unknown IMEI produces no `store` ACTION, with §1 as the control.
 *   · `tests/integration/machine-tracking-schema.test.ts` §1/§2 — RLS refuses
 *     a forged tenant on `MachinePosition`, and the composite FK refuses a
 *     position pointing at another farm's asset.
 *   · #3012's sweep logs `mode`, `expired`, `deleted`, `remaining` and
 *     `daysWithoutMarker` on every run.
 *
 * **What none of them covers is the process.** `scripts/machine-listener.ts`
 * is the seam: it builds the lookup, makes one session per socket, and turns
 * actions into side effects — write the reply, count the drop, end the socket,
 * call `storePositions`. It calls `main()` at module load, so it cannot be
 * imported; it is outside `tsconfig.json`; and no test had ever executed it.
 * That is the shape CLAUDE.md names for `scripts/worker.ts` and
 * `scripts/scheduler.ts`, where a renamed BullMQ verb would have passed CI and
 * surfaced as a worker that will not start.
 *
 * So this suite SPAWNS the real thing and speaks Codec 8 to it over TCP
 * against the real database. A dispatch that dropped the `store` action, acked
 * before storing, ignored `close`, or reused one identity across sockets is
 * invisible to every suite above and visible here.
 *
 * ## The one property that is genuinely new
 *
 * `stored`, `accepted` and `drops` are MODULE-scope in that script while the
 * session is per-socket. Nothing proved the identity is not module-scope too,
 * and the unit suite cannot: it drives one session at a time. §3 therefore
 * runs two connections from two different farms CONCURRENTLY and requires each
 * farm's rows to carry its own tenant, asset and tracker. That is also the
 * honest reading of "a forged tenant is impossible" at this layer — the wire
 * carries no tenant field at all, so the only thing a peer controls is which
 * IMEI it presents, and the property worth asserting is that an IMEI resolves
 * to its OWN farm and writes nowhere else.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { hashForLookup } from '@/lib/security/encryption';

import { imeiPacket, frame, record, T0 } from '../helpers/codec8-frames';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const FARM_A = `t-mlp-a-${TAG}`;
const FARM_B = `t-mlp-b-${TAG}`;
const INSTALLER = `u-mlp-${TAG}`;
/*
 * Run-scoped IMEIs. `MachineTracker.imei` is UNIQUE across the deployment —
 * `machine-tracking-schema` §3 asserts two farms cannot share one — so a fixed
 * literal would collide with a leftover from a previous run of this file and
 * fail at the fixture rather than at an assertion.
 */
const IMEI_A = `3569380${TAG.slice(0, 8).replace(/\D/g, '') || '1234'}`.padEnd(15, '7').slice(0, 15);
const IMEI_B = `3579380${TAG.slice(0, 8).replace(/\D/g, '') || '1234'}`.padEnd(15, '8').slice(0, 15);
const IMEI_UNKNOWN = '860000000000009';

/** The port the spawned listener binds. Read from its own startup log. */
let port = 0;
let child: ChildProcessWithoutNullStreams | null = null;
let assetA = '';
let assetB = '';
let trackerA = '';
let trackerB = '';

/** Collected stdout, so a failure can say what the process actually logged. */
let log = '';

function startListener(): Promise<number> {
    return new Promise((resolve, reject) => {
        /*
         * Port 0 would let the OS choose, and the script has no way to report
         * it back other than this log line — which it prints with the port it
         * was GIVEN, so 0 would be logged as 0. A high random port is the
         * available option; EADDRINUSE surfaces as a startup failure rather
         * than as a hang, because the rejection below fires on exit too.
         */
        const chosen = 23_000 + Math.floor(Math.random() * 9_000);
        child = spawn(
            'npx',
            ['tsx', 'scripts/machine-listener.ts'],
            {
                env: {
                    ...process.env,
                    MACHINE_LISTENER_PORT: String(chosen),
                    MACHINE_LISTENER_HOST: '127.0.0.1',
                    // The slotted per-worker database, so what the process
                    // writes is what this suite reads back.
                    DATABASE_URL: DB_URL,
                    DIRECT_DATABASE_URL: DB_URL,
                    DATA_ENCRYPTION_KEY:
                        process.env.DATA_ENCRYPTION_KEY ?? 'test-key-at-least-32-characters-long',
                    LOG_LEVEL: 'info',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        ) as ChildProcessWithoutNullStreams;

        const onText = (b: Buffer) => {
            log += b.toString();
            if (log.includes('accepting Codec 8 connections')) resolve(chosen);
        };
        child.stdout.on('data', onText);
        child.stderr.on('data', onText);
        child.on('exit', (code) =>
            reject(new Error(`listener exited with ${code} before accepting; log:\n${log}`)),
        );
    });
}

/**
 * Open a connection, run `talk`, and resolve once `expectBytes` have arrived
 * (or the peer closes, or the deadline passes).
 *
 * BYTE-COUNT DRIVEN, not timer driven, and that is not tidying: the first
 * version hung up after a fixed 900 ms and failed twice on a loaded machine
 * with a buffer that was simply incomplete — a flake in a suite whose whole
 * job is to make a refusal observable. TCP is a stream, so the reply and the
 * ack may arrive as one chunk or two, and nothing about the protocol
 * guarantees either; the only deterministic wait is for a LENGTH.
 *
 * The deadline exists so a genuine hang fails as a hang instead of as jest's
 * suite timeout, which says nothing about where it stopped.
 */
function session(
    talk: (socket: net.Socket) => Promise<void>,
    expectBytes: number,
    deadlineMs = 8_000,
): Promise<{ received: Buffer; closedByPeer: boolean }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let closedByPeer = false;
        let settled = false;
        const socket = net.createConnection({ port, host: '127.0.0.1' });
        const total = () => chunks.reduce((n, c) => n + c.length, 0);

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            socket.end();
        };
        const deadline = setTimeout(finish, deadlineMs);

        socket.on('data', (d) => {
            chunks.push(d);
            if (total() >= expectBytes) finish();
        });
        socket.on('end', () => {
            closedByPeer = true;
            finish();
        });
        socket.on('error', (err) => {
            clearTimeout(deadline);
            reject(err);
        });
        socket.on('close', () => resolve({ received: Buffer.concat(chunks), closedByPeer }));
        socket.on('connect', () => {
            void talk(socket).catch(reject);
        });
    });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describeFn('#2948 stage 6 — the listener process', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.createMany({
            data: [
                { id: FARM_A, name: 'ЗК Процес А', slug: FARM_A },
                { id: FARM_B, name: 'ЗК Процес Б', slug: FARM_B },
            ],
        });
        const email = `${INSTALLER}@example.test`;
        await prisma.user.create({
            data: { id: INSTALLER, email, emailHash: hashForLookup(email) },
        });
        for (const t of [FARM_A, FARM_B]) {
            await prisma.tenantMembership.create({
                data: { tenantId: t, userId: INSTALLER, role: 'OWNER', status: 'ACTIVE' },
            });
        }
        const a = await prisma.asset.create({
            data: { tenantId: FARM_A, name: 'Трактор А', type: 'TRACTOR' },
            select: { id: true },
        });
        assetA = a.id;
        const b = await prisma.asset.create({
            data: { tenantId: FARM_B, name: 'Трактор Б', type: 'TRACTOR' },
            select: { id: true },
        });
        assetB = b.id;
        /*
         * `driversInformedAt` and `driversInformedByUserId` are REQUIRED —
         * #2948 §6, and `machine-tracking-schema` §4 refuses a tracker without
         * them. The fixture has to satisfy that or nothing below runs.
         */
        const ta = await prisma.machineTracker.create({
            data: {
                tenantId: FARM_A,
                assetId: assetA,
                imei: IMEI_A,
                driversInformedAt: new Date(),
                driversInformedByUserId: INSTALLER,
            },
            select: { id: true },
        });
        trackerA = ta.id;
        const tb = await prisma.machineTracker.create({
            data: {
                tenantId: FARM_B,
                assetId: assetB,
                imei: IMEI_B,
                driversInformedAt: new Date(),
                driversInformedByUserId: INSTALLER,
            },
            select: { id: true },
        });
        trackerB = tb.id;

        port = await startListener();
    }, 120_000);

    afterAll(async () => {
        child?.kill('SIGTERM');
        await wait(300);
        child?.kill('SIGKILL');
        await prisma.machinePosition.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
        await prisma.machineTracker.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
        await prisma.asset.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
        /*
         * Memberships, the user and the tenants STAY. Deleting the membership
         * trips `P0001 LAST_OWNER_GUARD` — the trigger that exists so a tenant
         * cannot be left ownerless, which a test tidying up has no business
         * defeating. Every identifier here is TAG-scoped to one run.
         */
        await prisma.$disconnect();
    }, 60_000);

    const positionsOf = (tenantId: string) =>
        prisma.machinePosition.findMany({
            where: { tenantId },
            select: { tenantId: true, assetId: true, trackerId: true, source: true, recordedAt: true },
        });

    it('§0 the control — the process started and is accepting, so the refusals below mean something', () => {
        expect(port).toBeGreaterThan(0);
        expect(log).toContain('accepting Codec 8 connections');
    });

    it('§1 an allowlisted IMEI is accepted and its frame is STORED under its own farm', async () => {
        // ACCEPT (1 byte) + the 4-byte ack.
        const out = await session(async (socket) => {
            socket.write(imeiPacket(IMEI_A));
            socket.write(frame([record(T0)]));
        }, 5);

        /*
         * FIVE bytes exactly, and the count is the assertion that found the
         * defect this stage fixed. Before `feed` was serialised this was
         * intermittently SIX — `01 01 00 00 00 01`, two ACCEPTs — because the
         * handshake and the frame arrive as two `data` events and each is
         * dispatched in its own async IIFE, so both ran the handshake. A
         * device given those bytes reads `01 00 00 00` as its ack: 16,777,216
         * records accepted, and a buffer discarded that was never delivered.
         */
        expect(out.received.length).toBe(5);
        expect(out.received[0]).toBe(1);
        // Big-endian, which is what the device reads. A little-endian ack of
        // one record reads as 16,777,216 accepted.
        expect(out.received.readUInt32BE(1)).toBe(1);

        const rows = await positionsOf(FARM_A);
        expect(rows).toHaveLength(1);
        expect(rows[0].assetId).toBe(assetA);
        expect(rows[0].trackerId).toBe(trackerA);
        // `source` has no database default precisely so a writer that forgets
        // fails instead of mislabelling provenance.
        expect(rows[0].source).toBe('TRACKER');
        expect(rows[0].recordedAt.getTime()).toBe(T0);
    }, 60_000);

    it('§2 an IMEI nobody registered is refused and writes NOTHING', async () => {
        const before = (await positionsOf(FARM_A)).length + (await positionsOf(FARM_B)).length;

        const out = await session(async (socket) => {
            socket.write(imeiPacket(IMEI_UNKNOWN));
            // The frame is sent anyway, which is the point: a peer refused at
            // the handshake does not politely stop talking.
            socket.write(frame([record(T0 + 1_000)]));
        }, 1);

        expect(out.received[0]).toBe(0);
        // Refused, and NO ack for the frame it sent after being refused — so
        // the byte count is the assertion, not just the first byte.
        expect(out.received.length).toBe(1);
        // The process ends the connection itself rather than leaving a refused
        // peer holding a socket.
        expect(out.closedByPeer).toBe(true);

        const after = (await positionsOf(FARM_A)).length + (await positionsOf(FARM_B)).length;
        expect(after).toBe(before);
        // And the IMEI is never written to the log, which would put a device
        // identifier in an operator's console on every probe.
        expect(log).not.toContain(IMEI_UNKNOWN);
    }, 60_000);

    it('§4 the ack means the row is ALREADY written — never a receipt for a pending write', async () => {
        await prisma.machinePosition.deleteMany({ where: { tenantId: FARM_A } });

        /*
         * The session pushes `store` BEFORE the `reply` carrying the ack, and
         * the process awaits `storePositions` inside the action loop. So the
         * four ack bytes are a promise that the records are committed, and the
         * device is entitled to discard its buffer on receiving them.
         *
         * Asserted with NO wait after the ack, which is what makes it mean
         * something: under the correct order the row is already there, so this
         * is deterministic. Reorder the two actions, or write the ack without
         * awaiting the store, and this reads an empty table — a device that
         * dropped its buffer on an ack for a write that then failed is field
         * data destroyed, which is the loss the rate cap's own comment says it
         * refuses to cause.
         */
        const out = await session(async (socket) => {
            socket.write(imeiPacket(IMEI_A));
            socket.write(frame([record(T0 + 5_000), record(T0 + 6_000)]));
        }, 5);

        expect(out.received.readUInt32BE(1)).toBe(2);
        const rows = await positionsOf(FARM_A);
        expect(rows).toHaveLength(2);
    }, 60_000);

    it('§3 two farms connected AT ONCE do not cross-contaminate', async () => {
        await prisma.machinePosition.deleteMany({
            where: { tenantId: { in: [FARM_A, FARM_B] } },
        });

        /*
         * Concurrent on purpose. `stored`, `accepted` and `drops` are
         * module-scope in the script while the session is per-socket; nothing
         * proved the IDENTITY is not module-scope too, and the unit suite
         * cannot, because it drives one session at a time. A dispatch that
         * held the last-resolved identity would write both frames under one
         * farm and still ack both devices.
         */
        const [a, b] = await Promise.all([
            session(async (socket) => {
                socket.write(imeiPacket(IMEI_A));
                socket.write(frame([record(T0 + 2_000)]));
            }, 5),
            session(async (socket) => {
                socket.write(imeiPacket(IMEI_B));
                socket.write(frame([record(T0 + 3_000), record(T0 + 4_000)]));
            }, 5),
        ]);

        expect(a.received[0]).toBe(1);
        expect(b.received[0]).toBe(1);
        // Each device is acked for ITS OWN record count — one and two.
        expect(a.received.readUInt32BE(1)).toBe(1);
        expect(b.received.readUInt32BE(1)).toBe(2);

        const rowsA = await positionsOf(FARM_A);
        const rowsB = await positionsOf(FARM_B);

        // Each farm got its OWN frame, under its own asset and tracker.
        expect(rowsA).toHaveLength(1);
        expect(rowsA[0].assetId).toBe(assetA);
        expect(rowsA[0].trackerId).toBe(trackerA);
        expect(rowsB).toHaveLength(2);
        expect(rowsB.every((r) => r.assetId === assetB)).toBe(true);
        expect(rowsB.every((r) => r.trackerId === trackerB)).toBe(true);
        // Stated as a negative too: neither farm holds the other's tracker.
        expect(rowsA.some((r) => r.trackerId === trackerB)).toBe(false);
        expect(rowsB.some((r) => r.trackerId === trackerA)).toBe(false);
    }, 90_000);
});
