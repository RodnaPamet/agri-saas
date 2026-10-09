/**
 * Zod schemas for all API request bodies.
 * All schemas use .strip() to remove unknown fields.
 *
 * Naming convention:
 *   Create<Entity>Schema — for POST (required fields)
 *   Update<Entity>Schema — for PUT (partial or full updates)
 *
 * GAP-10 — these schemas are also the single source of truth for the
 * generated OpenAPI spec. The `.openapi('Name', { description })` calls
 * below register each schema as a named component. Component naming
 * convention is documented in `src/lib/openapi/registry.ts`. Add
 * `.openapi(...)` to every NEW request schema when you add it.
 */
import { z } from '@/lib/openapi/zod';
import { httpsUrl } from '@/lib/schemas/url';
import { normaliseTechnique } from '@/lib/agro/application-techniques';

export const EmptyBodySchema = z.object({}).strip().openapi('EmptyBody', {
    description: 'Empty request body. Used by mutation endpoints whose semantics live entirely in the URL (e.g. POST /restore on a soft-deleted resource).',
});

// ─── Assets ───

export const CreateAssetSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    type: z.string().min(1, 'Type is required'),
    status: z.enum(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED']).optional(),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().nullable(),
    owner: z.string().optional(),                     // Free-text keeper (the person physically holding the asset)
    ownerUserId: z.string().optional().nullable(),    // Real user reference — "Assigned to" (people picker)
    externalRef: z.string().optional().nullable(),    // External system / registry reference
    location: z.string().optional(),
    locationId: z.string().min(1).optional().nullable(), // Structured location (Location.id)
    usefulLifeYears: z.coerce.number().int().min(1).max(100).optional().nullable(),
    manufacturer: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
    serialNumber: z.string().optional().nullable(),
    year: z.coerce.number().int().min(1900).max(2100).optional().nullable(),
    purchaseDate: z.string().optional().nullable(),
    purchaseCost: z.coerce.number().min(0).optional().nullable(),
}).strip().openapi('AssetCreateRequest', {
    description: 'Payload for creating a tenant agricultural asset (machine, building, equipment). Manufacturer / model / serial / location are free-text; criticality is LOW/MEDIUM/HIGH.',
});

export const UpdateAssetSchema = z.object({
    name: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    status: z.enum(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED']).optional(),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().nullable(),
    owner: z.string().optional(),                     // Free-text keeper
    ownerUserId: z.string().optional().nullable(),    // Real user reference — "Assigned to"
    externalRef: z.string().optional().nullable(),    // External system / registry reference
    location: z.string().optional(),
    locationId: z.string().min(1).optional().nullable(), // Structured location (Location.id)
    usefulLifeYears: z.coerce.number().int().min(1).max(100).optional().nullable(),
    manufacturer: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
    serialNumber: z.string().optional().nullable(),
    year: z.coerce.number().int().min(1900).max(2100).optional().nullable(),
    purchaseDate: z.string().optional().nullable(),
    purchaseCost: z.coerce.number().min(0).optional().nullable(),
}).strip().openapi('AssetUpdateRequest', {
    description: 'Partial update for an agricultural asset. Every field is optional; only provided fields are persisted.',
});


// ─── Practices ───

export const CreatePracticeSchema = z.object({
    code: z.string().optional().nullable(),
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional().nullable(),
    intent: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'IMPLEMENTED', 'NEEDS_REVIEW']).optional().default('NOT_STARTED'),
    frequency: z.enum(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    evidenceSource: z.enum(['MANUAL', 'INTEGRATION']).optional().nullable(),
    automationKey: z.string().optional().nullable(),
    mitigationType: z.enum(['PREVENTIVE', 'DETECTIVE', 'DETERRENT', 'CORRECTIVE', 'COMPENSATING']).optional().nullable(),
    isCustom: z.boolean().optional().default(true),
}).strip().openapi('PracticeCreateRequest', {
    /**
     * DEPRECATED, pending removal (#1386).
     *
     * There is no practice route — `find src/app/api -ipath '*practice*'`
     * returns nothing — and no path `$ref`s this component. It is published
     * only because `openapi-build` registers components by walking the
     * `@/lib/schemas` namespace, so the export IS the registration.
     *
     * Deprecated rather than deleted because `docs/api-compatibility.md`
     * classes a removed schema as breaking: a generated client emits a type
     * per component whether a path references it or not, so deletion can fail
     * a client's BUILD even though no endpoint changes and the server sends
     * exactly what it sent before. `deprecated` is not one of the six classes
     * `scripts/openapi-breaking.ts` scores, so marking it is additive.
     *
     * Delete this schema, and the `deprecated` flag with it, once a client
     * build has shipped against a spec carrying this marker.
     */
    deprecated: true,
    description: 'Payload for creating a practice. Status defaults to NOT_STARTED. `code` carries the framework reference where one applies (e.g. ISO 27001:2022 A.5.1) and is minted as `CTL-N` for custom practices. Custom practices (isCustom=true) are tenant-specific.',
});











// ─── Evidence ───

// Shared internal base — no .openapi() metadata, so derived schemas
// (e.g. CreateEvidenceFormSchema) don't inherit a colliding component
// id. zod 4's metadata system propagates `.openapi(id)` through
// `.extend()` whereas zod 3 dropped it; building both schemas from
// this base prevents a duplicate-component-id collision in the
// OpenAPI document.
const _CreateEvidenceBase = z.object({
    type: z.enum(['TEXT', 'FILE', 'LINK', 'SCREENSHOT']).optional().default('TEXT'),
    title: z.string().min(1, 'Title is required'),
    content: z.string().optional(),
    fileName: z.string().optional().nullable(),
    fileSize: z.coerce.number().optional().nullable(),
    category: z.string().optional().nullable(),
    // B8 follow-up — free-text folder label, capped at 120 chars to
    // match VendorDocument.folder. Sanitised + null-coerced at the
    // usecase boundary.
    folder: z.string().max(120).optional().nullable(),
    owner: z.string().optional().nullable(),          // Legacy free-text
    ownerUserId: z.string().optional().nullable(),    // Real user reference (preferred)
    reviewCycle: z.string().optional().nullable(),
    nextReviewDate: z.string().optional().nullable(),
});

export const CreateEvidenceSchema = _CreateEvidenceBase.strip().openapi('EvidenceCreateRequest', {
    description: 'Create an evidence record. type=FILE expects a paired multipart upload via /evidence/uploads; type=TEXT/LINK can use this JSON body directly. content is encrypted at rest for TEXT type.',
});


export const UpdateEvidenceSchema = z.object({
    title: z.string().min(1).optional(),
    // The free-text body. The UI LABELS this "description", and the edit modal
    // used to send it under that name — which `.strip()` silently discarded,
    // so editing an evidence description saved nothing and reported success.
    // The wire name matches the column; the user-facing label is a translation
    // string and can say whatever reads best.
    content: z.string().optional(),
    category: z.string().optional().nullable(),
    // B8 follow-up — folder is editable post-create so a tenant
    // can re-organise their evidence library after the fact.
    folder: z.string().max(120).optional().nullable(),
    owner: z.string().optional().nullable(),          // Legacy free-text
    ownerUserId: z.string().optional().nullable(),    // Real user reference (preferred)
    reviewCycle: z.string().optional().nullable(),
    nextReviewDate: z.string().optional().nullable(),
}).strip().openapi('EvidenceUpdateRequest', {
    description: 'Partial update for an evidence record (metadata only — file content is immutable post-upload).',
});

export const EvidenceReviewSchema = z.object({
    action: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']),
    comment: z.string().optional().nullable(),
}).strip().openapi('EvidenceReviewRequest', {
    description: 'Lifecycle transition for an evidence record. SUBMITTED is the request-for-review state; APPROVED/REJECTED are reviewer decisions.',
});

// ─── Findings ───


// ─── Audits ───

const ChecklistUpdateSchema = z.object({
    id: z.string().min(1),
    result: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
}).strip();


// ─── Tasks (Unified Work Items) ───

export const CreateTaskSchema = z.object({
    title: z.string().min(1).max(500),
    // GRC teardown phase 2 (operator decision A6): AUDIT_FINDING /
    // PRACTICE_GAP / INCIDENT removed. The WorkItemType Prisma enum keeps
    // the values until phase 3 — dropping an enum value needs a migration
    // plus a deploy/rollback/*.down.sql — but nothing can create one.
    type: z.enum(['IMPROVEMENT', 'TASK']).optional().default('TASK'),
    description: z.string().max(10000).nullable().optional(),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    source: z.enum(['MANUAL', 'TEMPLATE', 'POLICY_REVIEW', 'AUDIT', 'INTEGRATION']).optional(),
    dueAt: z.string().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    metadataJson: z.any().optional(),
}).strip().openapi('TaskCreateRequest', {
    description: 'Create a task (unified work-item type covering improvements and ad-hoc tasks). The type discriminator gates which UI surfaces this work item appears in.',
});

export const UpdateTaskSchema = z.object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).nullable().optional(),
    type: z.enum(['TASK', 'IMPROVEMENT']).optional(),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    dueAt: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    metadataJson: z.any().optional(),
}).strip().openapi('TaskUpdateRequest', {
    description: 'Partial update for a task. Status changes and assignment go through their own focused endpoints.',
});

export const SetTaskStatusSchema = z.object({
    /**
     * Seven of `WorkItemStatus`'s eight members. `PENDING_REVIEW` is
     * deliberately absent and was silently absent until #1391: a client that
     * READ `PENDING_REVIEW` off a task and tried to set it back got a 400 with
     * nothing in the spec to explain why.
     *
     * It is absent because nothing sets it directly. A FIELD_OPERATION whose
     * parcels are all marked DONE lands there on its own, and a reviewer leaves
     * it through the field-operation review endpoint — approve to RESOLVED, or
     * request changes to IN_PROGRESS. Accepting it here would let a client skip
     * the gate the status exists to impose.
     *
     * So the asymmetry is the design: `PENDING_REVIEW` is receivable and not
     * settable. The dashboard's task schema declares it for that reason and
     * says so.
     */
    status: z.enum(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    resolution: z.string().max(5000).nullable().optional(),
}).strip().openapi('TaskSetStatusRequest', {
    description: 'Lifecycle transition for a task. resolution is required (by convention) when moving to RESOLVED/CLOSED to provide context for the audit trail.',
});

export const AssignTaskSchema = z.object({
    assigneeUserId: z.string().nullable(),
}).strip().openapi('TaskAssignRequest', {
    description: 'Reassign or unassign a task. Pass null to clear the assignee.',
});

export const LinkTaskEvidenceSchema = z.object({
    url: httpsUrl(),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('TaskEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on a task. File uploads use the multipart /evidence/uploads endpoint with a taskId.',
});

export const LinkAssetEvidenceSchema = z.object({
    url: httpsUrl(),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('AssetEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on an asset. File uploads use the multipart /evidence/uploads endpoint with an assetId.',
});

export const AddTaskLinkSchema = z.object({
    // Mirrors the Prisma `TaskLinkEntityType` enum, minus the GRC members
    // deleted in the teardown (PRACTICE / FRAMEWORK_REQUIREMENT / POLICY /
    // AUDIT_PACK / VENDOR).
    //
    // The four agri members are ADDED here, not merely kept: they exist in
    // Prisma (enums.prisma) and `FarmTaskDetailClient` has been offering
    // LOCATION / PARCEL / EQUIPMENT in its link picker — DEFAULTING to
    // LOCATION — while this zod enum omitted all four. `withValidatedBody`
    // calls `schema.parse`, so the farm-task manual-link form has been
    // returning 400 on its own default selection. It went unnoticed because
    // every AUTOMATIC link writer (farm-task.ts, field-operation.ts,
    // crop-planning.ts) calls addTaskLink / TaskLinkRepository.link directly
    // and never crosses this boundary.
    entityType: z.enum(['ASSET', 'EVIDENCE', 'FILE', 'LOCATION', 'PARCEL', 'EQUIPMENT', 'PLANTING']),
    entityId: z.string().min(1),
    relation: z.enum(['RELATES_TO', 'EVIDENCE_FOR', 'BLOCKED_BY', 'CAUSED_BY', 'MITIGATED_BY']).optional(),
}).strip().openapi('TaskLinkAddRequest', {
    description: 'Link a task to another domain entity. The relation field captures semantic intent for downstream traceability views.',
});

export const AddTaskCommentSchema = z.object({
    body: z.string().min(1).max(10000),
}).strip().openapi('TaskCommentAddRequest', {
    description: 'Append a comment to a task. body is sanitized server-side (rich-text allowlist) and encrypted at rest (Epic B field-encryption manifest).',
});

// ─── Task Bulk Actions ───

export const BulkTaskAssignSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
    assigneeUserId: z.string().nullable(),
}).strip();

export const BulkTaskStatusSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    resolution: z.string().max(5000).optional(),
}).strip();

export const BulkTaskDueDateSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
    dueAt: z.string().nullable(),
}).strip();

// ─── Issue Compatibility Aliases (deprecated — use Task schemas) ───

/** @deprecated Use CreateTaskSchema */ export const CreateIssueSchema = CreateTaskSchema;
/** @deprecated Use UpdateTaskSchema */ export const UpdateIssueSchema = UpdateTaskSchema;
/** @deprecated Use SetTaskStatusSchema */ export const SetIssueStatusSchema = SetTaskStatusSchema;
/** @deprecated Use AssignTaskSchema */ export const AssignIssueSchema = AssignTaskSchema;
/** @deprecated Use AddTaskLinkSchema */ export const AddIssueLinkSchema = AddTaskLinkSchema;
/** @deprecated Use AddTaskCommentSchema */ export const AddIssueCommentSchema = AddTaskCommentSchema;
/** @deprecated Use BulkTaskAssignSchema */ export const BulkAssignSchema = BulkTaskAssignSchema;
/** @deprecated Use BulkTaskStatusSchema */ export const BulkStatusSchema = BulkTaskStatusSchema;
/** @deprecated Use BulkTaskDueDateSchema */ export const BulkDueDateSchema = BulkTaskDueDateSchema;

// ─── Clauses ───


// ─── Auth ───

/**
 * `POST /api/auth/register/start` — registration v2 step 1 (P3.5b).
 *
 * ## Why this schema exists at all
 *
 * The route parsed its body with six hand-rolled `typeof` checks, which worked
 * and was invisible to the HIBP guardrail (#1378): the structural scan looks
 * for a password-shaped ZOD field, so the product's only signup route scored
 * zero matches and sat in neither half of the guard. A future edit removing
 * `checkPasswordAgainstHIBP` from it would have failed nothing.
 *
 * ## Every field the handler reads MUST be declared here
 *
 * The object is `.strip()`ed, so an undeclared field is silently dropped before
 * the handler sees it — which for `acceptedTerms` would mean every signup
 * refused as `terms_not_accepted`, a total outage that looks like a client bug.
 * That trap is already recorded on `turnstileToken` below; it applies to all
 * six.
 *
 * ## The constraints are deliberately LOOSE, and that is the whole design
 *
 * Each field below is validated only for SHAPE. Every semantic rule stays in
 * the handler, because each one answers with its own error code and a Zod
 * failure collapses them all into `invalid_request`:
 *
 *   - `password` is `min(1)`, NOT `min(8)` — `validatePasswordPolicy` returns a
 *     distinct `too_short`, and a client needs to tell "too short" from
 *     "malformed request";
 *   - `email` is not `.email()` — the route answers an identical 200 for every
 *     address to stay enumeration-safe, and a format refusal is a different
 *     statement from that uniform answer;
 *   - `acceptedTerms` and `termsVersion` are `unknown` — they carry
 *     `terms_not_accepted` and `terms_version_stale` (the latter with
 *     `currentVersion`, which is how a client knows to reload rather than
 *     retry). Declaring `acceptedTerms: z.literal(true)` would turn a missing
 *     acceptance into `invalid_request` and lose the distinction the consent
 *     gate exists to make.
 *
 * So this schema buys guard VISIBILITY and one parse in place of six casts. It
 * deliberately does not buy stricter validation, and tightening any field here
 * silently changes a response code a client routes on.
 */
export const AuthRegisterStartSchema = z
    .object({
        email: z.string().min(1).max(320),
        password: z.string().min(1),
        name: z.string().min(1).max(200),
        /**
         * Cloudflare Turnstile token (P3.5c).
         *
         * OPTIONAL in the schema and REQUIRED at runtime whenever
         * `TURNSTILE_SECRET_KEY` is set — the two are not in conflict. A
         * deployment with no secret renders no widget and has no token to
         * send, so a required field would break signup for that configuration.
         * Enforcement belongs where the secret is visible: `verifyTurnstile`
         * refuses a missing token once configured rather than treating absence
         * as a skip.
         *
         * It must be declared at all because the object is `.strip()`ed — an
         * undeclared field is dropped before the handler sees it, which would
         * look exactly like a client bug.
         */
        turnstileToken: z.string().max(2048).optional(),
        /** Checked for IDENTITY with `true` in the handler — see the docblock. */
        acceptedTerms: z.unknown().optional(),
        /** Compared for equality with the served version in the handler. */
        termsVersion: z.unknown().optional(),
    })
    .strip()
    .openapi('AuthRegisterStartRequest', {
        description:
            'Registration step 1: creates an UNVERIFIED user and emails a 6-digit code. Every address gets an identical 200, so nothing here reveals whether an account exists. Field constraints are shape-only — the password policy, the HIBP breach check, the Turnstile screen and the consent/version checks all run in the handler and answer with their own error codes.',
    });

export const AuthRegisterSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    orgName: z.string().min(1),
    /**
     * Cloudflare Turnstile token (P3.5c).
     *
     * OPTIONAL in the schema and REQUIRED at runtime whenever
     * `TURNSTILE_SECRET_KEY` is set — the two are not in conflict. The field
     * has to be optional because a deployment with no secret renders no widget
     * and has no token to send, and a required field would break signup for
     * exactly the configuration that is live today. Enforcement therefore
     * belongs where the secret is visible: `verifyTurnstile` refuses a missing
     * token once configured, rather than treating absence as a skip.
     *
     * It must be declared here at all because the object is `.strip()`ed, so
     * an undeclared field would be silently dropped before the handler saw it
     * — a token sent correctly by a client and discarded by the schema, which
     * would look exactly like a client bug.
     */
    turnstileToken: z.string().max(2048).optional(),
}).strip().openapi('AuthRegisterRequest', {
    /**
     * DEPRECATED, pending removal (#1386).
     *
     * `POST /api/auth/register` was retired in #1379; this schema outlived the
     * route it described. The live two-step flow is `AuthRegisterStartSchema`
     * → `AuthRegisterStartRequest`.
     *
     * Same reasoning as `PracticeCreateRequest` above for deprecating rather
     * than deleting, and the same removal condition.
     */
    deprecated: true,
    description: 'Self-service signup payload (gated by AUTH_TEST_MODE in non-prod). The password is checked against HIBP via k-anonymity before persistence; emailVerification is initiated server-side. `turnstileToken` is required whenever the deployment has a Turnstile secret configured.',
});


// ─── Evidence Bundles ───

export const CreateBundleSchema = z.object({
    name: z.string().min(1).max(200),
}).strip();

export const AddBundleItemSchema = z.object({
    entityType: z.enum(['FILE', 'EVIDENCE', 'INTEGRATION']),
    entityId: z.string().min(1),
    label: z.string().max(500).optional(),
}).strip();

// ─── Vendor Management ───







// ─── Practice Test Schemas ───

// ─── Epic G-3 — Vendor Assessment Template Authoring ──────────────
//
// Per-answerType cross-field validation (e.g. SCALE requires
// scaleConfigJson, SINGLE_SELECT requires optionsJson) is enforced
// at the usecase boundary so the error message can name the
// answer type rather than report a generic "missing field".





// ─── Agriculture: Locations (Feature 1 — spray-prescription map) ───

export const CreateLocationSchema = z.object({
    name: z.string().min(1, 'Name is required').max(255),
    description: z.string().max(10000).nullable().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    ownerUserId: z.string().optional().nullable(),
}).strip().openapi('LocationCreateRequest', {
    description: 'Create a Location (a farm/field block). Parcels are populated by importing a spatial file (shapefile/KML/GeoJSON).',
});

export const UpdateLocationSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(10000).nullable().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    ownerUserId: z.string().optional().nullable(),
}).strip().openapi('LocationUpdateRequest', {
    description: 'Partial update for a Location. Only provided fields are persisted.',
});

// ─── Agriculture: Field Operations (spray jobs) ───

export const CreateFieldOperationSchema = z.object({
    title: z.string().min(1).max(255).optional(),
    operationType: z.enum(['SPRAY', 'FERTILIZE', 'SEED', 'OTHER']).optional(),
    assigneeUserId: z.string().min(1, 'An operator must be assigned'),
    parcelIds: z.array(z.string().min(1)).min(1, 'Select at least one parcel'),
    // A field operation applies EXACTLY ONE input — a product OR a fertilizer,
    // never both and never neither (#3, the exclusive on-screen selector).
    // Each kind's fields are individually optional; the superRefine below
    // enforces the XOR + that the chosen kind's dose + unit are present.
    productItemId: z.string().min(1).optional(),
    doseValue: z.coerce.number().positive('Dose must be greater than zero').optional(),
    doseUnitId: z.string().min(1).optional(),
    fertilizerItemId: z.string().min(1).optional(),
    fertilizerDoseValue: z.coerce.number().positive('Fertilizer dose must be greater than zero').optional(),
    fertilizerDoseUnitId: z.string().min(1).optional(),
    // Optional water-carrier rate (per-decare) for the spray tank — only
    // meaningful for a product spray. Persisted on the line so the per-parcel
    // water total (rate × parcel dca) can be recomputed wherever the job shows.
    waterRateValue: z.coerce.number().positive('Water rate must be greater than zero').nullable().optional(),
    waterRateUnitId: z.string().min(1).nullable().optional(),
    targetNote: z.string().max(2000).nullable().optional(),
    dueAt: z.string().nullable().optional(),
    // БАБХ farm-record — "Техника за приложение" (one rig per job).
    // Normalised on write so the column cannot accumulate `Dron` beside
    // `dron` again — it did, twice, in two casings, on the legally-filed
    // register. `undefined` is preserved deliberately: the usecase treats it
    // as "leave the field alone", so collapsing it to null here would clear
    // the technique on every unrelated update.
    applicationTechnique: z
        .string()
        .max(255)
        .nullable()
        .optional()
        .transform((v) => (v === undefined ? undefined : normaliseTechnique(v))),
}).strip().superRefine((val, ctx) => {
    const hasProduct = !!val.productItemId;
    const hasFertilizer = !!val.fertilizerItemId;
    if (hasProduct === hasFertilizer) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['productItemId'],
            message: 'Choose exactly one input — a product OR a fertilizer.',
        });
        return;
    }
    if (hasProduct && (val.doseValue == null || !val.doseUnitId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['doseValue'], message: 'A product dose and unit are required.' });
    }
    if (hasFertilizer && (val.fertilizerDoseValue == null || !val.fertilizerDoseUnitId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fertilizerDoseValue'], message: 'A fertilizer dose and unit are required.' });
    }
}).openapi('FieldOperationCreateRequest', {
    description: 'Create a spray/field-operation job over selected parcels of a location, assigned to an operator. Applies exactly one input — a product OR a fertilizer — writing one FIELD_OPERATION Task plus one OperationParcel line per parcel.',
});

export const UpdateOperationParcelSchema = z.object({
    status: z.enum(['PENDING', 'DONE', 'SKIPPED']),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('OperationParcelUpdateRequest', {
    description: 'Operator updates one per-parcel prescription line. The job auto-resolves when every line is DONE or SKIPPED.',
});

// ─── Agriculture: Field Journal (LogEntry + quantities/links/photos) ───

const LOG_ENTRY_TYPE_VALUES = [
    'ACTIVITY',
    'OBSERVATION',
    'INPUT_APPLICATION',
    'SEEDING',
    'TRANSPLANTING',
    'HARVEST',
    'IRRIGATION',
    'MAINTENANCE',
    'LAB_TEST',
    'GRAZING',
] as const;

const QUANTITY_MEASURE_VALUES = [
    'COUNT',
    'WEIGHT',
    'VOLUME',
    'AREA',
    'LENGTH',
    'RATE',
    'OTHER',
] as const;

/** One measure+value+unit line on a LogEntry (farmOS Quantity). */
const LogQuantitySchema = z.object({
    measure: z.enum(QUANTITY_MEASURE_VALUES),
    value: z.coerce.number().finite(),
    unitId: z.string().min(1, 'A unit is required'),
    label: z.string().max(255).nullable().optional(),
}).strip();

/** One plan-vs-actual link on a LogEntry — the Planting + lifecycle
 *  stage this entry realises. Mirrors LogLocation/LogEquipment: each
 *  becomes a LogPlanting row so a sow/transplant/harvest journal entry
 *  records the ACTUAL date against the planned Planting (PLANNING module,
 *  server-validated per-tenant). */
const LogPlantingLinkSchema = z.object({
    plantingId: z.string().min(1, 'A planting is required'),
    stage: z.enum(['SOW', 'TRANSPLANT', 'HARVEST']),
}).strip();

/** Optional output-lot payload on a HARVEST entry — mints a HARVEST_IN
 *  inventory lot + DERIVATION genealogy (INVENTORY-module gated
 *  server-side; silently no-ops when inventory is off). */
const HarvestLotPayloadSchema = z.object({
    itemId: z.string().min(1, 'A harvested item is required'),
    quantity: z.coerce.number().positive('Harvest quantity must be positive'),
    lotCode: z.string().max(120).optional().nullable(),
    locationId: z.string().optional().nullable(),
    expiresAt: z.string().optional().nullable(),
    parcelId: z.string().optional().nullable(),
    sourceLotIds: z.array(z.string().min(1)).max(100).optional(),
    costAmount: z.coerce.number().nonnegative().optional().nullable(),
    costCurrency: z.string().max(8).optional().nullable(),
    /**
     * Also record this harvest as PRODUCTION — a YieldRecord linked to the
     * entry, so the yield figure and the stock come from one farmer action
     * instead of two unreconciled ones.
     *
     * Opt-in by design: the server refuses to invent a tonnage it cannot
     * derive (the quantity's unit must be a mass), and the UI only offers
     * the checkbox when it is derivable. Absent/false leaves the previous
     * behaviour exactly as it was.
     */
    recordYield: z.coerce.boolean().optional(),
}).strip();

export const CreateLogEntrySchema = z.object({
    type: z.enum(LOG_ENTRY_TYPE_VALUES),
    status: z.enum(['PLANNED', 'DONE']).optional(),
    occurredAt: z.string().optional().nullable(),
    title: z.string().min(1, 'Title is required').max(500),
    notes: z.string().max(20000).optional().nullable(),
    quantities: z.array(LogQuantitySchema).max(50).optional(),
    locationIds: z.array(z.string().min(1)).max(100).optional(),
    equipmentIds: z.array(z.string().min(1)).max(100).optional(),
    operationParcelId: z.string().optional().nullable(),
    costAmount: z.coerce.number().nonnegative().optional().nullable(),
    costCurrency: z.string().max(8).optional().nullable(),
    harvest: HarvestLotPayloadSchema.optional().nullable(),
    plantingLinks: z.array(LogPlantingLinkSchema).max(100).optional(),
}).strip().openapi('LogEntryCreateRequest', {
    description: 'Create a field-journal entry (LogEntry). title is sanitized as plain text; notes is sanitized as rich-text HTML (TipTap). quantities carry the farmOS measure+value+unit lines (an INPUT_APPLICATION entry records the applied amount); locationIds / equipmentIds link the entry to field blocks and equipment. occurredAt defaults to now. plantingLinks record plan-vs-actual: each links the entry to a Planting + lifecycle stage (SOW/TRANSPLANT/HARVEST), writing a LogPlanting row (the entry becomes the ACTUAL for that milestone) and advancing the Planting status. On a HARVEST entry, an optional harvest payload mints a HARVEST_IN inventory lot of the harvested item and records lot genealogy (the input lots consumed on parcelId become DERIVATION parents).',
});

export const UpdateLogEntrySchema = z.object({
    type: z.enum(LOG_ENTRY_TYPE_VALUES).optional(),
    status: z.enum(['PLANNED', 'DONE']).optional(),
    occurredAt: z.string().optional().nullable(),
    title: z.string().min(1).max(500).optional(),
    notes: z.string().max(20000).optional().nullable(),
    quantities: z.array(LogQuantitySchema).max(50).optional(),
    locationIds: z.array(z.string().min(1)).max(100).optional(),
    equipmentIds: z.array(z.string().min(1)).max(100).optional(),
    operationParcelId: z.string().optional().nullable(),
    costAmount: z.coerce.number().nonnegative().optional().nullable(),
    costCurrency: z.string().max(8).optional().nullable(),
}).strip().openapi('LogEntryUpdateRequest', {
    description: 'Partial update for a field-journal entry. Every field optional. When quantities / locationIds / equipmentIds are supplied they fully REPLACE the existing set (full-replace semantics, matching the create shape).',
});

export const AttachLogEntryFileSchema = z.object({
    fileRecordId: z.string().min(1, 'fileRecordId is required'),
    caption: z.string().max(500).optional().nullable(),
}).strip().openapi('LogEntryFileAttachRequest', {
    description: 'Attach an already-uploaded FileRecord (photo / document) to a journal entry. Upload the file first via /journal/{id}/files (multipart) or /evidence/uploads, then reference its id here.',
});
