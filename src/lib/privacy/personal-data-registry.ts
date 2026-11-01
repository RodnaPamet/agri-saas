/**
 * Every column that names a PERSON, and what happens to it (P5.6, #1597).
 *
 * ## One registry, two consumers, and that is the point
 *
 * The export and the erasure must agree. A column exported but not erased is a
 * promise broken in one direction; a column erased but not exported is a
 * person's data destroyed without ever being shown to them. Two lists would
 * drift, so there is one, and each entry carries the disposition both consumers
 * read.
 *
 * ## It is DERIVED-complete, not enumerated
 *
 * `tests/guards/personal-data-registry-complete.test.ts` walks
 * `Prisma.dmmf.datamodel.models` and fails when a tenantless model gains a
 * person-naming column that is not classified here. That is what #1597 asks
 * for, and the reason it matters is in that issue: pseudonymisation is an
 * UPDATE across enumerated columns rather than a cascade, so "a new table
 * holding a person id is a new place to forget". A guard that reads the schema
 * cannot forget.
 *
 * P5.1's four trust & safety tables carry no foreign key to `User` precisely so
 * this decision stayed open — an FK would have forced an `onDelete`, and
 * `Cascade` would have destroyed the moderation record of a resolved case.
 *
 * ## Scope: TENANTLESS columns only, and why that is not a gap
 *
 * 67 models carry a person-naming column; 49 of them also carry a `tenantId`.
 * Those are farm records — a journal entry recording a spray, a task someone
 * closed — and the person's name on them is authorship, not subject matter. The
 * record belongs to the farm, which has its own retention duties (БАБХ
 * ДНЕВНИК), and erasing a farmer's name from the farm's own compliance diary
 * would damage a record the farm is required to keep.
 *
 * So this registry covers the 18 tenantless ones, where the row exists BECAUSE
 * of the person rather than because of the farm. The boundary is stated in the
 * privacy notice rather than left implicit.
 *
 * ## The basis is Art 17(3)(b), owner ruling 2026-10-11
 *
 * Legal obligation. The DSA audit trail survives erasure, so a `ContentReport`
 * stays linkable to the person who filed it and **erasure is incomplete** —
 * which the privacy notice says plainly. The alternative bases were weighed and
 * declined on #1597; `RETAIN` entries below are that ruling expressed per
 * column.
 */

/** What erasure does to a column, and whether an export includes it. */
export type Disposition =
    /**
     * Erased, and included in an export. The ordinary case for data that exists
     * because of this person. HOW it is erased — the row deleted, or the column
     * overwritten with a pseudonym — is the entry's `action`.
     */
    | 'ERASE_AND_EXPORT'
    /**
     * Erased, NOT exported. Credentials and session rows:
     * handing someone a copy of their own password-reset token or OAuth refresh
     * token in a file they may email to themselves is a hazard, and it answers
     * no question they asked.
     */
    | 'ERASE_ONLY'
    /**
     * Survives erasure under Art 17(3)(b), and is exported — because if we are
     * keeping it, the person is entitled to see that we are.
     */
    | 'RETAIN_AND_EXPORT'
    /**
     * Survives erasure and is NOT exported. Platform-internal audit whose
     * disclosure would reveal another party's moderation activity.
     */
    | 'RETAIN_ONLY';

/**
 * HOW a column is erased.
 *
 * Needed because every erasable person column in this schema is **REQUIRED**
 * (`String`, no `?`) — measured against the schema text, after a DMMF probe
 * reported them all nullable and turned out to be reading an `isRequired`
 * property Prisma 7 no longer emits. So NULLing is not available, and each
 * entry has to say which of the two real options applies.
 */
export type ErasureAction =
    /**
     * The row goes. Right where the row has no meaning without the person: a
     * credential, a cohort membership, a block they made.
     */
    | 'DELETE_ROW'
    /**
     * The person column is overwritten with a per-erasure random pseudonym,
     * and the row survives. Right where the row is also somebody ELSE's record
     * — a listing the farm still sells, a conversation the counterparty is
     * still in.
     *
     * The pseudonym is per-USER and random, not a shared `deleted-user`
     * sentinel, and the reason is a constraint rather than taste:
     * `ExchangeThread` carries `@@unique([listingId, inquirerUserId])`, so two
     * deleted people who both enquired on one listing would collide on a
     * shared value. A per-user pseudonym also keeps a conversation coherent
     * for the counterparty, who can still see that one (unknown) person sent
     * these messages.
     *
     * The mapping is generated at erasure time and stored NOWHERE, so these
     * rows are anonymised rather than merely pseudonymised. The person stays
     * identifiable only through the `RETAIN` columns, which is the Art 17(3)(b)
     * ruling and the reason the privacy notice says erasure is incomplete.
     */
    | 'PSEUDONYMISE_COLUMN';

export interface PersonalDataEntry {
    /** Prisma model name. */
    readonly model: string;
    /** The scalar column(s) on it that name a person. */
    readonly columns: readonly string[];
    readonly disposition: Disposition;
    /**
     * Present exactly when the disposition erases. The guard enforces that
     * pairing, so a `RETAIN` entry cannot carry an action nobody runs and an
     * `ERASE` entry cannot be missing one.
     */
    readonly action?: ErasureAction;
    /** Why. Required — the guard rejects a short or placeholder reason. */
    readonly reason: string;
}

/**
 * Every tenantless person-naming column in the schema.
 *
 * Ordered as the guard reports them (alphabetical by model) so a diff against
 * a failure message is readable.
 */
export const PERSONAL_DATA_REGISTRY: readonly PersonalDataEntry[] = [
    {
        model: 'Account',
        columns: ['userId'],
        disposition: 'ERASE_ONLY',
        action: 'DELETE_ROW',
        reason:
            'OAuth provider linkage holding access and refresh tokens. Deleted at '
            + 'erasure because a dangling provider link would let the same IdP identity '
            + 'resolve to a pseudonymised row and sign in. Never exported: a live '
            + 'refresh token in a downloadable file is a credential leak, and it '
            + 'answers nothing the person asked.',
    },
    {
        model: 'AssistantMemoryFact',
        columns: ['userId'],
        // ERASE_ONLY for THIS release only, and the reason is staging rather
        // than policy. #2683 ships the table with NO writer (P5's rule), so an
        // export could only ever return an empty array — and wiring one would
        // make `AssistantMemoryFact` referenced in `src/`, which the
        // rich-text coverage guard reads as a live write path needing a named
        // sanitiser that does not exist yet either. Two guards, both right,
        // and the honest way through is to let each PR be internally
        // consistent.
        //
        // The memory API PR flips this to ERASE_AND_EXPORT, wires the export,
        // and registers `editRememberedPoint` as the sanitiser — all three in
        // one diff, because they are one fact about the system.
        disposition: 'ERASE_ONLY',
        action: 'DELETE_ROW',
        reason:
            'The assistant\'s per-person memory profile (#2671) — what it remembers '
            + 'about someone across all their farms. NOT YET EXPORTED — the table has no '
            + 'writer in this release, so an export would return an empty array; the '
            + 'memory API PR flips this to ERASE_AND_EXPORT, where "what does it know '
            + 'about me" is the clearest possible Art 15 case and is also what the '
            + 'in-product «Какво помни асистентът» screen shows. DELETED rather than '
            + 'pseudonymised because the row has no meaning without the person — it '
            + 'is a statement ABOUT them, not somebody else\'s record that merely '
            + 'names them, so there is no second party whose history would lose its '
            + 'subject. That is the same test ExchangeBlock fails and Account passes.'
            + ' Note the row also carries the person\'s verbatim sentence as evidence, '
            + 'which makes retaining it indefensible once they are gone.',
    },
    {
        model: 'AuthSession',
        columns: ['userId'],
        disposition: 'ERASE_ONLY',
        action: 'DELETE_ROW',
        reason:
            'NextAuth session rows. Deleted so no credential outlives the erasure. '
            + 'Not exported for the same reason as Account.',
    },
    {
        model: 'ContentReport',
        columns: ['reporterUserId'],
        disposition: 'RETAIN_AND_EXPORT',
        reason:
            'The DSA Art 16 notice trail, retained under Art 17(3)(b) — the owner '
            + 'ruling of 2026-10-11. This is the column that makes erasure INCOMPLETE: '
            + 'a notice stays linkable to the person who filed it, so a moderation '
            + 'history remains answerable and repeat-abuse detection survives a '
            + 're-registration. Exported because a person is entitled to see what we '
            + 'keep about them, and the privacy notice states this specific survival.',
    },
    {
        model: 'ExchangeBlock',
        columns: ['blockedUserId', 'createdByUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'A commercial block between a farm and a person. Overwritten at erasure '
            + 'because the row names a person rather than recording a legal duty — and '
            + 'exported so a person can see who has refused to deal with them, which '
            + 'is information the exchange already discloses to them live.',
    },
    {
        model: 'ExchangeInquiry',
        columns: ['inquirerUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'An enquiry this person made about a listing. Their own act, so theirs to '
            + 'receive and to have overwritten.',
    },
    {
        model: 'ExchangeListing',
        columns: ['sellerUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'Authorship of a listing. The LISTING belongs to the selling farm and is '
            + 'untouched; only the column naming which member created it is '
            + 'overwritten, so the farm keeps its commercial record and the person '
            + 'stops being named on it.',
    },
    {
        model: 'ExchangeMessage',
        columns: ['senderUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'Messages this person sent. The message BODY is encrypted and belongs to a '
            + 'conversation with a counterparty who also has rights over it, so the '
            + 'body is retained while the authorship column is overwritten — the same '
            + 'shape as ExchangeListing. Exported because the words are theirs.',
    },
    {
        model: 'ExchangeThread',
        columns: ['inquirerUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'The conversation this person opened. Overwritten rather than deleted, '
            + 'because the counterparty farm retains its side of a negotiation.',
    },
    {
        model: 'FeatureFlag',
        columns: ['updatedByUserId'],
        disposition: 'RETAIN_ONLY',
        reason:
            'Platform operator attribution, and deliberately left NULL by the console '
            + 'today (the credential is an API key, so there is no user in scope). '
            + 'Retained because a non-null value would be a platform change record; '
            + 'not exported because it concerns platform operation rather than the '
            + 'person, and in practice there is nothing there to export.',
    },
    {
        model: 'FeatureFlagCohortMember',
        columns: ['userId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'DELETE_ROW',
        reason:
            'Membership of a dark-launch cohort. Deleted at erasure — a pseudonymised '
            + 'row has no reason to stay in a rollout cohort — and exported because '
            + '"which experiments was I in" is a fair question.',
    },
    {
        model: 'InsuranceLead',
        columns: ['inquirerUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'An insurance quote this person requested, carrying figures they supplied. '
            + 'Theirs on both counts.',
    },
    {
        model: 'OrgAuditLog',
        columns: ['actorUserId', 'targetUserId'],
        disposition: 'RETAIN_ONLY',
        reason:
            'A hash-chained organisation audit trail with an immutability trigger. '
            + 'Rewriting a row inside the chain breaks verification for every entry '
            + 'after it, so erasure must work AROUND the chain rather than through it '
            + '(#1597). Not exported: the chain records actions BY and ON many people, '
            + 'and disclosing a row naming someone else is a disclosure about them.',
    },
    {
        model: 'OrgMembership',
        columns: ['userId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'DELETE_ROW',
        reason:
            'This person\'s membership of an organisation. Deleted at erasure — the '
            + 'last-OWNER trigger governs the order, which the erasure job must '
            + 'respect — and exported because "which organisations was I in" is their '
            + 'own relationship.',
    },
    {
        model: 'PasswordResetToken',
        columns: ['userId'],
        disposition: 'ERASE_ONLY',
        action: 'DELETE_ROW',
        reason:
            'A single-use reset token, SHA-256 hashed at rest. Deleted so no reset '
            + 'path survives the erasure. Never exported, even hashed: it is a '
            + 'credential artefact.',
    },
    {
        model: 'PlatformAuditLog',
        columns: ['actorUserId'],
        disposition: 'RETAIN_ONLY',
        reason:
            'The platform hash chain, append-only at the database via '
            + '`platform_audit_log_immutable`. Same reasoning as OrgAuditLog, and this '
            + 'one additionally carries the moderation history P5.9 writes — the '
            + 'record a regulator would ask for.',
    },
    {
        model: 'PromotionLead',
        columns: ['inquirerUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'PSEUDONYMISE_COLUMN',
        reason:
            'A promotion enquiry, already on a retention sweep of its own '
            + '(`promotion-lead-retention`). Erasure overwrites the person column '
            + 'ahead of that sweep rather than waiting for it.',
    },
    {
        model: 'StatementOfReasons',
        columns: ['recipientUserId'],
        disposition: 'RETAIN_AND_EXPORT',
        reason:
            'A DSA Art 17 statement addressed to this person, retained under Art '
            + '17(3)(b) with the notice it explains. Exported deliberately, which is a '
            + 'change of posture from P5.1: that phase gave the recipient NO read '
            + 'access because a row-level policy arm would expose `actionId` and '
            + 'through it the moderation rationale. An export is not a policy arm — it '
            + 'runs on the privileged path, for one named person, over their own rows '
            + 'only, and they were sent this text by email already. Withholding a copy '
            + 'of a letter we wrote to them would be indefensible under Art 15.',
    },
    {
        model: 'UserBlock',
        columns: ['blockerUserId', 'blockedUserId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'DELETE_ROW',
        reason:
            'Person-to-person social blocks. Deleted at erasure in BOTH directions: a '
            + 'block made by a pseudonymised account protects nobody, and a block '
            + 'against one refuses nobody. Exported only as blocks this person MADE — '
            + 'see the usecase, where disclosing who blocked them would defeat the '
            + 'silence P5.2b exists to provide.',
    },
    {
        model: 'PersonProfile',
        columns: ['userId'],
        disposition: 'ERASE_AND_EXPORT',
        action: 'DELETE_ROW',
        reason:
            'P6.1 — a person\u2019s own public identity (displayName, about). DELETE_ROW '
            + 'rather than PSEUDONYMISE_COLUMN, because here the ROW is the personal '
            + 'data and not merely keyed by it: pseudonymising `userId` would leave a '
            + 'published profile carrying someone\u2019s name and self-description '
            + 'attached to a random pseudonym \u2014 the content still identifies them '
            + 'and now nothing can find it to remove. Exported, because a person asking '
            + 'for their data should receive what they wrote about themselves. '
            + 'The FK cascade does NOT cover this: `onDelete: Cascade` fires when a '
            + 'User row is DELETED, and P5.6 erasure PSEUDONYMISES the user instead, so '
            + 'the User survives and the cascade never runs. An entry here is what '
            + 'actually removes it.',
    },
];

/** Fast lookup by model name. */
export const REGISTRY_BY_MODEL: ReadonlyMap<string, PersonalDataEntry> = new Map(
    PERSONAL_DATA_REGISTRY.map((e) => [e.model, e]),
);

/** Models whose person columns an export must read. */
export const EXPORTED_MODELS: readonly string[] = PERSONAL_DATA_REGISTRY
    .filter((e) => e.disposition === 'ERASE_AND_EXPORT' || e.disposition === 'RETAIN_AND_EXPORT')
    .map((e) => e.model);

/** Models whose person columns an erasure must overwrite or delete. */
export const ERASED_MODELS: readonly string[] = PERSONAL_DATA_REGISTRY
    .filter((e) => e.disposition === 'ERASE_AND_EXPORT' || e.disposition === 'ERASE_ONLY')
    .map((e) => e.model);

/**
 * Models that survive erasure, which is the list the privacy notice must match.
 *
 * Exported as data rather than prose so the notice and the code cannot drift —
 * #1597's third exit criterion is that they agree.
 */
export const RETAINED_MODELS: readonly string[] = PERSONAL_DATA_REGISTRY
    .filter((e) => e.disposition === 'RETAIN_AND_EXPORT' || e.disposition === 'RETAIN_ONLY')
    .map((e) => e.model);
