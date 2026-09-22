/**
 * What the persisted endpoints actually PUT ON A PHONE.
 *
 * `tests/guards/swr-persist-allowlist.test.ts` caps `PERSISTABLE_PATHS` at
 * four and states the rule in full — "if the response carries names,
 * contacts, identifiers, financial terms, or anything in ENCRYPTED_FIELDS, it
 * does not belong here". Nothing checked the responses against it. The guard
 * governs the LIST; this governs the PAYLOAD.
 *
 * Measured 2026-09-22: two of the four persisted paths were shipping a
 * colleague's email address to plaintext `localStorage` —
 * `/locations` via `owner` and `/farm-tasks` via `assignee`. `User.email` is
 * stored as a hash plus an encrypted column precisely BECAUSE it is personal
 * data, and it still reached disk in clear on a device that can be lost, sold
 * or handed to another worker. Encryption at rest protects the row, not the
 * copy a client keeps.
 *
 * This is an EXECUTING test against a real database, because the question is
 * what a query RETURNS. A structural scan of the select would pass the moment
 * someone re-added the field through a spread or a different include.
 *
 * The web's allowlist is not the whole exposure. The native client's response
 * cache stores RAW RESPONSE BYTES, so a field reaches that device's disk even
 * when nothing decodes it — "my model ignores it" is not "it did not arrive".
 * So the question this file asks is the broader one: what does a payload
 * carry that nothing renders?
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { LocationRepository } from '@/app-layer/repositories/LocationRepository';
import { WorkItemRepository } from '@/app-layer/repositories/WorkItemRepository';
import { runInTenantContext } from '@/lib/db-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `ppii-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const EMAIL = `${TAG}-owner@example.test`;
let ownerId = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    const u = await prisma.user.create({
        data: { email: EMAIL, emailHash: hashForLookup(EMAIL), name: 'Иван Собственик' },
    });
    ownerId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    await prisma.location.create({
        data: { tenantId: TENANT_ID, name: `Склад ${TAG}`, ownerUserId: ownerId },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "Location" WHERE "tenantId" = $1`, TENANT_ID);
        });
    } catch {
        /* globalSetup handles reset */
    }
    await prisma.$disconnect();
});

const ctx = () => makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });

describeFn('what reaches a device (DB)', () => {
    it('/locations embeds an owner NAME and no email', async () => {
        const rows = await runInTenantContext(ctx(), (db) => LocationRepository.list(db, ctx()));
        expect(rows.length).toBeGreaterThan(0);

        const withOwner = rows.find((r) => (r as { owner?: unknown }).owner);
        expect(withOwner).toBeDefined();
        const owner = (withOwner as { owner: Record<string, unknown> }).owner;

        // The name is the point — it is what every surface renders, and it
        // proves the relation was actually projected rather than the test
        // passing on an absent object.
        expect(owner.name).toBe('Иван Собственик');
        expect(Object.keys(owner)).not.toContain('email');

        // Belt and braces: the address must not reach the payload by any
        // other route either (a spread, a second include, a serialiser).
        expect(JSON.stringify(rows)).not.toContain(EMAIL);
    });

    it('a task detail embeds watcher NAMES and no emails', async () => {
        // Nothing renders a watcher on either client — the web has no watcher
        // surface at all, the native app shows `_count` only — yet every task
        // detail shipped `{ id, name, email }` per watcher. It is empty across
        // the tenant today, which is exactly why nobody saw it: the first farm
        // to add a watcher would have been the first to leak one.
        const c = ctx();
        const task = await prisma.task.create({
            data: { tenantId: TENANT_ID, title: `Watcher probe ${TAG}`, createdByUserId: ownerId },
            select: { id: true },
        });
        await prisma.taskWatcher.create({
            data: { tenantId: TENANT_ID, taskId: task.id, userId: ownerId },
        });

        const detail = await runInTenantContext(c, (db) => WorkItemRepository.getById(db, c, task.id));
        const watchers = (detail as { watchers?: { user?: Record<string, unknown> }[] } | null)?.watchers;

        // Positive control: the watcher and its user were actually projected,
        // so `not.toContain('email')` is not passing on an empty array.
        expect(watchers?.length).toBe(1);
        expect(watchers![0].user?.name).toBe('Иван Собственик');
        expect(Object.keys(watchers![0].user!)).not.toContain('email');
        expect(JSON.stringify(watchers)).not.toContain(EMAIL);
    });
});
