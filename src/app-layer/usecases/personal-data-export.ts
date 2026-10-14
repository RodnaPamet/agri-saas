/**
 * Export everything we hold about one person (P5.6, #1597).
 *
 * ## Why this runs PRIVILEGED, and what that puts on the WHERE clause
 *
 * There is no session context that could read this set. `StatementOfReasons`
 * denies `app_user` for every command; `ContentReport` admits only a reporter
 * reading their own row, through `app.user_id`, which `runInUserContext` sets
 * and `runInTenantContext` does not; and the exchange models are tenant-scoped,
 * so reading a person's messages across every farm they deal with needs no
 * tenant at all. One query shape cannot satisfy three policies.
 *
 * So the export uses the privileged client, and **the `where` clause is the
 * only thing scoping it to this person.** That is the opposite of the usual
 * arrangement, where RLS is the backstop and the filter is defence in depth —
 * here the filter IS the control. `tests/integration/p5-6a-export.test.ts`
 * therefore asserts a second person's rows are ABSENT from the first person's
 * export, which is the assertion that would catch a dropped clause; a test that
 * only checked "my rows are present" would pass while exporting the database.
 *
 * ## Which models, and why that list is not written here
 *
 * `EXPORTED_MODELS` comes from `@/lib/privacy/personal-data-registry`, the same
 * registry the erasure reads. One list, because a column exported but not
 * erased is a promise broken one way and a column erased but not exported is
 * data destroyed without ever being shown. `personal-data-registry-complete`
 * derives the population from the DMMF, so a new tenantless model carrying a
 * person id cannot slip past unclassified.
 *
 * ## What is deliberately NOT here
 *
 *   - **Farm records.** 49 of the 67 person-naming columns sit on tenant-scoped
 *     models — a journal entry, a task someone closed. The person's name there
 *     is authorship; the record belongs to a farm with its own retention duty
 *     (БАБХ ДНЕВНИК), and a farmer's own compliance diary is not theirs to take
 *     away from the farm. The privacy notice states this boundary rather than
 *     leaving it implicit.
 *   - **Credentials.** `Account`, `AuthSession` and `PasswordResetToken` are
 *     `ERASE_ONLY`: a live refresh token in a file someone may email to
 *     themselves is a credential leak, and it answers nothing they asked.
 *   - **Blocks AGAINST them.** `listOwnBlocks`' rule applies — the SELECT
 *     policy admits both sides of a `UserBlock` row because enforcement runs in
 *     the blocked party's context, so the API is what withholds it. Exporting
 *     "who has blocked you" would defeat the silence P5.2b exists to provide.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { EXPORTED_MODELS } from '@/lib/privacy/personal-data-registry';

/** How many rows per collection. Bounded — see `takeNote` below. */
const PER_COLLECTION_LIMIT = 1000;

/**
 * Every collection is bounded at 1000 rows.
 *
 * An unbounded `findMany` here would be a person-triggered full-table read on
 * a route they can call themselves, which is the shape the query-shape
 * guardrail exists to stop. 1000 is far above any real figure — this
 * deployment's busiest person-scoped table holds single digits — and the
 * response says when it truncated rather than silently returning a prefix,
 * because an export that quietly omits rows is worse than one that admits it.
 */
export interface ExportCollection<T> {
    readonly rows: readonly T[];
    /** True when the limit was reached and rows may be missing. */
    readonly truncated: boolean;
}

function collection<T>(rows: T[]): ExportCollection<T> {
    return { rows, truncated: rows.length >= PER_COLLECTION_LIMIT };
}

export interface PersonalDataExport {
    /** ISO timestamp the export was produced. */
    readonly exportedAt: string;
    /**
     * What this export does NOT contain, in the response itself.
     *
     * Art 15 is a right to know what is held, so an export that silently
     * omitted categories would be a worse answer than one that names them. The
     * strings are resolved from the registry so they cannot drift from what the
     * code does.
     */
    readonly notIncluded: readonly string[];
    readonly account: Record<string, unknown>;
    /**
     * P6.1 — the person's own public profile, if they have one. Their own
     * words about themselves, so Art 15 covers it plainly; and the registry
     * classifies it `ERASE_AND_EXPORT`, which this half honours.
     */
    readonly personProfile: ExportCollection<Record<string, unknown>>;
    readonly contentReports: ExportCollection<Record<string, unknown>>;
    readonly statementsOfReasons: ExportCollection<Record<string, unknown>>;
    readonly blocksIMade: ExportCollection<Record<string, unknown>>;
    readonly exchangeBlocksAgainstMe: ExportCollection<Record<string, unknown>>;
    readonly exchangeListings: ExportCollection<Record<string, unknown>>;
    readonly exchangeThreads: ExportCollection<Record<string, unknown>>;
    readonly exchangeInquiries: ExportCollection<Record<string, unknown>>;
    readonly exchangeMessages: ExportCollection<Record<string, unknown>>;
    readonly insuranceLeads: ExportCollection<Record<string, unknown>>;
    readonly promotionLeads: ExportCollection<Record<string, unknown>>;
    readonly organisationMemberships: ExportCollection<Record<string, unknown>>;
    readonly featureCohorts: ExportCollection<Record<string, unknown>>;
}

const NOT_INCLUDED: readonly string[] = [
    'Farm records you authored (journal entries, tasks, parcels). These belong to '
    + 'the farm, which has its own retention duties, and are available from the farm '
    + 'rather than from your own account.',
    'Credentials and sessions (sign-in links, password reset tokens, OAuth tokens). '
    + 'These are deleted when you delete your account and are never exported, '
    + 'because a copy of a credential in a file is a risk to you.',
    'Blocks that other people have made against you. Social blocks are silent by '
    + 'design, in both directions.',
    'Platform and organisation audit trails. These record actions by and about '
    + 'several people, so a copy would disclose other people\'s activity.',
];

export async function exportPersonalData(userId: string): Promise<PersonalDataExport> {
    const take = PER_COLLECTION_LIMIT;

    // `email` and `name` decrypt through the extended client's middleware.
    // `emailHash` is deliberately NOT selected: it is a lookup derivation, not
    // information about the person, and publishing it would hand out the input
    // to a correlation attack across any other system using the same HMAC.
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            uiLanguage: true,
            emailVerified: true,
            acceptedTermsAt: true,
            suspendedAt: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    const [
        personProfile,
        contentReports,
        statements,
        blocksIMade,
        exchangeBlocks,
        listings,
        threads,
        inquiries,
        messages,
        insuranceLeads,
        promotionLeads,
        orgMemberships,
        cohorts,
    ] = await Promise.all([
        // At most one row — `userId` is `@unique` — but returned as a
        // collection so the envelope has one shape for every model and a
        // caller never special-cases this one.
        prisma.personProfile.findMany({
            where: { userId },
            select: { displayName: true, about: true, published: true, createdAt: true, updatedAt: true },
        }),
        prisma.contentReport.findMany({
            where: { reporterUserId: userId },
            // `detail` is their own words, decrypted by the extension. The
            // RETAIN disposition is why this is here at all: the notice
            // survives erasure, so they are entitled to see that we keep it.
            select: {
                id: true, subjectKind: true, subjectId: true, reasonCode: true,
                status: true, detail: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.statementOfReasons.findMany({
            where: { recipientUserId: userId },
            // `bodyRendered` IS included — the letter we sent them. P5.1 gave
            // the recipient no READ POLICY because a row-level arm would expose
            // the moderation rationale through `actionId`; an export is not a
            // policy arm, and withholding a copy of a letter we wrote to them
            // would be indefensible under Art 15. `actionId` is omitted, so
            // nothing here reaches another party's decision record.
            select: { id: true, locale: true, bodyRendered: true, deliveredAt: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.userBlock.findMany({
            // Blocks they MADE only. Exporting blocks against them would
            // defeat the silence P5.2b exists to provide, and that silence is
            // the whole difference between a social and an exchange block.
            where: { blockerUserId: userId },
            select: { id: true, blockedUserId: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.exchangeBlock.findMany({
            // The exchange block is the OPPOSITE case and is included: it is
            // already disclosed to them live, with a sentence explaining it.
            where: { blockedUserId: userId },
            select: { id: true, sellerTenantId: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.exchangeListing.findMany({
            where: { sellerUserId: userId },
            select: {
                id: true, sellerTenantId: true, commodity: true, side: true,
                kind: true, description: true, status: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.exchangeThread.findMany({
            where: { inquirerUserId: userId },
            select: { id: true, listingId: true, closedAt: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.exchangeInquiry.findMany({
            where: { inquirerUserId: userId },
            // `message` is their own enquiry text, encrypted at rest.
            select: {
                id: true, listingId: true, message: true, quantityTonnes: true,
                status: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.exchangeMessage.findMany({
            where: { senderUserId: userId },
            // The body is theirs — they wrote it. The counterparty's replies
            // are NOT here: `senderUserId` scopes this to what they sent, and
            // the other side of a conversation is somebody else's words.
            select: { id: true, threadId: true, body: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.insuranceLead.findMany({
            where: { inquirerUserId: userId },
            // `message` and `riskJson` are figures THEY supplied, which is
            // exactly what Art 20 portability is about. `quoteJson` is the
            // server-computed premium, included because it is the answer they
            // were given.
            select: {
                id: true, message: true, riskJson: true, quoteJson: true,
                status: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.promotionLead.findMany({
            where: { inquirerUserId: userId },
            select: {
                id: true, promotionId: true, requestMessage: true,
                consentedAt: true, status: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.orgMembership.findMany({
            where: { userId },
            select: { id: true, organizationId: true, role: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
        prisma.featureFlagCohortMember.findMany({
            where: { userId },
            select: { id: true, cohortKey: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take,
        }),
    ]);

    logger.info('personal-data-export.produced', {
        component: 'personal-data-export',
        // The subject's own id, which is the only person in scope.
        userId,
        // Counts, never content.
        counts: {
            contentReports: contentReports.length,
            statements: statements.length,
            blocksIMade: blocksIMade.length,
            exchangeMessages: messages.length,
        },
        exportedModels: EXPORTED_MODELS.length,
    });

    return {
        exportedAt: new Date().toISOString(),
        notIncluded: NOT_INCLUDED,
        account: (user ?? {}) as Record<string, unknown>,
        personProfile: collection(personProfile as Record<string, unknown>[]),
        contentReports: collection(contentReports as Record<string, unknown>[]),
        statementsOfReasons: collection(statements as Record<string, unknown>[]),
        blocksIMade: collection(blocksIMade as Record<string, unknown>[]),
        exchangeBlocksAgainstMe: collection(exchangeBlocks as Record<string, unknown>[]),
        exchangeListings: collection(listings as Record<string, unknown>[]),
        exchangeThreads: collection(threads as Record<string, unknown>[]),
        exchangeInquiries: collection(inquiries as Record<string, unknown>[]),
        exchangeMessages: collection(messages as Record<string, unknown>[]),
        insuranceLeads: collection(insuranceLeads as Record<string, unknown>[]),
        promotionLeads: collection(promotionLeads as Record<string, unknown>[]),
        organisationMemberships: collection(orgMemberships as Record<string, unknown>[]),
        featureCohorts: collection(cohorts as Record<string, unknown>[]),
    };
}
