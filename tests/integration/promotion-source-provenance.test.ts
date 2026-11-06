/**
 * `Promotion.sourceFileId` answers *where did this text come from?* (#2750).
 *
 * DB-backed, because every property here is about a real row's relationship to
 * a real `FileRecord` — and the two interesting states are an id that RESOLVES
 * and an id that DOES NOT. A mocked Prisma hands back whatever it was given, so
 * "this id no longer resolves" is not a thing a double can express; it is the
 * same class as #2723's envelopes and #2724's ciphertext export.
 *
 * ## The assertion that carries the design
 *
 * The column has NO foreign-key constraint, so a retention-swept leaflet leaves
 * a dangling id rather than a NULL. That buys nothing unless the two states are
 * observably different, so the three 404s are pinned individually:
 *
 *   PROMOTION_NOT_FOUND           no such promotion
 *   PROMOTION_SOURCE_NOT_RECORDED NULL — never read from a leaflet
 *   PROMOTION_SOURCE_NOT_HELD     id present, file gone — it WAS read
 *
 * Collapsing the last two answers "was this taken from a document?" with "no"
 * in the one case where the honest answer is "yes, and we can no longer show
 * you which" — which is the provenance question a reviewer is asking.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { downloadPromotionSource, listAllPromotions, createPromotion } from '@/app-layer/usecases/promotion-admin';
import { companyNameKey } from '@/app-layer/usecases/promotions';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { getStorageProvider } from '@/lib/storage';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `psrc-${randomUUID().slice(0, 8)}`;

let platformTenantId = '';
let platformUserId = '';
let companyId = '';

const writtenKeys: string[] = [];

const platformCtx = () =>
    makeRequestContext('ADMIN', {
        userId: platformUserId,
        tenantId: platformTenantId,
        tenantSlug: `${TAG}-platform`,
    });

/** A STORED, CLEAN file under the platform tenant — the happy case. */
async function makeFile(
    suffix: string,
    opts: { scanStatus?: string; status?: string; tenantId?: string } = {},
) {
    const tenantId = opts.tenantId ?? platformTenantId;
    // Real bytes, written THROUGH THE PROVIDER. The local provider opens the
    // file when the stream is created, so a row alone gives ENOENT — and a test
    // that accepted that would assert the gate while never reaching the thing
    // the gate guards.
    //
    // `provider.write` and not a filesystem path, because the root is
    // configuration: `FILE_STORAGE_ROOT || UPLOAD_DIR || '/tmp/uploads'`. An
    // earlier version hardcoded `join(process.cwd(), 'uploads', key)`, which
    // passed locally (`.env` has `UPLOAD_DIR="./uploads"`) and failed in CI,
    // where it is `/tmp/ci-uploads` — a test restating a path the code derives,
    // green by coincidence on one machine. Writing through the provider means
    // the write and the read resolve the root the same way, so they cannot
    // disagree again.
    const key = `tenants/${tenantId}/promotions/${TAG}-${suffix}.pdf`;
    await getStorageProvider().write(key, Buffer.from('%PDF-1.4 fixture\n'));
    writtenKeys.push(key);

    const row = await prisma.fileRecord.create({
        data: {
            tenantId,
            // `assertTenantKey` requires this exact prefix. A key that did not
            // carry the tenant would make the isolation check vacuous rather
            // than failing, which is why the fixture spells it properly.
            pathKey: key,
            originalName: `leaflet-${suffix}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 1234,
            sha256: `sha-${TAG}-${suffix}`,
            // Required with no default, and an FK to User. The fixture was
            // incomplete without it and every file-creating case failed with
            // one PrismaClientValidationError — which is the useful shape:
            // the two cases that passed were exactly the two that create no
            // file, so the pass/fail split named the cause.
            uploadedByUserId: platformUserId,
            status: (opts.status ?? 'STORED') as never,
            scanStatus: (opts.scanStatus ?? 'CLEAN') as never,
        },
    });
    return row.id;
}

async function makePromotion(suffix: string, sourceFileId: string | null) {
    return (
        await prisma.promotion.create({
            data: { companyId, title: `Promo ${TAG}-${suffix}`, category: 'products', sourceFileId },
        })
    ).id;
}

describeFn('#2750 — a promotion remembers the leaflet it was read from', () => {
    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        const email = `${TAG}-support@ag.test`;
        platformUserId = (
            await prisma.user.create({
                data: { email, emailHash: hashForLookup(email), name: 'Support' },
            })
        ).id;
        platformTenantId = (
            await prisma.tenant.create({ data: { name: `Platform ${TAG}`, slug: `${TAG}-platform` } })
        ).id;
        await prisma.tenantMembership.create({
            data: { tenantId: platformTenantId, userId: platformUserId, role: 'ADMIN', status: 'ACTIVE' },
        });
        const cName = `Co ${TAG}`;
        companyId = (await prisma.company.create({ data: { name: cName, nameKey: companyNameKey(cName) } })).id;
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        await prisma.$executeRawUnsafe(`DELETE FROM "Promotion" WHERE "companyId" = $1`, companyId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Company" WHERE id = $1`, companyId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "FileRecord" WHERE "sha256" LIKE $1`, `sha-${TAG}-%`).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, platformTenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, platformTenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, platformUserId).catch(() => {});
        for (const k of writtenKeys) await getStorageProvider().delete(k).catch(() => {});
    });

    describe('the three 404s are distinct, which is why the column has no FK', () => {
        it('a promotion that never existed is PROMOTION_NOT_FOUND', async () => {
            await expect(downloadPromotionSource(platformCtx(), `missing-${TAG}`)).rejects.toMatchObject({
                code: 'PROMOTION_NOT_FOUND',
            });
        });

        it('a NULL sourceFileId is PROMOTION_SOURCE_NOT_RECORDED — never read from a leaflet', async () => {
            const id = await makePromotion('typed', null);
            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toMatchObject({
                code: 'PROMOTION_SOURCE_NOT_RECORDED',
            });
        });

        it('a DANGLING sourceFileId is PROMOTION_SOURCE_NOT_HELD — it WAS read, the file is gone', async () => {
            // Exactly what a retention sweep leaves behind: the promotion
            // survives, the FileRecord does not, and the id stays. Created and
            // then deleted rather than invented, so the id has the shape a real
            // swept row would.
            const fileId = await makeFile('swept');
            const id = await makePromotion('swept', fileId);
            await prisma.$executeRawUnsafe(`DELETE FROM "FileRecord" WHERE id = $1`, fileId);

            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toMatchObject({
                code: 'PROMOTION_SOURCE_NOT_HELD',
            });
            // The promotion is NOT collateral damage — no cascade.
            expect(await prisma.promotion.findUnique({ where: { id } })).not.toBeNull();
            // And the id is still there, which is the whole point: NULL would
            // have said "never read from a leaflet".
            const after = await prisma.promotion.findUnique({ where: { id }, select: { sourceFileId: true } });
            expect(after?.sourceFileId).toBe(fileId);
        });
    });

    describe('the AV egress gate, which is why bytes may be written before a scan resolves', () => {
        it('INFECTED is its own refusal, ahead of the gate', async () => {
            const fileId = await makeFile('infected', { scanStatus: 'INFECTED' });
            const id = await makePromotion('infected', fileId);
            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toMatchObject({
                code: 'FILE_SCAN_REJECTED',
            });
        });

        it('PENDING is a DIFFERENT refusal — wait and retry, not "never coming"', async () => {
            const fileId = await makeFile('pending', { scanStatus: 'PENDING' });
            const id = await makePromotion('pending', fileId);
            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toMatchObject({
                code: 'FILE_SCAN_PENDING',
            });
        });

        it('a file whose upload never completed is NOT_HELD, not served', async () => {
            // `status` is the upload lifecycle, separate from `scanStatus`. A
            // PENDING row means the bytes were never confirmed stored, so there
            // is nothing to show even though the scan column may read CLEAN.
            //
            // Added because dropping the STORED check SURVIVED the mutation
            // run: every other case had status STORED, so the branch was
            // present and unexercised.
            const fileId = await makeFile('unstored', { status: 'PENDING', scanStatus: 'CLEAN' });
            const id = await makePromotion('unstored', fileId);
            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toMatchObject({
                code: 'PROMOTION_SOURCE_NOT_HELD',
            });
        });

        it('a CLEAN, STORED file is served, and reports the stored name and type', async () => {
            const fileId = await makeFile('clean');
            const id = await makePromotion('clean', fileId);
            const result = await downloadPromotionSource(platformCtx(), id);
            expect(result.contentType).toBe('application/pdf');
            expect(result.name).toBe('leaflet-clean.pdf');
            expect(result.sizeBytes).toBe(1234);
            // Drain it. `contentType` and `name` come off the row and would be
            // right even if the stream were broken, so the bytes are the only
            // assertion that the gate let something real through.
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                result.stream.on('data', (c: Buffer) => chunks.push(c));
                result.stream.on('end', () => resolve());
                result.stream.on('error', reject);
            });
            expect(Buffer.concat(chunks).toString()).toContain('%PDF-1.4');
        });
    });

    describe('isolation', () => {
        it('a file belonging to ANOTHER tenant does not resolve', async () => {
            // `getByIdForTenant` scopes by tenant, so this never reaches
            // `assertTenantKey` — and that is the point of having both: the id
            // in the column is an unvalidated pass-through, so the first line of
            // defence is the scoped read and the second is the key check on
            // whatever did resolve.
            const otherTenantId = (
                await prisma.tenant.create({ data: { name: `Other ${TAG}`, slug: `${TAG}-other` } })
            ).id;
            const fileId = await makeFile('foreign', { tenantId: otherTenantId });
            const id = await makePromotion('foreign', fileId);

            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toMatchObject({
                code: 'PROMOTION_SOURCE_NOT_HELD',
            });

            await prisma.$executeRawUnsafe(`DELETE FROM "FileRecord" WHERE id = $1`, fileId).catch(() => {});
            await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, otherTenantId).catch(() => {});
        });

        it('a row owned by this tenant whose KEY names another is refused', async () => {
            // The only state in which `assertTenantKey` is reachable, and the
            // reason it is in the seam contract: `getByIdForTenant` scopes by
            // `tenantId`, so a foreign ROW never gets here — what gets here is a
            // row whose tenantId is correct and whose pathKey is not. That is
            // data corruption, or a writer that built the key wrong, and the
            // check is the second line of defence on whatever actually resolved.
            //
            // Found by a mutation that SURVIVED: deleting `assertTenantKey`
            // reddened nothing, because no case in this file could reach it.
            // A check no test can distinguish is indistinguishable from an
            // absent one.
            const row = await prisma.fileRecord.create({
                data: {
                    tenantId: platformTenantId,
                    pathKey: `tenants/not-${platformTenantId}/promotions/${TAG}-mismatch.pdf`,
                    originalName: 'mismatch.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 7,
                    sha256: `sha-${TAG}-mismatch`,
                    status: 'STORED' as never,
                    scanStatus: 'CLEAN' as never,
                    uploadedByUserId: platformUserId,
                },
            });
            const id = await makePromotion('mismatch', row.id);
            await expect(downloadPromotionSource(platformCtx(), id)).rejects.toThrow(
                /tenant isolation/i,
            );
        });
    });

    describe('the admin DTO carries it', () => {
        it('listPromotions exposes sourceFileId', async () => {
            const fileId = await makeFile('dto');
            const id = await makePromotion('dto', fileId);
            const rows = await listAllPromotions(platformCtx());
            const row = rows.find((r) => r.id === id);
            expect(row).toBeDefined();
            expect(row?.sourceFileId).toBe(fileId);
        });
    });
});
