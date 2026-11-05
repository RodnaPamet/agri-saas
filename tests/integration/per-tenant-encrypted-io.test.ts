/**
 * Per-tenant encrypted I/O — the rule, and its two job call sites (#2723).
 *
 * This is an INTEGRATION suite for one reason, and it is the reason the class
 * went unnoticed: **a mocked Prisma cannot report an ENCODING.** A double
 * hands back whatever string it was given, so plaintext and a `v2:` envelope
 * are literally the same observation, and every mocked test over the three
 * broken assistant readers stayed green while they returned ciphertext. The
 * same blindness covers a CONSTRAINT (a double accepts any payload) and a
 * dependency CHANGE — one cause, three symptoms: nothing survives the round
 * trip through a stub.
 *
 * So every assertion here reads a real row, and the write half reads the
 * stored BYTES over raw SQL, because the extension would decrypt a Prisma read
 * and hide the very thing being measured.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { withTenantDb } from '@/lib/db-context';
import { prisma as extended } from '@/lib/prisma';
import { readContentPerTenant, readableOrNull } from '@/lib/db/per-tenant-content';
import { runLeaseExpirySweep } from '@/app-layer/jobs/lease-expiry-sweep';
import {
    __resetAuditStreamForTests,
    __setStreamPost,
    __setTenantStreamConfigResolver,
    flushAllAuditStreams,
    streamAuditEvent,
} from '@/app-layer/events/audit-stream';
import { computeHmacSha256 } from '@/app-layer/integrations/webhook-crypto';

/** RAW, so a read of stored bytes is not decrypted on the way out. */
const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `pte-${randomUUID().slice(0, 8)}`;
const FARM_A = `${TAG}-a`;
const FARM_B = `${TAG}-b`;
let ownerA = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await raw.$connect();
    for (const id of [FARM_A, FARM_B]) {
        await raw.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
    }
    const email = `${TAG}@example.test`;
    ownerA = (await raw.user.create({ data: { email, emailHash: `h-${TAG}` }, select: { id: true } })).id;
    await raw.tenantMembership.create({
        data: { tenantId: FARM_A, userId: ownerA, role: 'OWNER', status: 'ACTIVE' },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Only what this suite owns and CAN remove. Users and tenants are pinned
    // by `AuditLog` rows the extension writes — `AuditLog` has an immutability
    // trigger and a RESTRICTing FK, so any suite whose path writes one cannot
    // delete its own users. The neighbouring suites leave them too.
    await raw.notification.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await raw.taskLink.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await raw.task.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await raw.parcelLease.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await raw.parcel.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await raw.location.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await raw.$disconnect();
});

/** A lease with an encrypted `lessorName`, ending `days` from now. */
async function makeLease(tenantId: string, lessorName: string, days: number): Promise<string> {
    const loc = await withTenantDb(tenantId, (db) =>
        db.location.create({ data: { tenantId, name: 'Блок 1' }, select: { id: true } }),
    );
    const parcel = await withTenantDb(tenantId, (db) =>
        db.parcel.create({
            data: { tenantId, locationId: loc.id, name: 'Парцел 1' },
            select: { id: true },
        }),
    );
    const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const lease = await withTenantDb(tenantId, (db) =>
        db.parcelLease.create({
            data: {
                tenantId,
                parcelId: parcel.id,
                lessorName,
                startDate: new Date('2026-01-01'),
                endDate: end,
            },
            select: { id: true },
        }),
    );
    return lease.id;
}

describeFn('the rule: a read with no tenant bound returns the ENVELOPE', () => {
    it('§1 bound vs unbound, same row — the positive control is the bound half', async () => {
        const id = await makeLease(FARM_A, 'Иван Петров', 20);

        const bound = await withTenantDb(FARM_A, (db) =>
            db.parcelLease.findUnique({ where: { id }, select: { lessorName: true } }),
        );
        // The shape every broken site used: the extended GLOBAL client with no
        // tenant in the audit context.
        const unbound = await extended.parcelLease.findUnique({
            where: { id },
            select: { lessorName: true },
        });

        // Without the bound half this test passes for a row that was never
        // readable, and proves nothing about the cause.
        expect(bound?.lessorName).toBe('Иван Петров');
        expect(unbound?.lessorName).toMatch(/^v2:/);
    });

    it('§2 `readContentPerTenant` opens ONE context per farm, never per row', async () => {
        const a1 = await makeLease(FARM_A, 'Първи арендодател', 15);
        const a2 = await makeLease(FARM_A, 'Втори арендодател', 16);
        const b1 = await makeLease(FARM_B, 'Трети арендодател', 17);

        const seen: string[] = [];
        const rows = await readContentPerTenant(
            [
                { id: a1, tenantId: FARM_A },
                { id: a2, tenantId: FARM_A },
                { id: b1, tenantId: FARM_B },
            ],
            (db, ids, tenantId) => {
                seen.push(tenantId);
                return db.parcelLease.findMany({
                    where: { id: { in: ids } },
                    select: { id: true, lessorName: true },
                });
            },
        );

        // Two farms, three rows, two contexts.
        expect(seen.sort()).toEqual([FARM_A, FARM_B]);
        const byId = new Map(rows.map((r) => [r.id, r.lessorName]));
        // Every farm decrypted under its OWN key. A single context would have
        // returned an envelope for whichever farm it did not pick — and the
        // answer would have looked half-working.
        expect(byId.get(a1)).toBe('Първи арендодател');
        expect(byId.get(a2)).toBe('Втори арендодател');
        expect(byId.get(b1)).toBe('Трети арендодател');
    });

    it('§3 `readableOrNull` refuses to pass an envelope on', () => {
        const envelope = 'v2:GnxO1vf/3MkC4orNu07tftzwnlxBD99pB5hqmN1pwds7j4bv';
        expect(readableOrNull(envelope, 'test', 'row-1')).toBeNull();
        expect(readableOrNull('Иван Петров', 'test', 'row-1')).toBe('Иван Петров');
    });
});

describeFn('the WRITE half: no tenant bound falls back to the GLOBAL KEK', () => {
    it('§4 bound writes v2:, unbound writes v1: — read as stored BYTES', async () => {
        const data = (suffix: string) => ({
            tenantId: FARM_A,
            type: 'IMPROVEMENT' as const,
            title: `t-${suffix}`,
            description: `DESC-${suffix}`,
            createdByUserId: ownerA,
        });
        const bound = await withTenantDb(FARM_A, (db) =>
            db.task.create({ data: data('bound'), select: { id: true } }),
        );
        const unbound = await extended.task.create({
            data: data('unbound'),
            select: { id: true },
        });

        const stored = await raw.$queryRawUnsafe<Array<{ id: string; description: string }>>(
            'SELECT id, description FROM "Task" WHERE id IN ($1, $2)',
            bound.id,
            unbound.id,
        );
        const envelopeOf = (id: string): string =>
            stored.find((r) => r.id === id)!.description.slice(0, 3);

        /*
         * This is the whole write-half finding, and it is why the write needs
         * site-by-site discipline rather than a boundary check: BOTH rows read
         * back perfectly, because the extension dispatches per value on the
         * envelope. Nothing downstream can tell them apart. The only
         * difference is which key protects the row — and an unbound write
         * silently drops it onto the master KEK, discarding the per-tenant
         * isolation `GLOBAL_KEK_MODELS` exists to protect.
         */
        expect(envelopeOf(bound.id)).toBe('v2:');
        expect(envelopeOf(unbound.id)).toBe('v1:');

        // Both readable, which is the point: no symptom to notice.
        const readBack = await withTenantDb(FARM_A, (db) =>
            db.task.findMany({
                where: { id: { in: [bound.id, unbound.id] } },
                select: { id: true, description: true },
            }),
        );
        expect(readBack.map((r) => r.description).sort()).toEqual(['DESC-bound', 'DESC-unbound']);
    });
});

describeFn('the lease-expiry sweep names the lessor, not an envelope (#2728)', () => {
    it('§5 the notification a farmer reads carries the plaintext name', async () => {
        await makeLease(FARM_A, 'Георги Димитров', 10);

        // Scoped to this farm, so the shared test DB's other rows cannot
        // decide the assertion.
        const out = await runLeaseExpirySweep({ tenantId: FARM_A, withinDays: 30 });
        expect(out.expiring).toBeGreaterThan(0);

        const notices = await raw.notification.findMany({
            where: { tenantId: FARM_A, type: 'LEASE_EXPIRING' },
            select: { message: true },
        });
        expect(notices.length).toBeGreaterThan(0);
        const texts = notices.map((n) => n.message).join('\n');
        // Before the fix this read `…с v2:fOuhsi1fSx3JjegTsaT97HErmOcN…изтича…`
        // — the lessor's name replaced by a storage envelope, in a sentence an
        // OWNER opens on their phone.
        expect(texts).toContain('Георги Димитров');
        expect(texts).not.toMatch(/v[12]:/);
    });
});

describeFn('the audit-stream signing key is the SECRET, not the envelope (#2738)', () => {
    // An HMAC key this suite invents, writes to a throwaway test tenant and
    // compares a signature against. It authenticates nothing anywhere.
    const SECRET = 'super-secret-hmac-key'; // pragma: allowlist secret -- test-only fixture key

    beforeEach(() => {
        __resetAuditStreamForTests();
        // null restores the DEFAULT resolver, which is the subject — a stubbed
        // resolver would hand back whatever secret the stub was given and the
        // test would grade nothing.
        __setTenantStreamConfigResolver(null);
    });

    afterEach(() => {
        __setStreamPost(null);
        __resetAuditStreamForTests();
    });

    it('§6 the outbound signature verifies against the PLAINTEXT secret', async () => {
        await withTenantDb(FARM_B, (db) =>
            db.tenantSecuritySettings.upsert({
                where: { tenantId: FARM_B },
                update: {
                    auditStreamUrl: 'https://siem.example.test/ingest',
                    auditStreamSecretEncrypted: SECRET,
                },
                create: {
                    tenantId: FARM_B,
                    auditStreamUrl: 'https://siem.example.test/ingest',
                    auditStreamSecretEncrypted: SECRET,
                },
                select: { tenantId: true },
            }),
        );

        let seenBody: string | null = null;
        let seenHeaders: Record<string, string> = {};
        __setStreamPost(async (_url, body, headers) => {
            seenBody = body;
            seenHeaders = headers;
            return { ok: true, status: 200 };
        });

        // The full `StreamedAuditEvent`. A partial one cast through `as never`
        // let `deliverBatch` build an undefined body and throw inside the
        // flush's own catch — which logged and returned, so the test saw "no
        // post" and would have read as the defect it is checking for.
        streamAuditEvent({
            id: 'audit-row-1',
            entryHash: 'h1',
            previousHash: null,
            tenantId: FARM_B,
            userId: ownerA,
            actorType: 'SYSTEM',
            entity: 'Task',
            entityId: 'e1',
            action: 'TEST_EVENT',
            detailsJson: { ok: true },
            metadataJson: {},
            requestId: 'req-1',
            occurredAt: new Date('2026-11-05T10:00:00Z').toISOString(),
        });
        await flushAllAuditStreams();

        expect(seenBody).not.toBeNull();
        /*
         * The whole point. Before the fix the resolver returned the `v2:`
         * envelope and the signer HMAC'd with THAT, so the receiving SIEM
         * would reject every signature while our side saw a clean delivery.
         *
         * Recomputing the expected digest from the plaintext secret is what
         * makes this a test of the KEY rather than of the plumbing: asserting
         * "a signature header exists" passes with any key at all.
         */
        const expected = computeHmacSha256(seenBody as unknown as string, SECRET, 'hex');
        const sent = Object.entries(seenHeaders).find(([k]) =>
            k.toLowerCase().includes('signature'),
        );
        expect(sent).toBeDefined();
        expect(sent?.[1]).toContain(expected);
    });
});
