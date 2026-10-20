/**
 * `assertPublishableMediaHashes` — the check `/api/public/media/{hash}` rests
 * on. P6.3 (#1812).
 *
 * ## Why this is an INTEGRATION test and not a unit test
 *
 * The claim is that a `FileRecord` belonging to another tenant is not visible,
 * and that is a property of ROW-LEVEL SECURITY — a database behaviour. A
 * mocked `db` whose `findMany` returns whatever the test says proves only that
 * the function filters its own input; it could not distinguish "RLS hid the
 * foreign row" from "RLS is off and the query matched it", which is the one
 * thing worth knowing here.
 *
 * So tenant B's file is created for real, and tenant A asks to publish its
 * hash under A's own context.
 *
 * ## What rests on it
 *
 * `resolvePublicMedia` serves any hash a published projection references, and
 * its safety argument is that the file belongs to whoever published it. The
 * read path cannot establish that — by then the hash is already in a
 * projection. If this check were wrong, farm A could publish farm B's hash and
 * the public route would serve B's file on an indexable page.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Role, MembershipStatus } from '@prisma/client';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { hashForLookup } from '@/lib/security/encryption';
import {
    assertPublishableMediaHashes,
    FARM_MEDIA_DOMAIN,
    thumbnailsForOriginals,
} from '@/app-layer/usecases/farm-brand-media';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `fmp-${randomUUID().slice(0, 8)}`;
const TENANT_A = `t-${TAG}-a`;
const TENANT_B = `t-${TAG}-b`;

/** Distinct 64-hex hashes, one per fixture file. */
const H = {
    aMedia: 'a1'.repeat(32),
    aEvidence: 'a2'.repeat(32),
    aDeleted: 'a3'.repeat(32),
    aPending: 'a4'.repeat(32),
    bMedia: 'b1'.repeat(32),
    nowhere: 'ff'.repeat(32),
};

let userAId = '';

const ctxA = () =>
    makeRequestContext('ADMIN', { userId: userAId, tenantId: TENANT_A, tenantSlug: `${TAG}-a` });

async function mkFile(
    tenantId: string,
    sha256: string,
    opts: { domain?: string; deleted?: boolean; status?: string; derivedFrom?: string } = {},
) {
    return prisma.fileRecord.create({
        data: {
            tenantId,
            pathKey: `tenants/${tenantId}/${opts.domain ?? FARM_MEDIA_DOMAIN}/${sha256.slice(0, 8)}.webp`,
            originalName: 'photo.webp',
            mimeType: 'image/webp',
            sizeBytes: 1234,
            sha256,
            uploadedByUserId: userAId,
            domain: opts.domain ?? FARM_MEDIA_DOMAIN,
            status: (opts.status ?? 'STORED') as never,
            scanStatus: 'CLEAN' as never,
            deletedAt: opts.deleted ? new Date() : null,
            ...(opts.derivedFrom ? { derivedFromSha256: opts.derivedFrom } : {}),
        },
        select: { id: true },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    for (const [id, slug] of [[TENANT_A, `${TAG}-a`], [TENANT_B, `${TAG}-b`]] as const) {
        await prisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name: id, slug },
        });
    }
    const email = `${TAG}-admin@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userAId = u.id;
    await prisma.tenantMembership.create({
        data: {
            tenantId: TENANT_A,
            userId: userAId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });

    await mkFile(TENANT_A, H.aMedia);
    await mkFile(TENANT_A, H.aEvidence, { domain: 'evidence' });
    await mkFile(TENANT_A, H.aDeleted, { deleted: true });
    await mkFile(TENANT_A, H.aPending, { status: 'PENDING' });
    // Tenant B's file, in the media domain — identical in every respect
    // except who owns it. That is what makes it a control rather than a
    // different case.
    await mkFile(TENANT_B, H.bMedia);
}, 60_000);

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.fileRecord.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await prisma.user.deleteMany({ where: { id: userAId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await prisma.$disconnect();
});

const check = (hashes: string[]) =>
    runInTenantContext(ctxA(), (db) => assertPublishableMediaHashes(db, hashes));

describeFn('thumbnailsForOriginals — #2062', () => {
    const THUMB_OF_A = 'c1'.repeat(32);
    const THUMB_OF_B = 'c2'.repeat(32);

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        // A's thumbnail, and B's — identical rows but for the owner, which is
        // what makes the scoping assertion below mean something.
        await mkFile(TENANT_A, THUMB_OF_A, { derivedFrom: H.aMedia });
        await mkFile(TENANT_B, THUMB_OF_B, { derivedFrom: H.bMedia });
    }, 60_000);

    const resolve = (originals: string[]) =>
        runInTenantContext(ctxA(), (db) => thumbnailsForOriginals(db, originals));

    it('pairs an original with its thumbnail — the positive control', async () => {
        const map = await resolve([H.aMedia]);
        expect(map.get(H.aMedia)).toBe(THUMB_OF_A);
    });

    it('CANNOT see another tenant’s thumbnail, even for a known original', async () => {
        // The safety property, and the reason the lookup must run inside the
        // tenant context. A hash is not unique across tenants — two farms may
        // upload the same image — so an unscoped read could pair one farm's
        // projection with another farm's thumbnail. That thumbnail would then
        // be publicly servable under the FIRST farm's handle, because
        // `/api/public/media` serves whatever a published projection
        // references.
        const map = await resolve([H.bMedia]);
        expect(map.has(H.bMedia)).toBe(false);
        expect([...map.values()]).not.toContain(THUMB_OF_B);
    });

    it('omits an original that has no thumbnail, rather than inventing one', async () => {
        // `H.aEvidence` is this tenant's, in another domain, and nothing is
        // derived from it. An absent entry is what makes the projector's
        // fallback reachable.
        const map = await resolve([H.aEvidence, H.aMedia]);
        expect(map.has(H.aEvidence)).toBe(false);
        expect(map.get(H.aMedia)).toBe(THUMB_OF_A);
    });

    it('reads nothing for an empty list', async () => {
        // Guarded before the query: publishing a text-only profile should not
        // cost a round trip.
        expect([...(await resolve([])).keys()]).toEqual([]);
    });
});

describeFn('assertPublishableMediaHashes', () => {
    it('ALLOWS this tenant’s own farm-media file — the positive control', async () => {
        // Without this, every refusal below is also what a broken fixture
        // produces: if no file were created at all, the suite would be green
        // and prove nothing.
        await expect(check([H.aMedia])).resolves.toBeUndefined();
    });

    it('REFUSES another tenant’s file, identical but for the owner', async () => {
        // The one this file exists for. RLS hides tenant B's row from tenant
        // A's context, so the hash comes back unmatched — and that is why the
        // function carries no `tenantId` term of its own.
        await expect(check([H.bMedia])).rejects.toMatchObject({
            code: 'FARM_MEDIA_NOT_PUBLISHABLE',
        });
    });

    it('REFUSES its own file from another DOMAIN', async () => {
        // Ownership is not sufficient. An evidence photo of something private
        // is owned by this tenant and must not be publishable by hash — which
        // is the whole reason `farm-media` is a domain rather than a UI
        // convention.
        await expect(check([H.aEvidence])).rejects.toMatchObject({
            code: 'FARM_MEDIA_NOT_PUBLISHABLE',
        });
    });

    it('REFUSES a soft-deleted file, and one that never finished storing', async () => {
        await expect(check([H.aDeleted])).rejects.toMatchObject({
            code: 'FARM_MEDIA_NOT_PUBLISHABLE',
        });
        await expect(check([H.aPending])).rejects.toMatchObject({
            code: 'FARM_MEDIA_NOT_PUBLISHABLE',
        });
    });

    it('REFUSES a hash that exists nowhere', async () => {
        await expect(check([H.nowhere])).rejects.toMatchObject({
            code: 'FARM_MEDIA_NOT_PUBLISHABLE',
        });
    });

    it('refuses the WHOLE request when one hash of several is bad', async () => {
        // Half-applying would publish the good ones and leave the owner to
        // discover the rest silently missing.
        await expect(check([H.aMedia, H.bMedia])).rejects.toMatchObject({
            code: 'FARM_MEDIA_NOT_PUBLISHABLE',
        });
    });

    it('allows duplicates of a publishable hash, and an empty list', async () => {
        // De-duplicated for the QUERY only; order and repetition are the
        // caller's business.
        await expect(check([H.aMedia, H.aMedia])).resolves.toBeUndefined();
        await expect(check([])).resolves.toBeUndefined();
    });
});
