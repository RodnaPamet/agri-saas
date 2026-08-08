/**
 * Structural index-coverage guardrail — the four-layer framework.
 *
 * ─── Why this file exists ───────────────────────────────────────────
 *
 * This REPLACES two ad-hoc tests (`list-query-indexes.test.ts` and
 * `task-list-query-indexes.test.ts`). Those tests pinned a hand-listed
 * set of composite indexes to specific migration files. They had two
 * structural weaknesses:
 *
 *   1. They were coupled to migration filenames. A schema cleanup that
 *      reshaped a migration could false-fail or false-pass.
 *   2. They covered ONLY the indexes a human remembered to list. A new
 *      tenant-scoped model, or a new foreign key, was invisible to
 *      them — the guardrail did not grow with the schema.
 *
 * This framework fixes both. It reads the LIVE schema (via the
 * structured parser in `tests/helpers/prisma-schema-models.ts`),
 * never a migration file, and it has two AUTOMATIC layers that derive
 * their coverage from the schema itself — every current AND future
 * tenant model / foreign key is checked with zero maintenance.
 *
 * ─── The four layers ────────────────────────────────────────────────
 *
 *   Layer A — tenant-scoped models must be tenant-indexed.   [AUTO]
 *     Every model with a `tenantId` scalar field must have `tenantId`
 *     as the FIRST element of some `@@index` / `@@unique` / `@@id`.
 *     Postgres uses the leftmost prefix of a composite index, so a
 *     tenantId-leading index makes every per-tenant query efficient.
 *
 *   Layer B — foreign-key scalar fields must be indexed.     [AUTO]
 *     Every scalar FK column (the `fields: [...]` side of a
 *     `@relation`) must LEAD some index/uniqueness construct, so the
 *     reverse lookup ("rows pointing at parent X") is not a seq scan.
 *     `tenantId` is skipped here — Layer A owns it.
 *
 *   Layer C — curated composite-index registry.            [CURATED]
 *     A reviewed list of multi-column indexes that back specific list
 *     filter + sort shapes. Each entry is asserted to exist EXACTLY
 *     (order-sensitive) in the live schema. This is the home for the
 *     indexes the two retired tests guarded.
 *
 *   Layer C-completeness — the forcing function.            [AUTO]
 *     Scans `src/app-layer` for `.findMany(` calls, maps the accessor
 *     to a model, and asserts every tenant-scoped model that is
 *     `findMany`'d somewhere is EITHER in the Layer C registry OR in
 *     an explicit "tenant-index is sufficient" map. A NEW list query
 *     on a NEW model that is in neither map fails the test — the
 *     author is forced to triage that model's indexes.
 *
 * ─── How the baselines ratchet ──────────────────────────────────────
 *
 * Layers A and B carry exempt maps (`TENANT_INDEX_EXEMPT`,
 * `FK_INDEX_EXEMPT`). Every entry has a written reason. The exempt
 * maps encode TODAY's reality — they are a baseline, not a target.
 * The direction of travel is toward zero: when a real index lands for
 * an `R_TODO_INDEX` entry, that entry is deleted in the same diff.
 * A NEW violation that is not in the exempt map fails the test.
 *
 * ─── Registry integrity ─────────────────────────────────────────────
 *
 * Every model name mentioned in any map MUST resolve to a real parsed
 * model. A typo or a model rename trips the integrity test loudly,
 * rather than silently making an exemption a no-op.
 */
import {
    parseSchemaModels,
    leadingIndexedFields,
    type SchemaModel,
} from '../helpers/prisma-schema-models';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_LAYER_DIR = path.join(REPO_ROOT, 'src/app-layer');

const MODELS = parseSchemaModels();
const MODEL_BY_NAME = new Map<string, SchemaModel>(
    MODELS.map((m) => [m.name, m]),
);

// ─────────────────────────────────────────────────────────────────────
// LAYER A — tenant-scoped models must be tenant-indexed.
// ─────────────────────────────────────────────────────────────────────
//
// Every model with a `tenantId` scalar field must have `tenantId` as a
// LEADING indexed column. `leadingIndexedFields()` (the shared parser
// helper) recognises ALL the ways that happens:
//   - `tenantId` is the first element of an `@@index` / `@@unique` /
//     `@@id`, OR
//   - `tenantId` itself carries a field-level `@id` / `@unique` (a
//     singleton config row that is 1:1 with its tenant — e.g.
//     BillingAccount, TenantSecuritySettings, TaskKeySequence).
// All of those create a tenantId-leading index Postgres uses for every
// per-tenant query.
//
// This map is the escape hatch for a GENUINE exception — a tenant
// model that deliberately has no tenant-leading index. It is empty:
// every tenant-scoped model today is correctly tenant-indexed. A new
// entry here is a real design decision and must carry a written reason
// (a missing index is a bug — add `@@index([tenantId, ...])` instead).

const TENANT_INDEX_EXEMPT: Record<string, string> = {};

// ─────────────────────────────────────────────────────────────────────
// LAYER B — foreign-key scalar fields must be adequately indexed.
// ─────────────────────────────────────────────────────────────────────
//
// `fkAdequatelyIndexed()` (see the helper above) treats a FK as
// covered if EITHER it LEADS an index/uniqueness construct, OR — on a
// tenant-scoped model — it is the second column of a
// `[tenantId, fk, ...]` composite. The schema's deliberate convention
// is the latter: every repository query carries `tenantId`, so a
// `[tenantId, fk]` composite serves the universal
// `WHERE tenantId = ? AND fk = ?` reverse lookup. Layer B does NOT
// flag those — flagging a correctly-indexed FK would be a guardrail
// that cries wolf.
//
// The baseline below records the FKs that are genuinely NOT indexed
// (neither leading, nor in a tenant composite). Every entry is honest,
// one of five reason classes:
//
//   R_ACTOR        — audit-trail actor FK (createdBy / approvedBy /
//                    deletedBy / …). Never list-queried "by actor";
//                    the rare admin lookup tolerates a seq scan.
//   R_LIBRARY_TABLE— low-cardinality template / framework library
//                    table; children fetched via the parent include.
//   R_ONE_TO_ONE   — 1:1 pointer; the FK is never reverse-queried.
//   R_REVERSE_RARE — reverse lookup exists but is low-frequency;
//                    a sequential scan is acceptable for now.
//   R_CHILD_VIA_PARENT — child rows always loaded via a parent
//                    include, never by a bare FK scan.
//
// Ratchet direction: toward zero. An exemption is deleted the moment
// the FK gets a real index — the "no stale entries" test enforces it.
// (The 8 genuine index gaps this layer first surfaced were closed by
// migration 20260521120000_perf_fk_reverse_lookup_indexes.)

const R_ACTOR =
    'audit-trail actor FK (who created / changed / approved the row) — never list-queried in the "by actor" direction; the rare admin lookup tolerates a sequential scan. Ratchet target: index only if an actor-scoped list view ships.';
const R_LIBRARY_TABLE =
    'low-cardinality template / framework library table — child rows are always fetched via the parent include, not a bare FK scan; a sequential scan is acceptable.';
const R_ONE_TO_ONE =
    '1:1 pointer column — the FK is never reverse-queried (there is no "rows for parent X" list view for this relation).';
const R_REVERSE_RARE =
    'reverse lookup exists but is a low-frequency admin / background query — a sequential scan is acceptable today. Ratchet target: add an index if the reverse direction becomes a hot UI path.';
const R_CHILD_VIA_PARENT =
    'child rows are always loaded through the parent record\'s include (the parent FK is already indexed), never by a bare scan on this FK.';

const FK_INDEX_EXEMPT: Record<string, string> = {
    'AuditLog.userId': R_ACTOR,
    'OrgAuditLog.actorUserId': R_ACTOR,
    'OrgAuditLog.targetUserId': R_ACTOR,
    'AuditCycle.createdByUserId': R_ACTOR,
    'AuditPack.frozenByUserId': R_ACTOR,
    'AuditPackShare.createdByUserId': R_ACTOR,
    'OrgInvite.invitedById': R_ACTOR,
    'TenantApiKey.createdById': R_ACTOR,
    'TenantMembership.invitedByUserId': R_ACTOR,
    'AccessReview.createdByUserId': R_ACTOR,
    'AccessReview.closedByUserId': R_ACTOR,
    'AccessReview.deletedByUserId': R_ACTOR,
    'AccessReview.evidenceFileRecordId': R_ONE_TO_ONE,
    'AccessReviewDecision.decidedByUserId': R_ACTOR,
    'AccessReviewDecision.executedByUserId': R_ACTOR,
    'Account.userId': R_ACTOR,
    'AuthSession.userId': R_ACTOR,
    'TenantInvite.invitedById': R_ACTOR,
    'ReminderHistory.evidenceId': R_REVERSE_RARE,
    'IntegrationExecution.connectionId': R_REVERSE_RARE,
    'Task.createdByUserId': R_ACTOR,
    'Task.reviewerUserId': R_ACTOR,
    'TaskComment.createdByUserId': R_ACTOR,
    'TaskWatcher.userId': R_ACTOR,
    'Asset.ownerUserId': R_ACTOR,
    'Control.applicabilityDecidedByUserId': R_ACTOR,
    'Control.createdByUserId': R_ACTOR,
    'ControlAsset.createdByUserId': R_ACTOR,
    'ControlTask.assigneeUserId': R_ACTOR,
    'ControlEvidenceLink.createdByUserId': R_ACTOR,
    'Evidence.fileRecordId': R_ONE_TO_ONE,
    'FileRecord.uploadedByUserId': R_ACTOR,
    'EvidenceReview.reviewerId': R_ACTOR,
    'Policy.ownerUserId': R_ACTOR,
    'PolicyVersion.createdById': R_ACTOR,
    'PolicyApproval.approvedByUserId': R_ACTOR,
    'PolicyApproval.requestedByUserId': R_ACTOR,
    'PolicyAcknowledgement.userId': R_ACTOR,
    'FrameworkPack.frameworkId': R_LIBRARY_TABLE,
    'FrameworkMapping.toControlId': R_REVERSE_RARE,
    'FrameworkMapping.toRequirementId': R_REVERSE_RARE,
    'TreatmentMilestone.completedByUserId': R_ACTOR,
    'ProcessMap.createdByUserId': R_ACTOR,
    'ProcessMap.deletedByUserId': R_ACTOR,
    'ProcessMapSnapshot.createdByUserId': R_ACTOR,
    'Vendor.ownerUserId': R_ACTOR,
    'VendorDocument.uploadedByUserId': R_ACTOR,
    'VendorAssessmentTemplate.createdByUserId': R_ACTOR,
    'VendorAssessment.decidedByUserId': R_ACTOR,
    'VendorAssessment.requestedByUserId': R_ACTOR,
    'VendorAssessment.sentByUserId': R_ACTOR,
    'VendorAssessment.reviewedByUserId': R_ACTOR,
    'VendorAssessment.closedByUserId': R_ACTOR,
    'VendorAssessment.templateId': R_LIBRARY_TABLE,
    'VendorAssessment.templateVersionId': R_ONE_TO_ONE,
    'VendorAssessmentAnswer.questionId': R_CHILD_VIA_PARENT,
    'VendorAssessmentAnswer.evidenceId': R_ONE_TO_ONE,
    'VendorEvidenceBundle.createdByUserId': R_ACTOR,

    // ─── Agriculture (Feature 1 — spray-prescription map) ───
    // Actor FKs — same R_ACTOR rationale as every createdBy/owner/
    // completedBy reference above.
    'Item.createdByUserId': R_ACTOR,
    'Location.ownerUserId': R_ACTOR,
    'Location.createdByUserId': R_ACTOR,
    'OperationParcel.completedByUserId': R_ACTOR,
    // Catalog / file references — reverse lookups are not Feature-1 query
    // paths (access leads with [tenantId, …] / [tenantId, taskId]).
    'Item.defaultUnitId':
        'Feature 1 — Unit is a small global catalog; "items using unit X" is not a hot path. Revisit with the Phase 2 inventory module.',
    'Location.spatialFileId':
        'Feature 1 — near 1:1 to the original uploaded FileRecord; the reverse direction is never list-queried.',
    'OperationParcel.productItemId':
        'Feature 1 — "operations using product X" is deferred to the Phase 2 inventory ledger; per-job access is via [tenantId, taskId].',
    'OperationParcel.doseUnitId':
        'Feature 1 — Unit is a small global catalog; reverse lookup not on a hot path.',
    // ─── Inventory ledger (Phase 1) ───
    'InventoryLot.unitId':
        'Phase 1 — Unit is a small global catalog; the lot unit is read via the parent include, never reverse-scanned ("lots in unit X").',
    'StockTransaction.unitId':
        'Phase 1 — Unit is a small global catalog; the movement unit is read via the parent include, never reverse-scanned.',
    'StockTransaction.actorUserId': R_ACTOR,
    'LotLink.actorUserId': R_ACTOR,
    'LogEntry.createdByUserId': R_ACTOR,
    // ─── Field Journal ───
    // LogEntryFile.fileRecordId — the photo/document link is always read
    // through the parent LogEntry's `files` include (LogEntry.getById),
    // never reverse-scanned "which entries reference file X"; the
    // [logEntryId, fileRecordId] @@unique + [tenantId, logEntryId] index
    // serve the only access paths. FileRecord has no [id, tenantId]
    // barrier so this is a simple FK.
    'LogEntryFile.fileRecordId': R_CHILD_VIA_PARENT,
    // ─── Knowledge Base (mirrors Policy actor FKs) ───
    'KnowledgeArticle.ownerUserId': R_ACTOR,
    'KnowledgeArticleVersion.createdById': R_ACTOR,
};

// ─────────────────────────────────────────────────────────────────────
// LAYER C — curated composite-index registry.
// ─────────────────────────────────────────────────────────────────────
//
// Multi-column indexes that back specific list-page filter + sort
// shapes. Every entry is asserted to exist EXACTLY (order-sensitive)
// in the live schema.
//
// This is the MERGE of the two retired tests
// (`list-query-indexes.test.ts` + `task-list-query-indexes.test.ts`).
// Their exact fields + justifications are preserved verbatim. Unlike
// the retired tests, this checks the LIVE schema only — it is
// decoupled from migration filenames.
//
// Adding an index here: it must reflect a real filter/sort path in a
// list usecase. Removing one: do it only alongside removing the
// corresponding filter, and explain the replacement in the PR.

interface CompositeIndex {
    /** PascalCase model name. */
    model: string;
    /** Field list in declaration order — matches the @@index([...]) line. */
    fields: string[];
    /** The filter / sort path that justifies this index. */
    justification: string;
}

const LIST_QUERY_INDEXES: readonly CompositeIndex[] = [
    // ── Asset (machine register, since the Equipment merge) ─────────
    {
        model: 'Asset',
        fields: ['tenantId', 'type', 'status'],
        justification:
            'listMachines / validMachineIds filter tenantId + type IN (machine-shaped) + status != RETIRED — the equipment-picker query that `Equipment` used to serve.',
    },
    // ── Control (from list-query-indexes.test.ts) ───────────────────
    {
        model: 'Control',
        fields: ['tenantId', 'ownerUserId'],
        justification:
            'ControlListFilters.ownerUserId (existing [ownerUserId] is not tenant-prefixed)',
    },
    {
        model: 'Control',
        fields: ['tenantId', 'category'],
        justification: 'ControlListFilters.category',
    },
    // ── Evidence (from list-query-indexes.test.ts) ──────────────────
    {
        model: 'Evidence',
        fields: ['tenantId', 'status'],
        justification: 'EvidenceListFilters.status',
    },
    {
        model: 'Evidence',
        fields: ['tenantId', 'controlId'],
        justification:
            'EvidenceListFilters.controlId — control-detail evidence pull',
    },
    {
        model: 'Evidence',
        fields: ['tenantId', 'type'],
        justification: 'EvidenceListFilters.type',
    },
    // ── ControlTask (from list-query-indexes.test.ts) ───────────────
    {
        model: 'ControlTask',
        fields: ['tenantId', 'status', 'dueAt'],
        justification:
            'Dashboard overdue-tasks predicate + runConsistencyCheck overdue lookup',
    },
    // ── Task (from task-list-query-indexes.test.ts) ─────────────────
    {
        model: 'Task',
        fields: ['tenantId', 'priority', 'createdAt'],
        justification:
            "WorkItemRepository.list() default sort: [{ priority: 'asc' }, { createdAt: 'desc' }]",
    },
    {
        model: 'Task',
        fields: ['tenantId', 'dueAt', 'status'],
        justification:
            "due='overdue' / due='next7d' filter: dueAt range AND status NOT IN (TERMINAL_*)",
    },
    // ── TaskLink (from task-list-query-indexes.test.ts) ─────────────
    {
        model: 'TaskLink',
        fields: ['tenantId', 'entityType', 'entityId'],
        justification:
            'WorkItemRepository.list() linkedEntityType+linkedEntityId reverse-lookup',
    },
    // ── Enterprise-grain (Contract + YieldRecord list filters) ──────
    {
        model: 'Contract',
        fields: ['tenantId', 'status'],
        justification: 'listContracts status filter',
    },
    {
        model: 'YieldRecord',
        fields: ['tenantId', 'seasonId'],
        justification: 'listYieldRecords season filter',
    },
];

// ─────────────────────────────────────────────────────────────────────
// LAYER C-completeness — "tenant-index is sufficient" map.
// ─────────────────────────────────────────────────────────────────────
//
// Every tenant-scoped model that is `findMany`'d somewhere in
// `src/app-layer` MUST appear EITHER in `LIST_QUERY_INDEXES` above
// OR in this map. A new `findMany` on a model in neither map fails
// the Layer C-completeness test — the author is forced to triage
// whether that model's list query needs a composite index.
//
// An entry here is the explicit assertion "this model's list query
// is fully covered by Layers A + B — its `findMany`s filter only by
// `tenantId` plus a leading-indexed FK / status column, so no
// curated composite index is needed."

const LIST_MODELS_TENANT_INDEX_SUFFICIENT: Record<string, string> = {
    // ─── Exchange — the seller-side module opt-out list ───
    TenantModuleSettings:
        "ExchangeRepository.listTenantIdsWithModuleDisabled findMany filters `NOT (enabledModules has 'EXCHANGE')` across ALL tenants (deliberately unscoped — it answers \"who opted out?\" for the cross-tenant marketplace feed) and selects only { tenantId }, take:1000. No index helps: a NOT-contains over an enum[] cannot use a GIN index, and the predicate is anti-selective by nature. It stays cheap because a row exists ONLY for a tenant that customised its module list — the table is one row per customising tenant, not one per tenant. If it ever grows past the take, the fix is a denormalised flag on ExchangeListing, not an index here. Every other read on this model is a findUnique on the @unique tenantId.",
    // ─── News "For You" — per-user interest keywords ───
    UserInterest:
        "getUserInterests findMany filters by (tenantId, userId), orders by keyword asc, take:20 — covered by @@index([tenantId, userId]); the keyword sort runs in memory over a user's capped-at-20 self-service interest set. No open-ended filter; PUT-replace clears + createMany on the same (tenantId, userId) scope.",
    // ─── Land administration (roadmap 2/3) — parcel lease register ───
    ParcelLease:
        'listParcelLeases findMany filters by (tenantId, parcelId, deletedAt) — covered by @@index([tenantId, parcelId]); the endDate/createdAt orderBy runs over a parcel\'s handful of leases (take:100), no separate composite needed. listTenantLeases (Rent page, roadmap 3/3) is the tenant-wide register — filters (tenantId, deletedAt) with an optional parcel.locationId relation filter, orders by endDate/createdAt, take:500 — served by @@index([tenantId, endDate]) (the same index the rent-roll expiry scan uses); the createdAt tiebreak sorts a tenant\'s bounded lease set in memory.',
    // ─── Grain fulfilment — delivery ledger against a contract ───
    GrainDelivery:
        'listContractDeliveries findMany filters by (tenantId, contractId, deletedAt), orders by deliveredAt desc, take:500 — covered by @@index([tenantId, contractId]); a contract fills in a handful of loads so the date sort runs over a tiny set. The rollups do NOT findMany: delivered-to-date is one groupBy([contractId]) over an id set (same index), and the delivery-window sweep groups by contractId across the batch it already scanned.',
    // ─── Rent roll — lease settlement leg ───
    LeasePayment:
        'listLeasePayments findMany filters by (tenantId, leaseId, deletedAt), orders by paidAt/createdAt desc, take:200 — covered by @@index([tenantId, leaseId]); a lease settles a handful of times per season so the date sort runs over a tiny set. The rent-roll aggregation reads payments through a raw-SQL LEFT JOIN grouped by leaseId and filtered on (tenantId, deletedAt, seasonYear) — served by @@index([tenantId, seasonYear]).',
    // ─── RAG (feat/ai-rag) — KnowledgeChunk retrieval store ───
    KnowledgeChunk:
        'retrieve() keyword branch findMany filters by (tenantId OR tenantId IS NULL) + text contains — covered by @@index([tenantId, articleId]) for the tenant predicate; the text match is a substring scan with no useful index (the ranked path is the vector branch, a raw ivfflat $queryRaw not a findMany). Both branches are take-bounded (topK*2). Nullable tenantId GLOBAL catalog.',
    // ─── Agriculture (Feature 1 — spray-prescription map) ───
    Location:
        'listLocations filters by tenantId + status and searches name/description, orders by createdAt — covered by @@index([tenantId, status]) / @@index([tenantId, name]); the paginated path is cursor-bounded.',
    Parcel:
        'Parcel reads are normally scoped to a location (ParcelRepository.listForLocation, [tenantId, locationId]) or to an id set (validIdsForLocation, PK). The one tenant-wide read is listTenantParcelOptions (Rent-page create picker) — filters (tenantId, deletedAt), selects id/name/location, orders by name, take:5000 — narrowed by the tenantId-leading @@index([tenantId, locationId]); the name sort runs in memory over the picker\'s bounded option set (a lightweight id+name projection, not the geometry-bearing row).',
    Item:
        'listItems filters by tenantId + category and searches name — covered by @@index([tenantId, category]) / @@index([tenantId, name]).',
    OperationParcel:
        'OperationParcel is read per-job (taskId + tenantId) — covered by @@index([tenantId, taskId]); status rollups use @@index([tenantId, status]).',
    // ─── Agro-intel (weather obs + data streams + signals) ───
    WeatherObservation:
        'agro-signals + getPlantingGdd findMany by tenantId + locationId + obsDate range, ordered by obsDate — covered exactly by @@unique([tenantId, locationId, obsDate]) (the upsert key) + @@index([tenantId, obsDate]); both reads are take-bounded (64 / 400).',
    DataStream:
        'listDataStreams filters by tenantId (deletedAt:null), orders by createdAt DESC — covered by @@index([tenantId, locationId]) / @@index([tenantId, status]); the per-tenant stream set is small and take:200-bounded. Ingestion looks up a single stream by PK (findUnique).',
    DataStreamReading:
        'listReadings filters by tenantId + dataStreamId, orders by recordedAt DESC — covered exactly by @@index([tenantId, dataStreamId, recordedAt]); take:500-bounded. Writes are createMany only.',
    // AgroSignal's first findMany: loadAgroSignalEvents (compliance-calendar,
    // PR 2 of the calendar roadmap) filters by (tenantId, signalDate range),
    // orders by signalDate asc — covered exactly by @@index([tenantId,
    // signalDate]); take-bounded (perSourceLimit + 1). Previously the model
    // was claimed/updated only via createMany(skipDuplicates) + updateMany
    // on the @@unique([tenantId, locationId, kind, signalDate]) key, so it
    // had no findMany at all.
    AgroSignal:
        'loadAgroSignalEvents findMany filters by (tenantId, signalDate range), orders by signalDate asc — covered by @@index([tenantId, signalDate]); take-bounded (perSourceLimit + 1, see the calendar\'s truncated-response contract).',
    // ─── Inventory ledger (Phase 1) ───
    InventoryLot:
        'listLots filters by tenantId (+ optional itemId), orders by createdAt DESC — covered by @@index([tenantId, itemId]); listLotsPaginated cursor-walks tenantId ordered by (createdAt, id) — covered by the perf-scale @@index([tenantId, createdAt]); getFefoLot filters tenantId+itemId+quantityOnHand>0 ordered by expiresAt — covered by @@index([tenantId, expiresAt]); bounded take.',
    StockTransaction:
        'lotLedger filters by tenantId + lotId ordered by occurredAt DESC — covered by @@index([tenantId, lotId, occurredAt]); lotLedgerPage cursor-walks tenantId+lotId ordered by (createdAt, id) — covered by the perf-scale @@index([tenantId, lotId, createdAt]); the verifyStockChain integrity sweep is an explicit unbounded full-tenant scan (guardrail-allow). findConsumptionParcels / findInputLotsConsumedOnParcel filter tenantId + type (+ lotId set / nested operationParcel) — covered by @@index([tenantId, type, occurredAt]); bounded take:500.',
    LotLink:
        'The traceability walk reads genealogy edges by tenantId + childLotId (listParentLinks, BFS up) and tenantId + parentLotId (listChildLinks, BFS down) — both leading-indexed by @@index([tenantId, parentLotId]) / @@index([tenantId, childLotId]); each level is take:500-bounded.',
    // ─── Field Journal (LogEntry) ───
    LogEntry:
        'listLogEntries filters by tenantId (+ optional type / status / occurredAt range), searches title/notes, orders by occurredAt DESC — covered by @@index([tenantId, type, occurredAt]) + @@index([tenantId, status, occurredAt]); the paginated path is cursor-bounded and the flat path is take:200-bounded.',
    // ─── Knowledge Base (mirrors Policy) ───
    KnowledgeArticle:
        'list filters by tenantId (+ optional status / category), searches title/summary, orders updatedAt DESC — covered by @@index([tenantId, status]) / @@index([tenantId, category]) / @@index([tenantId, updatedAt]); listCategories is a distinct tenantId scan; the unified search matches title/summary (take:dbLimit, mirrors policy search). All take-bounded.',
    KnowledgeArticleVersion:
        'listByArticle filters by tenantId + articleId ordered by versionNumber DESC — covered by @@index([tenantId, articleId]); take:100-bounded.',
    KnowledgeAcknowledgement:
        'listAcknowledgements filters by tenantId + articleVersionId ordered by acknowledgedAt DESC — covered by @@index([tenantId, articleVersionId]); take:500-bounded.',
    // EI-3 — SCIM Groups listed/looked-up by tenantId (+ unique externalId);
    // covered by @@index([tenantId]) + @@unique([tenantId, externalId]); bounded take:200.
    ScimGroup:
        'EI-3 scimListGroups filters by tenantId (take:200); reconcile looks up by [tenantId, memberIds has] — @@index([tenantId]) + @@unique([tenantId, externalId]) suffice.',
    // SP-3 — delta sync lists mappings by [tenantId, provider, connectionId];
    // covered by @@index([tenantId, provider]) + @@index([connectionId]).
    IntegrationSyncMapping:
        'SP-3 delta sync filters by tenantId + provider + connectionId — covered by @@index([tenantId, provider]) + @@index([connectionId]); no curated composite index needed today.',
    // VR-3 — the canvas-rule sync findMany's a single map's nodes/edges,
    // bounded by processMapId. The `@@index([tenantId, processMapId])`
    // covers the (tenantId, processMapId) prefix; the nodeType/edgeKind
    // refinement is an in-memory-small filter over one map's bounded graph.
    ProcessNode:
        'filtered by tenantId + processMapId (one map\'s bounded node set) — covered by @@index([tenantId, processMapId]); nodeType is a small refinement.',
    ProcessEdge:
        'filtered by tenantId + processMapId (one map\'s bounded edge set) — covered by @@index([tenantId, processMapId]); edgeKind is a small refinement.',
    AccessReview:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AccessReviewDecision:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    Audit:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AuditCycle:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AuditLog:
        'append-only audit trail — read tenant-scoped and time-ordered via [tenantId, createdAt]; Layers A/B cover it; no curated composite index needed.',
    AuditPack:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AuditorPackAccess:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    AutomationExecution:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AutomationRule:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    ClauseProgress:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ComplianceSnapshot:
        'time-series snapshot rows — read tenant-scoped and time-ordered; Layers A/B cover it; no curated composite index needed today.',
    ControlAsset:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlEvidenceLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlRequirementLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    FileRecord:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    Finding:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    FrameworkRequirementOrder:
        'ordering side-table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover it; no curated composite index needed.',
    IntegrationConnection:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    IntegrationExecution:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    IntegrationWebhookEvent:
        'append-only webhook log — read tenant-scoped; Layers A/B cover it; no curated composite index needed today.',
    Notification:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    NotificationOutbox:
        'outbox queue — drained tenant-scoped by status; Layers A/B cover it; no curated composite index needed today.',
    Policy:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    PolicyApproval:
        'listPending filters by tenantId + status only (the [tenantId, policyId] / [tenantId, policyVersionId] composites are FK reverse-lookup indexes) — Layers A/B cover its query shapes; no curated composite index needed today.',
    PolicyVersion:
        'fetched per policy via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    ProcessEdgeControl:
        'Epic P2-PR-C reverse-lookup: filtered by (tenantId, controlId) which is the model\'s leading `@@index([tenantId, controlId])`. Result set bounded by the number of edges referencing one control (typically <10) — Layer A already covers it.',
    ProcessMap:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    ProcessMapSnapshot:
        'Epic P5-PR-A version-history list: filtered by (tenantId, processMapId) which is covered by the model\'s leading `@@index([tenantId, processMapId, version])`. Capped at 200 rows in the repo (`take: 200`); no curated composite index needed.',
    ReadinessSnapshot:
        'time-series readiness chart query (Audit S5, 2026-05-24); the model carries [tenantId, frameworkKey, computedAt] composite index for the trend lookup, covered structurally by its own index — no separate LIST_QUERY_INDEXES entry needed.',
    TaskComment:
        'fetched per task via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    TaskWatcher:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    TenantApiKey:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantCustomRole:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantEntraGroupMapping:
        'listed by tenantId only (ordered by priority/createdAt, take 500); @@index([tenantId]) + @@unique([tenantId, aadGroupId]) — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantIdentityProvider:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantInvite:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantMembership:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    UserIdentityLink:
        'fetched per tenant / user via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    Vendor:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessment:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessmentAnswer:
        'fetched per assessment via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessmentTemplate:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessmentTemplateQuestion:
        'fetched per template via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorDocument:
        'fetched per vendor via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorEvidenceBundle:
        'fetched per vendor via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    VendorRelationship:
        'fetched per vendor via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    // ─── Crop Planning (succession planning + plan-vs-actual) ───
    Season:
        'listSeasons filters by tenantId + deletedAt, orders by startDate DESC — covered by @@index([tenantId, startDate]); bounded take:500.',
    CropType:
        'listCropTypes filters by tenantId + deletedAt, orders by name ASC — covered by @@index([tenantId, name]); bounded take:500.',
    CropVariety:
        'listCropVarieties filters by tenantId + deletedAt (+ optional cropTypeId), orders by name ASC — covered by @@index([tenantId, cropTypeId]) + @@index([tenantId, name]); bounded take:500.',
    CropPlan:
        'listCropPlans filters by tenantId + deletedAt (+ optional seasonId / status), orders by createdAt DESC — each filter leading-indexed by @@index([tenantId, seasonId]) / @@index([tenantId, status]); bounded take:500.',
    Planting:
        'listPlantings + getCropPlanProgress filter by tenantId + deletedAt (+ optional cropPlanId / status), order by successionNumber ASC — covered by @@index([tenantId, cropPlanId]) / @@index([tenantId, status]); generatePlantings re-reads PLANNED rows by [tenantId, cropPlanId, status]; bounded take:500.',
    LogPlanting:
        'getCropPlanProgress reads actuals by tenantId + plantingId IN [...] in one batched query — covered by @@index([tenantId, plantingId]); bounded take:500.',
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** All `.ts` files under `src/app-layer`, recursively. */
function listAppLayerFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                out.push(full);
            }
        }
    };
    walk(APP_LAYER_DIR);
    return out;
}

/** True if a `blockIndexes` entry on `model` exactly equals `fields`. */
function hasExactBlockIndex(
    model: SchemaModel,
    fields: readonly string[],
): boolean {
    return model.blockIndexes.some(
        (idx) =>
            idx.length === fields.length &&
            idx.every((f, i) => f === fields[i]),
    );
}

/**
 * Is a foreign-key field adequately indexed for this codebase's query
 * patterns?
 *
 *   - `true` if the FK LEADS some index/uniqueness construct (a bare
 *     `WHERE fk = ?` reverse lookup is then an index scan), OR
 *   - on a tenant-scoped model, `true` if a `[tenantId, fk, ...]`
 *     composite exists: every repository query carries `tenantId`, so
 *     the universal `WHERE tenantId = ? AND fk = ?` lookup is served by
 *     that composite's leftmost prefix.
 *
 * The second clause is essential: the schema's deliberate convention
 * is to index FK columns via tenant-scoped composites, not bare
 * single-column indexes. Without this clause Layer B would flag a
 * correctly-indexed FK as a violation — a guardrail that cries wolf.
 */
function fkAdequatelyIndexed(model: SchemaModel, fk: string): boolean {
    if (leadingIndexedFields(model).has(fk)) return true;
    if (model.scalarFieldNames.includes('tenantId')) {
        const inTenantComposite = (groups: string[][]): boolean =>
            groups.some((g) => g[0] === 'tenantId' && g[1] === fk);
        if (
            inTenantComposite(model.blockIndexes) ||
            inTenantComposite(model.blockUniques)
        ) {
            return true;
        }
    }
    return false;
}

/** Map a Prisma accessor (camelCase) to its PascalCase model name. */
function accessorToModelName(accessor: string): string {
    return accessor.charAt(0).toUpperCase() + accessor.slice(1);
}

/**
 * Scan `src/app-layer` for `.findMany(` calls and return the set of
 * tenant-scoped model names that are list-queried somewhere.
 *
 * `db.task.findMany(...)` → accessor `task` → model `Task`. Accessors
 * that do not resolve to a parsed model (dynamic delegates like
 * `delegate.findMany` / `model.findMany` / `dbAny.findMany`) are
 * dropped — they are generic helpers, not a concrete model.
 */
function scanListQueryModels(): Set<string> {
    const found = new Set<string>();
    const re = /([A-Za-z_][A-Za-z0-9_]*)\.findMany\s*\(/g;
    for (const file of listAppLayerFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const modelName = accessorToModelName(m[1]);
            const model = MODEL_BY_NAME.get(modelName);
            if (!model) continue;
            if (!model.scalarFieldNames.includes('tenantId')) continue;
            found.add(modelName);
        }
    }
    return found;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('schema-index-coverage — parser sanity', () => {
    // Pins the structured parser (`prisma-schema-models.ts`) against
    // known schema facts. If the parser silently breaks, every layer
    // below would pass vacuously — this catches that first.
    it('parses a meaningful number of models', () => {
        expect(MODELS.length).toBeGreaterThan(80);
    });

    it('finds the Task and TaskLink models', () => {
        expect(MODEL_BY_NAME.has('Task')).toBe(true);
        expect(MODEL_BY_NAME.has('TaskLink')).toBe(true);
    });

    it('TaskLink carries @@index([tenantId, entityType, entityId])', () => {
        const taskLink = MODEL_BY_NAME.get('TaskLink');
        expect(taskLink).toBeDefined();
        expect(taskLink?.blockIndexes).toContainEqual([
            'tenantId',
            'entityType',
            'entityId',
        ]);
    });

    it('parses field-level @id and relation FK groups', () => {
        // Fixture model: any tenant-scoped model with a field-level @id
        // and a `tenant Tenant @relation(fields: [tenantId], ...)`. This
        // was Risk until the risk register was removed.
        const control = MODEL_BY_NAME.get('Control');
        expect(control?.fieldIdName).toBe('id');
        expect(control?.relationFkFieldGroups).toContainEqual(['tenantId']);
    });
});

describe('schema-index-coverage — Layer A: tenant-scoped models are tenant-indexed', () => {
    const tenantModels = MODELS.filter((m) =>
        m.scalarFieldNames.includes('tenantId'),
    );

    it('finds a meaningful number of tenant-scoped models (parser sanity)', () => {
        // If the parser broke, this collapses to ~0 and every other
        // assertion below would vacuously pass.
        expect(tenantModels.length).toBeGreaterThan(40);
    });

    for (const model of tenantModels) {
        const exemptReason = TENANT_INDEX_EXEMPT[model.name];
        const title = exemptReason
            ? `${model.name} — tenantId-index exempt (${exemptReason.slice(0, 60)}…)`
            : `${model.name} — tenantId leads an index/unique/id`;

        it(title, () => {
            if (exemptReason) {
                // Exempt: just record that the entry is intentional.
                expect(exemptReason.length).toBeGreaterThan(20);
                return;
            }
            // `leadingIndexedFields` recognises a tenantId-leading
            // `@@index`/`@@unique`/`@@id` AND a field-level `@id` /
            // `@unique` declared on `tenantId` itself.
            const ok = leadingIndexedFields(model).has('tenantId');
            if (!ok) {
                throw new Error(
                    `Model ${model.name} has a tenantId field but no ` +
                        `@@index / @@unique / @@id with tenantId as the FIRST ` +
                        `element. Every per-tenant query on this model is a ` +
                        `sequential scan.\n\n` +
                        `Fix: add  @@index([tenantId])  (or a composite that ` +
                        `LEADS with tenantId) to model ${model.name}.\n` +
                        `If this is a genuine exception, add it to ` +
                        `TENANT_INDEX_EXEMPT with a written reason.`,
                );
            }
            expect(ok).toBe(true);
        });
    }
});

describe('schema-index-coverage — Layer B: foreign-key fields are leading-indexed', () => {
    interface FkViolation {
        key: string;
        model: string;
        field: string;
        group: string[];
    }

    const violations: FkViolation[] = [];
    for (const model of MODELS) {
        for (const group of model.relationFkFieldGroups) {
            const first = group[0];
            if (first === 'tenantId') continue; // Layer A owns tenantId.
            if (fkAdequatelyIndexed(model, first)) continue;
            violations.push({
                key: `${model.name}.${first}`,
                model: model.name,
                field: first,
                group,
            });
        }
    }

    it('finds foreign-key relations to check (parser sanity)', () => {
        // FK groups should number well into the hundreds across the
        // schema. A near-zero count means the relation parser broke.
        const totalFkGroups = MODELS.reduce(
            (n, m) => n + m.relationFkFieldGroups.length,
            0,
        );
        expect(totalFkGroups).toBeGreaterThan(100);
    });

    it('every foreign-key field leads an index OR is in FK_INDEX_EXEMPT', () => {
        const novel = violations.filter((v) => !(v.key in FK_INDEX_EXEMPT));
        if (novel.length > 0) {
            const lines = [
                `Found ${novel.length} foreign-key field(s) that do not LEAD ` +
                    `any index/uniqueness construct and are not in ` +
                    `FK_INDEX_EXEMPT:`,
                '',
                ...novel.map(
                    (v) =>
                        `  ${v.key}  (relation fields: [${v.group.join(', ')}])`,
                ),
                '',
                'Each such FK makes the reverse lookup ("rows pointing at ',
                'parent X") a sequential scan.',
                '',
                'Fix one of:',
                `  1. Add  @@index([${'<fkField>'}])  — or a composite that`,
                '     LEADS with the FK field — to the model.',
                '  2. If the reverse lookup is genuinely never a hot path,',
                '     add an FK_INDEX_EXEMPT entry keyed "Model.field" with',
                '     a concise, honest reason (see the reason constants).',
            ];
            throw new Error(lines.join('\n'));
        }
        expect(novel.length).toBe(0);
    });

    it('FK_INDEX_EXEMPT has no stale entries (every exemption still applies)', () => {
        // If an FK gets a real index, its violation disappears — its
        // exempt entry then quietly weakens nothing, but it IS dead
        // weight that hides the win. Flag it so the entry is removed.
        const liveKeys = new Set(violations.map((v) => v.key));
        const stale = Object.keys(FK_INDEX_EXEMPT).filter(
            (k) => !liveKeys.has(k),
        );
        if (stale.length > 0) {
            throw new Error(
                `FK_INDEX_EXEMPT has ${stale.length} stale entr(y/ies) — the ` +
                    `FK now leads an index (or the field/relation was ` +
                    `renamed). Remove:\n` +
                    stale.map((k) => `  ${k}`).join('\n'),
            );
        }
        expect(stale.length).toBe(0);
    });
});

describe('schema-index-coverage — Layer C: curated composite-index registry', () => {
    for (const idx of LIST_QUERY_INDEXES) {
        it(`${idx.model} has @@index([${idx.fields.join(', ')}]) — ${idx.justification}`, () => {
            const model = MODEL_BY_NAME.get(idx.model);
            expect(model).toBeDefined();
            if (!model) return;
            const ok = hasExactBlockIndex(model, idx.fields);
            if (!ok) {
                throw new Error(
                    `Model ${idx.model} is missing the curated composite ` +
                        `index @@index([${idx.fields.join(', ')}]).\n` +
                        `Justification: ${idx.justification}\n\n` +
                        `This index backs a real list filter/sort path. ` +
                        `Removing it regresses list latency. If the ` +
                        `corresponding filter was removed, drop this ` +
                        `LIST_QUERY_INDEXES entry in the same diff.`,
                );
            }
            expect(ok).toBe(true);
        });
    }
});

describe('schema-index-coverage — Layer C-completeness: every list-queried model is triaged', () => {
    const listQueryModels = scanListQueryModels();

    it('finds tenant-scoped models that are findMany-queried (scan sanity)', () => {
        // A near-zero count means the findMany scan broke.
        expect(listQueryModels.size).toBeGreaterThan(20);
    });

    it('every list-queried tenant model is in LIST_QUERY_INDEXES or LIST_MODELS_TENANT_INDEX_SUFFICIENT', () => {
        const curated = new Set(LIST_QUERY_INDEXES.map((i) => i.model));
        const untriaged = [...listQueryModels].filter(
            (m) =>
                !curated.has(m) &&
                !(m in LIST_MODELS_TENANT_INDEX_SUFFICIENT),
        );
        if (untriaged.length > 0) {
            throw new Error(
                `Found ${untriaged.length} tenant-scoped model(s) that are ` +
                    `findMany-queried in src/app-layer but are in NEITHER ` +
                    `LIST_QUERY_INDEXES nor ` +
                    `LIST_MODELS_TENANT_INDEX_SUFFICIENT:\n\n` +
                    untriaged.map((m) => `  ${m}`).join('\n') +
                    `\n\nTriage each:\n` +
                    `  - If its list query filters/sorts on a non-leading ` +
                    `column, add an @@index AND a LIST_QUERY_INDEXES entry.\n` +
                    `  - If it filters only by tenantId + a leading-indexed ` +
                    `FK/status column, add a ` +
                    `LIST_MODELS_TENANT_INDEX_SUFFICIENT entry with a reason.`,
            );
        }
        expect(untriaged.length).toBe(0);
    });

    it('LIST_MODELS_TENANT_INDEX_SUFFICIENT has no stale entries', () => {
        // An entry whose model is no longer findMany'd anywhere is
        // dead weight — remove it.
        const stale = Object.keys(LIST_MODELS_TENANT_INDEX_SUFFICIENT).filter(
            (m) => !listQueryModels.has(m),
        );
        if (stale.length > 0) {
            throw new Error(
                `LIST_MODELS_TENANT_INDEX_SUFFICIENT has ${stale.length} ` +
                    `stale entr(y/ies) — the model is no longer ` +
                    `findMany-queried in src/app-layer (removed or renamed). ` +
                    `Remove:\n` +
                    stale.map((m) => `  ${m}`).join('\n'),
            );
        }
        expect(stale.length).toBe(0);
    });
});

describe('schema-index-coverage — registry integrity', () => {
    it('every model named in any map resolves to a real parsed model', () => {
        const referenced = new Set<string>([
            ...Object.keys(TENANT_INDEX_EXEMPT),
            ...Object.keys(FK_INDEX_EXEMPT).map((k) => k.split('.')[0]),
            ...LIST_QUERY_INDEXES.map((i) => i.model),
            ...Object.keys(LIST_MODELS_TENANT_INDEX_SUFFICIENT),
        ]);
        const unknown = [...referenced].filter((m) => !MODEL_BY_NAME.has(m));
        if (unknown.length > 0) {
            throw new Error(
                `These model names appear in a registry/exempt map but do ` +
                    `NOT resolve to a real model in the Prisma schema ` +
                    `(typo or stale after a rename):\n` +
                    unknown.map((m) => `  ${m}`).join('\n'),
            );
        }
        expect(unknown.length).toBe(0);
    });

    it('every FK_INDEX_EXEMPT entry names a real field on its model', () => {
        const bad: string[] = [];
        for (const key of Object.keys(FK_INDEX_EXEMPT)) {
            const [modelName, fieldName] = key.split('.');
            const model = MODEL_BY_NAME.get(modelName);
            if (!model) continue; // caught by the previous test.
            if (!model.hasField(fieldName)) bad.push(key);
        }
        if (bad.length > 0) {
            throw new Error(
                `These FK_INDEX_EXEMPT keys name a field that does not ` +
                    `exist on the model (renamed or removed):\n` +
                    bad.map((k) => `  ${k}`).join('\n'),
            );
        }
        expect(bad.length).toBe(0);
    });

    it('every exempt-map reason is a non-trivial string', () => {
        const allReasons = [
            ...Object.values(TENANT_INDEX_EXEMPT),
            ...Object.values(FK_INDEX_EXEMPT),
            ...Object.values(LIST_MODELS_TENANT_INDEX_SUFFICIENT),
            ...LIST_QUERY_INDEXES.map((i) => i.justification),
        ];
        for (const reason of allReasons) {
            expect(typeof reason).toBe('string');
            expect(reason.trim().length).toBeGreaterThan(10);
        }
    });
});
