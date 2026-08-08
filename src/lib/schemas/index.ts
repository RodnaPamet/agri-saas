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
    manufacturer: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
    serialNumber: z.string().optional().nullable(),
    year: z.coerce.number().int().min(1900).max(2100).optional().nullable(),
    purchaseDate: z.string().optional().nullable(),
    purchaseCost: z.coerce.number().min(0).optional().nullable(),
}).strip().openapi('AssetUpdateRequest', {
    description: 'Partial update for an agricultural asset. Every field is optional; only provided fields are persisted.',
});


// ─── Controls ───

export const CreateControlSchema = z.object({
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
}).strip().openapi('ControlCreateRequest', {
    description: 'Payload for creating a control. Status defaults to NOT_STARTED. `code` carries the framework reference where one applies (e.g. ISO 27001:2022 A.5.1) and is minted as `CTL-N` for custom controls. Custom controls (isCustom=true) are tenant-specific.',
});

export const UpdateControlSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    code: z.string().optional().nullable(),
    intent: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    frequency: z.enum(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional().nullable(),
    evidenceSource: z.enum(['MANUAL', 'INTEGRATION']).optional().nullable(),
    automationKey: z.string().optional().nullable(),
    mitigationType: z.enum(['PREVENTIVE', 'DETECTIVE', 'DETERRENT', 'CORRECTIVE', 'COMPENSATING']).optional().nullable(),
}).strip().openapi('ControlUpdateRequest', {
    description: 'Partial update for a control. Status, applicability, and owner have dedicated focused endpoints; this body covers descriptive metadata only.',
});

export const SetControlStatusSchema = z.object({
    status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'IMPLEMENTED', 'NEEDS_REVIEW']),
}).strip().openapi('ControlSetStatusRequest', {
    description: 'Lifecycle transition for a control. NEEDS_REVIEW signals a control whose evidence has lapsed or whose owner was removed.',
});

export const SetControlApplicabilitySchema = z.object({
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']),
    justification: z.string().optional().nullable().default(null),
}).strip().openapi('ControlSetApplicabilityRequest', {
    description: 'Statement-of-applicability flag for a control. NOT_APPLICABLE controls are excluded from coverage metrics and audit packs but remain queryable.',
});

export const SetControlOwnerSchema = z.object({
    ownerUserId: z.string().nullable(),
}).strip().openapi('ControlSetOwnerRequest', {
    description: 'Reassign or unassign a control owner. Pass null to clear the owner; pass a userId to assign.',
});

export const CreateControlTaskSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional().nullable(),
    assigneeUserId: z.string().optional().nullable(),
    dueAt: z.string().optional().nullable(),
}).strip().openapi('ControlTaskCreateRequest', {
    description: 'Create a task on a control. Tasks are the unit of operational work — implementation steps, evidence-gathering, review cycles.',
});

export const UpdateControlTaskSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'BLOCKED']).optional(),
    assigneeUserId: z.string().optional().nullable(),
    dueAt: z.string().optional().nullable(),
}).strip().openapi('ControlTaskUpdateRequest', {
    description: 'Partial update for a control task — including status transitions and reassignment.',
});

export const LinkEvidenceSchema = z.object({
    kind: z.enum(['FILE', 'LINK', 'INTEGRATION_RESULT']),
    fileId: z.string().optional().nullable(),
    url: z.string().url().optional().nullable(),
    note: z.string().optional().nullable(),
}).strip().openapi('EvidenceLinkRequest', {
    description: 'Attach evidence to a control. FILE kinds reference an uploaded FileRecord by id; LINK kinds carry a URL; INTEGRATION_RESULT kinds are emitted by automation runs.',
});

export const MapRequirementSchema = z.object({
    requirementId: z.string().min(1, 'requirementId is required'),
}).strip().openapi('ControlRequirementMapRequest', {
    description: 'Map a framework requirement to a control (e.g. asserting this control satisfies ISO 27001:2022 A.5.1).',
});

export const SetApplicabilitySchema = z.object({
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']),
    justification: z.string().optional().nullable(),
}).strip().refine(
    (data) => data.applicability === 'APPLICABLE' || (data.justification && data.justification.trim().length > 0),
    { message: 'Justification is required when marking a control as Not Applicable', path: ['justification'] }
);

// ─── Policies ───

export const CreatePolicySchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    reviewFrequencyDays: z.coerce.number().int().min(1).optional().nullable(),
    language: z.string().optional().nullable(),
    content: z.string().optional().nullable(), // initial markdown content
    templateId: z.string().optional().nullable(), // create from template
}).strip().openapi('PolicyCreateRequest', {
    description: 'Create a policy. content (initial Markdown) AND templateId are optional but mutually exclusive — pass content for a from-scratch policy, templateId to spawn from a framework template. The first PolicyVersion is created server-side.',
});

export const UpdatePolicyMetadataSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    reviewFrequencyDays: z.coerce.number().int().min(1).optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
    language: z.string().optional().nullable(),
}).strip().openapi('PolicyMetadataUpdateRequest', {
    description: 'Update policy metadata only — title, owner, review cadence. Content edits go through the policy-version endpoint.',
});

export const CreatePolicyVersionSchema = z.object({
    contentType: z.enum(['MARKDOWN', 'HTML', 'EXTERNAL_LINK']),
    contentText: z.string().optional().nullable(),
    externalUrl: z.string().url('Must be a valid URL').optional().nullable(),
    changeSummary: z.string().optional().nullable(),
}).strip().openapi('PolicyVersionCreateRequest', {
    description: 'Create a new draft version of a policy. contentText is required for MARKDOWN/HTML; externalUrl is required for EXTERNAL_LINK. contentText is sanitized + encrypted at rest.',
});

export const RequestApprovalSchema = z.object({
    versionId: z.string().min(1, 'versionId is required'),
}).strip().openapi('PolicyApprovalRequestRequest', {
    description: 'Request approval for a draft policy version. Routes through the configured approver chain.',
});

export const DecideApprovalSchema = z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().optional().nullable(),
}).strip().openapi('PolicyApprovalDecideRequest', {
    description: 'Approver decision on a pending policy version. Rejection requires no comment per spec but operators are encouraged to provide one.',
});

export const PublishPolicySchema = z.object({
    versionId: z.string().min(1, 'versionId is required'),
}).strip().openapi('PolicyPublishRequest', {
    description: 'Promote an approved policy version to PUBLISHED. Only one published version per policy at a time; the previous published version is archived.',
});

// ─── Evidence ───

// Shared internal base — no .openapi() metadata, so derived schemas
// (e.g. CreateEvidenceFormSchema) don't inherit a colliding component
// id. zod 4's metadata system propagates `.openapi(id)` through
// `.extend()` whereas zod 3 dropped it; building both schemas from
// this base prevents a duplicate-component-id collision in the
// OpenAPI document.
const _CreateEvidenceBase = z.object({
    controlId: z.string().optional().nullable(),
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

export const CreateEvidenceFormSchema = _CreateEvidenceBase.extend({
    file: z.any().optional(), // File object caught from FormData
}).strip();

export const UpdateEvidenceSchema = z.object({
    title: z.string().min(1).optional(),
    // The free-text body. The UI LABELS this "description", and the edit modal
    // used to send it under that name — which `.strip()` silently discarded,
    // so editing an evidence description saved nothing and reported success.
    // The wire name matches the column; the user-facing label is a translation
    // string and can say whatever reads best.
    content: z.string().optional(),
    // Re-assigning evidence to a different control. The modal has always had
    // the picker and always sent the value; without a field here `.strip()`
    // dropped it, so the picker moved and nothing changed. Nullable: clearing
    // it detaches the evidence.
    controlId: z.string().optional().nullable(),
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

export const CreateFindingSchema = z.object({
    auditId: z.string().optional().nullable(),
    severity: z.string().min(1, 'Severity is required'),
    type: z.string().min(1, 'Type is required'),
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional(),
    rootCause: z.string().optional().nullable(),
    correctiveAction: z.string().optional().nullable(),
    // Analyst notes / commentary (encrypted at rest).
    analysis: z.string().max(20000).optional().nullable(),
    owner: z.string().optional().nullable(),
    // Assignee — a tenant member id (validated server-side).
    assigneeUserId: z.string().optional().nullable(),
    // The control the finding is raised against.
    controlId: z.string().optional().nullable(),
    // A compensating control that mitigates the finding.
    compensatingControlId: z.string().optional().nullable(),
    dueDate: z.string().optional().nullable(),
}).strip().openapi('FindingCreateRequest', {
    description: 'Create an audit finding. auditId is optional — findings can be raised independently of an audit cycle. description, rootCause + analysis are encrypted at rest. assigneeUserId / controlId / compensatingControlId are validated against the tenant.',
});

export const UpdateFindingSchema = z.object({
    severity: z.string().optional(),
    type: z.string().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    rootCause: z.string().optional().nullable(),
    correctiveAction: z.string().optional().nullable(),
    analysis: z.string().max(20000).optional().nullable(),
    owner: z.string().optional().nullable(),
    assigneeUserId: z.string().optional().nullable(),
    controlId: z.string().optional().nullable(),
    compensatingControlId: z.string().optional().nullable(),
    dueDate: z.string().optional().nullable(),
    status: z.enum(['OPEN', 'IN_PROGRESS', 'READY_FOR_VERIFICATION', 'CLOSED']).optional(),
    verificationNotes: z.string().optional().nullable(),
}).strip().openapi('FindingUpdateRequest', {
    description: 'Partial update for a finding — including lifecycle transitions and verification notes. Relation fields (assignee/control/compensating) are validated against the tenant.',
});

// ─── Audits ───

const ChecklistUpdateSchema = z.object({
    id: z.string().min(1),
    result: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
}).strip();

export const CreateAuditSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    scope: z.string().optional(),
    criteria: z.string().optional().nullable(),
    schedule: z.string().optional().nullable(),
    auditors: z.string().optional().nullable(),
    auditees: z.string().optional().nullable(),
    departments: z.string().optional().nullable(),
    // B8 — optional Framework.key the audit assesses. Capped at 60
    // chars to match the canonical Framework.key length budget.
    frameworkKey: z.string().max(60).optional().nullable(),
    generateChecklist: z.boolean().optional(),
}).strip().openapi('AuditCreateRequest', {
    description: 'Create an audit cycle. frameworkKey links the audit to a compliance framework. generateChecklist=true seeds the audit with checklist items derived from the in-scope frameworks.',
});

export const UpdateAuditSchema = z.object({
    title: z.string().min(1).optional(),
    scope: z.string().optional(),
    criteria: z.string().optional().nullable(),
    status: z.enum(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
    auditors: z.string().optional().nullable(),
    auditees: z.string().optional().nullable(),
    checklistUpdates: z.array(ChecklistUpdateSchema).optional(),
}).strip().openapi('AuditUpdateRequest', {
    description: 'Update an audit cycle including status transitions and checklist-row updates (per-row result + notes via checklistUpdates).',
});

// ─── Tasks (Unified Work Items) ───

export const CreateTaskSchema = z.object({
    title: z.string().min(1).max(500),
    type: z.enum(['AUDIT_FINDING', 'CONTROL_GAP', 'INCIDENT', 'IMPROVEMENT', 'TASK']).optional().default('TASK'),
    description: z.string().max(10000).nullable().optional(),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    source: z.enum(['MANUAL', 'TEMPLATE', 'POLICY_REVIEW', 'AUDIT', 'INTEGRATION']).optional(),
    dueAt: z.string().nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    controlId: z.string().nullable().optional(),
    metadataJson: z.any().optional(),
}).strip().openapi('TaskCreateRequest', {
    description: 'Create a task (unified work-item type covering audit findings, control gaps, incidents, improvements, and ad-hoc tasks). The type discriminator gates which UI surfaces this work item appears in.',
});

export const UpdateTaskSchema = z.object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).nullable().optional(),
    type: z.enum(['TASK', 'AUDIT_FINDING', 'CONTROL_GAP', 'INCIDENT', 'IMPROVEMENT']).optional(),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    dueAt: z.string().nullable().optional(),
    controlId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    metadataJson: z.any().optional(),
}).strip().openapi('TaskUpdateRequest', {
    description: 'Partial update for a task. Status changes and assignment go through their own focused endpoints.',
});

export const SetTaskStatusSchema = z.object({
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
    url: z.string().url().max(2000),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('TaskEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on a task. File uploads use the multipart /evidence/uploads endpoint with a taskId.',
});

export const LinkAssetEvidenceSchema = z.object({
    url: z.string().url().max(2000),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('AssetEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on an asset. File uploads use the multipart /evidence/uploads endpoint with an assetId.',
});

export const AddTaskLinkSchema = z.object({
    entityType: z.enum(['CONTROL', 'FRAMEWORK_REQUIREMENT', 'ASSET', 'POLICY', 'EVIDENCE', 'FILE', 'AUDIT_PACK', 'VENDOR']),
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

export const UpdateClauseProgressSchema = z.object({
    status: z.string().min(1, 'Status is required'),
    notes: z.string().optional().nullable(),
}).strip();

// ─── Auth ───

export const AuthRegisterSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    orgName: z.string().min(1),
}).strip().openapi('AuthRegisterRequest', {
    description: 'Self-service signup payload (gated by AUTH_TEST_MODE in non-prod). The password is checked against HIBP via k-anonymity before persistence; emailVerification is initiated server-side.',
});

// `action: 'login'` was removed 2026-04-22 — the old bespoke /api/auth/
// register login endpoint was a parallel path to NextAuth's Credentials
// provider. All production login now flows through NextAuth. The legacy
// union is kept as a single-variant union for Zod-discriminated-union
// compatibility; the variant check still catches other malformed bodies.
export const AuthActionSchema = z.discriminatedUnion('action', [
    AuthRegisterSchema.extend({ action: z.literal('register') }),
]);

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

export const CreateVendorSchema = z.object({
    name: z.string().min(1).max(200),
    legalName: z.string().max(300).optional().nullable(),
    websiteUrl: z.string().url().max(500).optional().nullable(),
    domain: z.string().max(200).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    status: z.enum(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED']).optional(),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    inherentRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().nullable(),
    dataAccess: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional().nullable(),
    isSubprocessor: z.boolean().optional(),
    tags: z.array(z.string().max(50)).max(20).optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
    contractRenewalAt: z.string().optional().nullable(),
}).strip().openapi('VendorCreateRequest', {
    description: 'Create a vendor (third-party supplier) record. Risk + criticality fields drive vendor-tiering and audit-cycle scope. description is encrypted at rest.',
});

export const UpdateVendorSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    legalName: z.string().max(300).optional().nullable(),
    websiteUrl: z.string().url().max(500).optional().nullable(),
    domain: z.string().max(200).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    status: z.enum(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED']).optional(),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    inherentRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().nullable(),
    residualRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().nullable(),
    dataAccess: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional().nullable(),
    isSubprocessor: z.boolean().optional(),
    tags: z.array(z.string().max(50)).max(20).optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
    contractRenewalAt: z.string().optional().nullable(),
}).strip().openapi('VendorUpdateRequest', {
    description: 'Partial update for a vendor. residualRisk is computed from inherentRisk + control coverage; allow direct override here for SoC analyst workflow.',
});

export const CreateVendorDocumentSchema = z.object({
    type: z.enum(['CONTRACT', 'SOC2', 'ISO_CERT', 'DPA', 'SECURITY_POLICY', 'PEN_TEST', 'OTHER']),
    fileId: z.string().optional().nullable(),
    externalUrl: z.string().url().max(1000).optional().nullable(),
    title: z.string().max(300).optional().nullable(),
    validFrom: z.string().optional().nullable(),
    validTo: z.string().optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    // B8 — free-text folder label (e.g. "Contracts/2026"). Sanitised
    // + trimmed at the usecase boundary; null/empty maps to "no folder".
    folder: z.string().max(120).optional().nullable(),
}).strip();

export const StartAssessmentSchema = z.object({
    templateKey: z.string().min(1).max(100),
}).strip();

export const SaveAssessmentAnswersSchema = z.object({
    answers: z.array(z.object({
        questionId: z.string().min(1),
        answerJson: z.any(),
    })).min(1).max(200),
}).strip();

export const DecideAssessmentSchema = z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: z.string().max(5000).optional().nullable(),
}).strip();

export const SetVendorReviewSchema = z.object({
    nextReviewAt: z.string().optional().nullable(),
    contractRenewalAt: z.string().optional().nullable(),
}).strip();

export const AddVendorLinkSchema = z.object({
    entityType: z.enum(['ASSET', 'ISSUE', 'CONTROL']),
    entityId: z.string().min(1),
    relation: z.enum(['USES', 'STORES_DATA_FOR', 'PROVIDES_SERVICE_TO', 'MITIGATES', 'RELATED']).optional(),
}).strip();

// ─── Control Test Schemas ───

// ─── Epic G-3 — Vendor Assessment Template Authoring ──────────────
//
// Per-answerType cross-field validation (e.g. SCALE requires
// scaleConfigJson, SINGLE_SELECT requires optionsJson) is enforced
// at the usecase boundary so the error message can name the
// answer type rather than report a generic "missing field".

export const CreateVendorAssessmentTemplateSchema = z.object({
    /// Stable template identifier shared across versions. The usecase
    /// canonicalizes input to lowercase-kebab-case before persisting.
    key: z.string().min(1).max(120),
    name: z.string().min(1).max(500),
    description: z.string().max(10000).nullable().optional(),
    /// Tenant copies default to false. Global templates surface in
    /// the catalog browse UI for cloning into a tenant.
    isGlobal: z.boolean().optional().default(false),
}).strip();

export const AddVendorAssessmentTemplateSectionSchema = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10000).nullable().optional(),
    /// Per-section weight applied during scoring. Null = equal weight.
    weight: z.number().nonnegative().optional().nullable(),
    /// Optional explicit position. When omitted the usecase auto-
    /// assigns max(siblings)+1.
    sortOrder: z.number().int().nonnegative().optional(),
}).strip();

export const AddVendorAssessmentTemplateQuestionSchema = z.object({
    prompt: z.string().min(1).max(5000),
    answerType: z.enum([
        'YES_NO',
        'SINGLE_SELECT',
        'MULTI_SELECT',
        'TEXT',
        'NUMBER',
        'SCALE',
        'FILE_UPLOAD',
    ]),
    required: z.boolean().optional().default(true),
    weight: z.number().nonnegative().optional().default(1),
    /// SINGLE_SELECT / MULTI_SELECT — required for those types
    /// (enforced at the usecase boundary).
    optionsJson: z
        .array(
            z.object({
                label: z.string().min(1).max(500),
                value: z.string().min(1).max(500),
                points: z.number().optional(),
            }),
        )
        .nullable()
        .optional(),
    /// SCALE — required for that type. min must be < max.
    scaleConfigJson: z
        .object({
            min: z.number().int(),
            max: z.number().int(),
            labels: z.array(z.string().max(120)).max(10).optional(),
        })
        .nullable()
        .optional(),
    /// Legacy compatibility with the existing scoring service.
    riskPointsJson: z.unknown().nullable().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
}).strip();

export const ReorderVendorAssessmentTemplateSchema = z.object({
    sections: z.array(
        z.object({
            id: z.string().min(1).max(120),
            sortOrder: z.number().int().nonnegative(),
            questions: z.array(
                z.object({
                    id: z.string().min(1).max(120),
                    sectionId: z.string().min(1).max(120),
                    sortOrder: z.number().int().nonnegative(),
                }),
            ).optional(),
        }),
    ).max(200),
}).strip();

export const ReviewVendorAssessmentSchema = z.object({
    /// Per-answer overrides. The reviewer can adjust a subset; any
    /// answer not in this list keeps its auto-computed points.
    overrides: z
        .array(
            z.object({
                questionId: z.string().min(1).max(120),
                /// Override numeric points. Null clears a previous
                /// override; undefined leaves it untouched. Float
                /// because some weighted modes produce fractional
                /// effective points.
                overridePoints: z.number().nullable().optional(),
                /// Free-text reviewer commentary; max 5000 chars.
                reviewerNotes: z.string().max(5000).nullable().optional(),
            }),
        )
        .max(500)
        .optional()
        .default([]),
    /// Manual final-rating override. Null = let the engine derive
    /// from score + ratingThresholds. Undefined = no opinion (engine
    /// derivation also wins).
    finalRiskRating: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .nullable()
        .optional(),
    /// Assessment-level reviewer note, distinct from per-answer notes.
    reviewerNotes: z.string().max(10000).nullable().optional(),
}).strip();

export const CloneVendorAssessmentTemplateSchema = z.object({
    /// SAME_KEY_NEW_VERSION — produce a new draft revision of the
    /// existing template family. The previous latest version
    /// retains its data (live assessments stay pinned via
    /// templateVersionId) but loses the isLatestVersion flag.
    ///
    /// NEW_KEY — fork into a separate template family. Caller
    /// must supply a new `key`.
    mode: z.enum(['SAME_KEY_NEW_VERSION', 'NEW_KEY']),
    key: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).nullable().optional(),
}).strip();

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
    applicationTechnique: z.string().max(255).nullable().optional(),
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
