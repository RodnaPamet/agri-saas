/**
 * W5 (final task) — `KnowledgeArticle` / `KnowledgeArticleVersion` RLS
 * behavioural tests.
 *
 * The static guardrail (`tests/guardrails/rls-coverage.test.ts`) confirms
 * the policies + FORCE flag + asymmetric USING/WITH-CHECK shape exist on
 * both tables. These tests exercise the actual semantics against a live
 * Postgres so a future migration that quietly weakens the rules breaks
 * here even if the static surface still looks correct. Mirrors
 * `tests/integration/knowledge-chunk-rls.test.ts` (the precedent this
 * migration follows) plus the two extra cases the brief calls out
 * explicitly (own-tenant read + a direct GLOBAL-row INSERT attempt).
 *
 * Coverage
 * --------
 *   1. Own-tenant article/version: readable by its owning tenant.
 *   2. A GLOBAL (tenantId NULL) article/version is readable by ANY tenant.
 *   3. A tenant CANNOT read another tenant's private article/version.
 *   4. `app_user` cannot INSERT a GLOBAL (tenantId NULL) row directly —
 *      WITH CHECK (own) rejects it.
 *   5. `app_user` cannot re-tenant a GLOBAL row to a foreign tenant via
 *      UPDATE (asymmetric USING + strict WITH CHECK).
 *   6. `KnowledgeAcknowledgement`'s composite FK makes it structurally
 *      impossible to acknowledge a GLOBAL article's version — the DB-layer
 *      backstop behind `acknowledgeArticle`'s usecase-level rejection.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUFFIX = randomUUID();
let TENANT_A = '';
let TENANT_B = '';
let AUTHOR_ID = '';

// Tag every fixture article's slug so cleanup is precise.
const TAG = `kb-rls-${SUFFIX}`;

async function makeTenant(name: string): Promise<string> {
    const t = await globalPrisma.tenant.create({
        data: { name, slug: `${name}-${SUFFIX}` },
        select: { id: true },
    });
    return t.id;
}

/** Default Prisma client = postgres role = superuser_bypass fires, so
 *  NULL-tenant GLOBAL rows can be minted (the ingestion-script path). */
async function createArticle(
    tenantId: string | null,
    ref: string,
): Promise<{ articleId: string; versionId: string }> {
    const slug = `${TAG}-${ref}`;
    const article = await globalPrisma.knowledgeArticle.create({
        data: {
            tenantId,
            slug,
            title: `RLS fixture ${ref}`,
            status: 'PUBLISHED',
            ownerUserId: tenantId ? AUTHOR_ID : null,
        },
        select: { id: true },
    });
    const version = await globalPrisma.knowledgeArticleVersion.create({
        data: {
            tenantId,
            articleId: article.id,
            versionNumber: 1,
            contentType: 'HTML',
            contentText: `<p>fixture ${ref}</p>`,
            createdById: AUTHOR_ID,
        },
        select: { id: true },
    });
    await globalPrisma.knowledgeArticle.update({
        where: { id: article.id },
        data: { currentVersionId: version.id },
    });
    return { articleId: article.id, versionId: version.id };
}

async function cleanup() {
    // Cascades to the matching KnowledgeArticleVersion rows
    // (KnowledgeArticleVersion.articleId is onDelete: Cascade). Tenants +
    // the author User are left in place — same reasoning as
    // knowledge-chunk-rls.test.ts: tenant creation leaves an immutable
    // AuditLog row that blocks tenant deletion, and the CI test DB is
    // ephemeral with unique slugs per run, so leaving them is harmless.
    await globalPrisma.knowledgeArticle.deleteMany({ where: { slug: { startsWith: TAG } } });
}

describeFn('W5 — KnowledgeArticle / KnowledgeArticleVersion RLS', () => {
    beforeAll(async () => {
        TENANT_A = await makeTenant('kbrls-a');
        TENANT_B = await makeTenant('kbrls-b');
        const author = await globalPrisma.user.create({
            data: { email: `kbrls-author-${SUFFIX}@example.com`, name: 'RLS fixture author' },
            select: { id: true },
        });
        AUTHOR_ID = author.id;
    });

    afterAll(async () => {
        await cleanup();
        await globalPrisma.$disconnect();
    });

    // ── 1 + 3. Own-tenant read OK, cross-tenant read rejected ──────────

    it('a tenant-private article is readable only by its owning tenant', async () => {
        const { articleId } = await createArticle(TENANT_A, `own-${randomUUID()}`);

        const ownView = await withTenantDb(TENANT_A, (tx) =>
            tx.knowledgeArticle.findUnique({ where: { id: articleId }, select: { id: true } }),
        );
        expect(ownView?.id).toBe(articleId);
    });

    it("a tenant cannot read another tenant's article", async () => {
        const { articleId } = await createArticle(TENANT_A, `foreign-${randomUUID()}`);

        const fromB = await withTenantDb(TENANT_B, (tx) =>
            tx.knowledgeArticle.findUnique({ where: { id: articleId }, select: { id: true } }),
        );
        expect(fromB).toBeNull();
    });

    it("a tenant cannot read another tenant's article version", async () => {
        const { versionId } = await createArticle(TENANT_A, `foreign-version-${randomUUID()}`);

        const fromB = await withTenantDb(TENANT_B, (tx) =>
            tx.knowledgeArticleVersion.findUnique({ where: { id: versionId }, select: { id: true } }),
        );
        expect(fromB).toBeNull();
    });

    // ── 2. GLOBAL read OK for every tenant ──────────────────────────────

    it('a GLOBAL (NULL-tenant) article is readable by any tenant', async () => {
        const { articleId } = await createArticle(null, `global-${randomUUID()}`);

        const fromA = await withTenantDb(TENANT_A, (tx) =>
            tx.knowledgeArticle.findUnique({ where: { id: articleId }, select: { id: true } }),
        );
        const fromB = await withTenantDb(TENANT_B, (tx) =>
            tx.knowledgeArticle.findUnique({ where: { id: articleId }, select: { id: true } }),
        );
        expect(fromA?.id).toBe(articleId);
        expect(fromB?.id).toBe(articleId);
    });

    it('a GLOBAL (NULL-tenant) article version is readable by any tenant', async () => {
        const { versionId } = await createArticle(null, `global-version-${randomUUID()}`);

        const fromA = await withTenantDb(TENANT_A, (tx) =>
            tx.knowledgeArticleVersion.findUnique({ where: { id: versionId }, select: { id: true } }),
        );
        const fromB = await withTenantDb(TENANT_B, (tx) =>
            tx.knowledgeArticleVersion.findUnique({ where: { id: versionId }, select: { id: true } }),
        );
        expect(fromA?.id).toBe(versionId);
        expect(fromB?.id).toBe(versionId);
    });

    // ── 4. app_user cannot INSERT a GLOBAL row directly ─────────────────

    it('app_user cannot INSERT a GLOBAL (NULL-tenant) article (WITH CHECK strict)', async () => {
        // WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))
        // can never be satisfied by a NULL tenantId — Postgres NULL = X is
        // NULL, never true, so the INSERT is rejected regardless of which
        // tenant's session is doing the inserting.
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "KnowledgeArticle" (id, "tenantId", slug, title, status, "lifecycleVersion", "createdAt", "updatedAt")
                     VALUES ($1, NULL, $2, 'Attempted GLOBAL insert', 'PUBLISHED', 1, now(), now())`,
                    `insert-attempt-${randomUUID()}`,
                    `${TAG}-insert-attempt-${randomUUID()}`,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('app_user cannot INSERT a GLOBAL (NULL-tenant) article version (WITH CHECK strict)', async () => {
        const { articleId } = await createArticle(TENANT_A, `insert-version-parent-${randomUUID()}`);

        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "KnowledgeArticleVersion" (id, "tenantId", "articleId", "versionNumber", "contentType", "createdById", "createdAt")
                     VALUES ($1, NULL, $2, 99, 'HTML', $3, now())`,
                    `insert-version-attempt-${randomUUID()}`,
                    articleId,
                    AUTHOR_ID,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    // ── 5. app_user cannot re-tenant a GLOBAL row via UPDATE ────────────

    it('app_user cannot re-tenant a GLOBAL article to a foreign tenant (WITH CHECK strict)', async () => {
        const { articleId } = await createArticle(null, `claim-${randomUUID()}`);

        // USING (NULL OR own) admits the GLOBAL row for the UPDATE's WHERE
        // clause; WITH CHECK (own) rejects writing a foreign tenantId onto it.
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "KnowledgeArticle" SET "tenantId" = $1 WHERE "id" = $2`,
                    TENANT_B,
                    articleId,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('app_user cannot re-tenant a GLOBAL article version to a foreign tenant (WITH CHECK strict)', async () => {
        const { versionId } = await createArticle(null, `claim-version-${randomUUID()}`);

        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "KnowledgeArticleVersion" SET "tenantId" = $1 WHERE "id" = $2`,
                    TENANT_B,
                    versionId,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    // ── 6. KnowledgeAcknowledgement's composite FK — DB-layer backstop ──

    it('a GLOBAL article version can never be acknowledged (composite FK rejects it)', async () => {
        const { versionId } = await createArticle(null, `unackable-${randomUUID()}`);

        // Mirrors what acknowledgeArticle's raw db.knowledgeAcknowledgement.create
        // would attempt if the usecase-level assertTenantOwned guard were ever
        // bypassed: the acknowledgement always carries the ACTING tenant's id,
        // but KnowledgeAcknowledgement_articleVersionId_tenantId_fkey requires
        // a KnowledgeArticleVersion row with id = versionId AND tenantId =
        // TENANT_A — which does not exist (the real row has tenantId NULL).
        await expect(
            withTenantDb(TENANT_A, (tx) =>
                tx.knowledgeAcknowledgement.create({
                    data: { tenantId: TENANT_A, articleVersionId: versionId, userId: AUTHOR_ID },
                }),
            ),
        ).rejects.toThrow(/foreign key constraint|violates foreign key/i);
    });
});
