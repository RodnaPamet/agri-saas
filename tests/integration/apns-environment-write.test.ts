/**
 * `saveApnsRegistration` corrects a stored environment — #1764 step 3.
 *
 * ## The defect this exists for
 *
 * The re-registration path wrote `userAgent` and nothing else, so it was a
 * no-op for every other column. agrent-ios identified the consequence: a row
 * created before `apnsEnvironment` existed keeps it NULL for ever, the sender
 * refuses the row, and the phone silently receives nothing while appearing
 * registered.
 *
 * The phone re-registers on every signed-in launch, which makes this the one
 * place that can repair such a row — and it only repairs it if the update
 * actually writes.
 *
 * ## Why this is an INTEGRATION test
 *
 * The claim is about what is in the row after two calls. The route-level suite
 * mocks this usecase, so it can only observe that an argument was passed; a
 * mocked `db` would prove that the code calls `update` with a particular
 * object, which is a restatement of the implementation rather than a test of
 * the outcome. The question "does the second registration leave the row
 * correct" is answerable only against a database.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { saveApnsRegistration } from '@/app-layer/usecases/push-subscription';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `apnsenv-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
/** 64 hex characters, the shape the schema pins. */
const TOKEN = 'ab'.repeat(32);

let userId = '';
const ctx = () =>
    makeRequestContext('ADMIN', { userId, tenantId: TENANT_ID, tenantSlug: TAG });

/** The row as stored, read OUTSIDE the tenant context so RLS cannot mask it. */
async function storedRow() {
    return prisma.pushSubscription.findFirst({
        where: { tenantId: TENANT_ID, deviceToken: TOKEN },
        select: { id: true, apnsEnvironment: true, userAgent: true },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const u = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    userId = u.id;
    await prisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
}, 60_000);

afterEach(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.pushSubscription.deleteMany({ where: { tenantId: TENANT_ID } });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Only what this suite creates repeatedly. The tenant, the user and the
    // audit rows are left behind on purpose, and chasing them was a mistake
    // worth recording: three successive attempts hit a foreign key, and the
    // third — `auditLog.deleteMany` itself failing — was the one that said to
    // stop.
    //
    // Registering a device WRITES an audit row, and `AuditLog` is hash-chained
    // (`entryHash` / `previousHash`) with relations that deliberately carry no
    // `onDelete: Cascade`: an audit trail is not supposed to vanish when its
    // tenant does. A test that deletes entries to tidy up is a test fighting
    // an append-only design, and it would be deleting exactly the evidence the
    // chain exists to protect.
    //
    // The leftovers are harmless because every identifier here is TAG-scoped
    // to one run, so nothing collides and nothing accumulates under a name
    // another suite reads.
    await prisma.pushSubscription.deleteMany({ where: { userId } });
    await prisma.$disconnect();
});

describeFn('saveApnsRegistration — the APNs environment', () => {
    it('stores it on a first registration', async () => {
        await saveApnsRegistration(ctx(), { deviceToken: TOKEN, environment: 'development' });
        expect((await storedRow())?.apnsEnvironment).toBe('DEVELOPMENT');
    });

    it('stores NULL when the client does not say — the compatibility case', async () => {
        // The build installed today sends no environment. NULL is the honest
        // record of that, and the sender refuses such a row rather than
        // guessing a host.
        await saveApnsRegistration(ctx(), { deviceToken: TOKEN });
        expect((await storedRow())?.apnsEnvironment).toBeNull();
    });

    it('CORRECTS a NULL on re-registration — the defect', async () => {
        // The case the widened update exists for. Two calls on the same
        // (tenant, user, token): the first from a build that does not send the
        // field, the second from one that does.
        await saveApnsRegistration(ctx(), { deviceToken: TOKEN });
        const before = await storedRow();
        expect(before?.apnsEnvironment).toBeNull();

        await saveApnsRegistration(ctx(), { deviceToken: TOKEN, environment: 'development' });
        const after = await storedRow();

        expect(after?.apnsEnvironment).toBe('DEVELOPMENT');
        // The SAME row, not a second one. The partial unique index enforces
        // this, and a create-only path would have failed against it — so this
        // also pins that re-registration stays idempotent on identity.
        expect(after?.id).toBe(before?.id);
    });

    it('CORRECTS a stale value when a phone moves to TestFlight', async () => {
        // The real transition: a development-signed install is replaced by a
        // TestFlight build, which carries no provisioning profile and reports
        // production. The stored sandbox value would send every notification
        // to the wrong host, where it fails as BadDeviceToken.
        await saveApnsRegistration(ctx(), { deviceToken: TOKEN, environment: 'development' });
        await saveApnsRegistration(ctx(), { deviceToken: TOKEN, environment: 'production' });
        expect((await storedRow())?.apnsEnvironment).toBe('PRODUCTION');
    });

    it('does NOT erase a stored value when a field is omitted', async () => {
        // The other direction, and the reason the update writes only what the
        // caller sent. An older build re-registering must not blank a value a
        // newer build stored — otherwise the two builds would fight on every
        // launch and the row's correctness would depend on launch order.
        await saveApnsRegistration(ctx(), {
            deviceToken: TOKEN,
            environment: 'production',
            userAgent: 'agrent-ios/2.0',
        });
        await saveApnsRegistration(ctx(), { deviceToken: TOKEN });

        const row = await storedRow();
        expect(row?.apnsEnvironment).toBe('PRODUCTION');
        // `userAgent` too. This also fixes a smaller pre-existing version of
        // the same bug: the old code wrote `input.userAgent ?? null`, which
        // erased a stored agent whenever a caller omitted one.
        expect(row?.userAgent).toBe('agrent-ios/2.0');
    });
});
