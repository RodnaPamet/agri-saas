/**
 * Knowledge Base — DB-backed integration tests.
 *
 * Coverage
 * --------
 *   1. The DRAFT → PUBLISH → ACKNOWLEDGE lifecycle, mirroring Policy:
 *      createArticle (DRAFT + v1), publishArticle (PUBLISHED), worker
 *      acknowledgeArticle (idempotent on the version+user unique).
 *   2. A new version on a PUBLISHED article keeps serving the published
 *      content — it does NOT roll the article back to DRAFT (2026-08-07:
 *      unlike Policy, unpublishing the live SOP the instant someone
 *      starts drafting an edit would retract the procedure a worker is
 *      following mid-task). Only `publishArticle` moves the pointer.
 *   3. Acknowledging a non-PUBLISHED article is rejected.
 *   4. listAcknowledgements reports who acknowledged.
 *   5. HTML content is sanitised on write (a <script> is stripped).
 *   6. The article is discoverable via the unified search surface.
 *   7. Reader status floor: a READER context never receives a DRAFT/
 *      ARCHIVED article from listArticles, even asking for it by name.
 *   8. updateArticleMetadata edits title/summary/category/owner without
 *      touching status or currentVersionId; unarchiveArticle restores
 *      PUBLISHED (if ever published) or DRAFT (if not), idempotently.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createArticle,
    createArticleVersion,
    publishArticle,
    archiveArticle,
    unarchiveArticle,
    updateArticleMetadata,
    acknowledgeArticle,
    listAcknowledgements,
    getArticle,
    listArticles,
    listCategories,
} from '@/app-layer/usecases/knowledge';
import { getUnifiedSearch } from '@/app-layer/usecases/search';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `kb-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;

let ownerId = '';
let workerId = '';
let readerId = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: TENANT_ID, slug: TAG } });
    for (const label of ['owner', 'worker', 'reader']) {
        const email = `${TAG}-${label}@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        if (label === 'owner') ownerId = u.id;
        else if (label === 'worker') workerId = u.id;
        else readerId = u.id;
    }
    await prisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: workerId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: readerId, role: Role.READER, status: MembershipStatus.ACTIVE },
        ],
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "KnowledgeAcknowledgement" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "KnowledgeArticleVersion" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "KnowledgeArticle" WHERE "tenantId" = $1`, TENANT_ID);
        });
    } catch {
        /* globalSetup handles reset */
    }
    await prisma.$disconnect();
});

const ownerCtx = () => makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });
const workerCtx = () => makeRequestContext('EDITOR', { userId: workerId, tenantId: TENANT_ID, tenantSlug: TAG });
const readerCtx = () => makeRequestContext('READER', { userId: readerId, tenantId: TENANT_ID, tenantSlug: TAG });

describeFn('knowledge base (DB)', () => {
    let articleId = '';
    let versionId = '';

    test('createArticle drafts an article + v1, sanitising HTML content', async () => {
        const article = await createArticle(ownerCtx(), {
            title: `Spray Safety SOP ${TAG}`,
            category: 'Safety',
            summary: 'How to spray safely',
            contentType: 'HTML',
            content: '<p>Wear PPE.</p><script>alert(1)</script>',
        });
        articleId = article.id;

        const detail = await getArticle(ownerCtx(), articleId);
        expect(detail.status).toBe('DRAFT');
        expect(detail.versions).toHaveLength(1);
        expect(detail.currentVersionId).toBeTruthy();
        expect(detail.acknowledged).toBe(false);
        versionId = detail.currentVersionId!;

        // <script> stripped on write; the paragraph survives.
        const version = detail.versions[0];
        expect(version.contentText).toContain('Wear PPE');
        expect(version.contentText).not.toContain('<script');
    });

    test('acknowledging a DRAFT article is rejected', async () => {
        await expect(acknowledgeArticle(workerCtx(), articleId)).rejects.toThrow(/Only PUBLISHED/);
    });

    test('publish → worker acknowledges (idempotent) → admin sees the receipt', async () => {
        await publishArticle(ownerCtx(), articleId, versionId);
        const published = await getArticle(ownerCtx(), articleId);
        expect(published.status).toBe('PUBLISHED');

        const first = await acknowledgeArticle(workerCtx(), articleId);
        expect(first.created).toBe(true);
        const second = await acknowledgeArticle(workerCtx(), articleId);
        expect(second.created).toBe(false); // idempotent on (version, user)

        const acks = await listAcknowledgements(ownerCtx(), articleId);
        expect(acks.map((a) => a.user.id)).toContain(workerId);

        // The worker now sees their own acknowledgement on the detail.
        const asWorker = await getArticle(workerCtx(), articleId);
        expect(asWorker.acknowledged).toBe(true);
    });

    test('a new version on a PUBLISHED article keeps serving the published content', async () => {
        await createArticleVersion(ownerCtx(), articleId, {
            contentType: 'HTML',
            contentText: '<p>Updated PPE guidance.</p>',
            changeSummary: 'PPE update',
        });
        const detail = await getArticle(ownerCtx(), articleId);
        // Still PUBLISHED — drafting an edit must never retract the live
        // SOP a worker is currently following.
        expect(detail.status).toBe('PUBLISHED');
        expect(detail.currentVersionId).toBe(versionId);
        expect(detail.versions.length).toBe(2);
        // The new version exists as an unpublished draft underneath it.
        const newest = detail.versions.find((v) => v.id !== versionId);
        expect(newest).toBeDefined();
        expect(newest!.contentText).toContain('Updated PPE guidance');

        // A reader still reads the OLD published content — publish is the
        // only thing that moves currentVersionId.
        const asReader = await getArticle(readerCtx(), articleId);
        expect(asReader.currentVersion?.id).toBe(versionId);
        expect(asReader.currentVersion?.contentText).toContain('Wear PPE');
    });

    test('reader status floor: a READER never sees the DRAFT/unpublished version via listArticles', async () => {
        // At this point the article is PUBLISHED with one unpublished v2
        // draft underneath it. Both the owner (canWrite) and the reader
        // (cannot write) should see the article — but only the owner's
        // request is allowed to ask for non-PUBLISHED statuses at all.
        const asOwnerList = await listArticles(ownerCtx());
        expect(asOwnerList.map((a) => a.id)).toContain(articleId);

        const asReaderList = await listArticles(readerCtx());
        expect(asReaderList.map((a) => a.id)).toContain(articleId);

        // A reader explicitly asking for DRAFT gets the floor applied —
        // the request is OVERRIDDEN to PUBLISHED-only, not honoured.
        const readerAskingForDraft = await listArticles(readerCtx(), { status: ['DRAFT'] });
        expect(readerAskingForDraft.every((a) => a.status === 'PUBLISHED')).toBe(true);

        // A never-published article (status DRAFT) must never appear in a
        // reader's list, no matter what they ask for.
        const draftOnly = await createArticle(ownerCtx(), {
            title: `Reader-Floor Draft ${TAG}`,
            contentType: 'HTML',
            content: '<p>Unreviewed content.</p>',
        });
        const readerListAll = await listArticles(readerCtx());
        expect(readerListAll.map((a) => a.id)).not.toContain(draftOnly.id);
        const ownerListAll = await listArticles(ownerCtx());
        expect(ownerListAll.map((a) => a.id)).toContain(draftOnly.id);
    });

    test('updateArticleMetadata edits fields without touching status, currentVersionId, or title', async () => {
        // Title is deliberately left unchanged here — a later test searches
        // for the original title via the unified search surface.
        const before = await getArticle(ownerCtx(), articleId);
        const updated = await updateArticleMetadata(ownerCtx(), articleId, {
            summary: 'How to spray safely (revised)',
        });
        expect(updated!.title).toBe(before.title);
        expect(updated!.summary).toBe('How to spray safely (revised)');
        expect(updated!.status).toBe(before.status);
        expect(updated!.currentVersionId).toBe(before.currentVersionId);
    });

    test('archive → unarchive restores PUBLISHED (currentVersionId survives the round trip)', async () => {
        await archiveArticle(ownerCtx(), articleId);
        const archived = await getArticle(ownerCtx(), articleId);
        expect(archived.status).toBe('ARCHIVED');
        expect(archived.currentVersionId).toBe(versionId); // untouched by archive

        const restored = await unarchiveArticle(ownerCtx(), articleId);
        expect(restored!.status).toBe('PUBLISHED'); // was published before archiving
        expect(restored!.currentVersionId).toBe(versionId);

        // Idempotent — unarchiving an already-unarchived article is a no-op.
        const again = await unarchiveArticle(ownerCtx(), articleId);
        expect(again!.status).toBe('PUBLISHED');
    });

    test('unarchive on a never-published article restores DRAFT, not PUBLISHED', async () => {
        const neverPublished = await createArticle(ownerCtx(), {
            title: `Never Published ${TAG}`,
            contentType: 'HTML',
            content: '<p>Draft only.</p>',
        });
        await archiveArticle(ownerCtx(), neverPublished.id);
        const restored = await unarchiveArticle(ownerCtx(), neverPublished.id);
        expect(restored!.status).toBe('DRAFT');
    });

    test('list + categories surface the article', async () => {
        const list = await listArticles(ownerCtx());
        expect(list.map((a) => a.id)).toContain(articleId);
        const cats = await listCategories(ownerCtx());
        expect(cats).toContain('Safety');
    });

    test('the article is discoverable via the unified search surface', async () => {
        const res = await getUnifiedSearch(ownerCtx(), `Spray Safety SOP ${TAG}`);
        const hit = res.hits.find((h) => h.type === 'knowledge' && h.id === articleId);
        expect(hit).toBeDefined();
        expect(hit!.href).toContain(`/knowledge/${articleId}`);
    });
});
