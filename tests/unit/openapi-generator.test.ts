/**
 * GAP-10 step 3 — assertions on the generated `public/openapi.json`.
 *
 * The generator script (`scripts/generate-openapi.ts`) is the
 * single source of truth for the spec. This test reads the
 * COMMITTED spec and validates structural OpenAPI 3.1 invariants
 * — it does not re-run the generator (that's the snapshot
 * ratchet's job in step 5).
 *
 * Failure modes this catches:
 *   - The committed spec drifts away from valid OpenAPI 3.1 (someone
 *     hand-edits the JSON, or the generator emits malformed output).
 *   - A documented schema disappears from the spec (regression in
 *     the registry walk or in the source schema's annotation).
 *   - A request body / response DTO ends up with the wrong
 *     component name (regression in the naming convention).
 *
 * If you're here because this test failed:
 *   1. Run `npm run openapi:generate` and inspect the diff.
 *   2. If the diff is intentional, commit the new `public/openapi.json`.
 *   3. If unexpected, walk back to the schema annotation that
 *      changed.
 */
import * as fs from 'fs';
import * as path from 'path';

interface OpenApiDoc {
    openapi: string;
    info: {
        title: string;
        version: string;
        description?: string;
    };
    servers?: Array<{ url: string }>;
    paths?: Record<string, unknown>;
    components?: {
        schemas?: Record<string, unknown>;
    };
}

const SPEC_PATH = path.resolve(__dirname, '../../public/openapi.json');

function loadSpec(): OpenApiDoc {
    const raw = fs.readFileSync(SPEC_PATH, 'utf-8');
    return JSON.parse(raw) as OpenApiDoc;
}

describe('GAP-10 step 3 — generated OpenAPI 3.1 spec', () => {
    let spec: OpenApiDoc;

    beforeAll(() => {
        spec = loadSpec();
    });

    // ─── OpenAPI 3.1 conformance basics ─────────────────────────────

    it('declares openapi: "3.1.0"', () => {
        expect(spec.openapi).toBe('3.1.0');
    });

    it('has info.title + info.version + info.description', () => {
        expect(spec.info?.title).toBe('Agrent API');
        // version mirrors package.json — match the X.Y.Z shape, not
        // the literal value (which moves with semantic-release).
        expect(spec.info?.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(spec.info?.description).toBeTruthy();
        expect(spec.info?.description?.length).toBeGreaterThan(50);
    });

    it('declares at least one server', () => {
        expect(Array.isArray(spec.servers)).toBe(true);
        expect(spec.servers!.length).toBeGreaterThan(0);
        for (const server of spec.servers!) {
            expect(server.url).toMatch(/^https?:\/\//);
        }
    });

    it('has a components.schemas section', () => {
        expect(spec.components).toBeDefined();
        expect(spec.components!.schemas).toBeDefined();
        expect(typeof spec.components!.schemas).toBe('object');
    });

    // ─── Schema coverage ────────────────────────────────────────────

    it('registers all canonical request schemas (CRUD across the domains)', () => {
        const expectedRequests = [
            // Asset
            'AssetCreateRequest', 'AssetUpdateRequest',
            // Control
            'ControlCreateRequest', 'ControlUpdateRequest',
            'ControlSetStatusRequest', 'ControlSetApplicabilityRequest',
            'ControlSetOwnerRequest',
            // Policy
            'PolicyCreateRequest', 'PolicyMetadataUpdateRequest',
            'PolicyVersionCreateRequest', 'PolicyPublishRequest',
            // Evidence
            'EvidenceCreateRequest', 'EvidenceUpdateRequest',
            'EvidenceReviewRequest', 'EvidenceLinkRequest',
            // Audit
            'AuditCreateRequest', 'AuditUpdateRequest',
            // Task
            'TaskCreateRequest', 'TaskUpdateRequest',
            'TaskSetStatusRequest', 'TaskAssignRequest',
            // Vendor
            'VendorCreateRequest', 'VendorUpdateRequest',
            // Finding (audit-issue)
            'FindingCreateRequest', 'FindingUpdateRequest',
            // Auth
            'AuthRegisterRequest',
        ];
        for (const name of expectedRequests) {
            expect(spec.components!.schemas![name]).toBeDefined();
        }
    });

    it('registers all canonical response DTOs', () => {
        const expectedResponses = [
            // Cross-cutting
            'UserRef', 'UserRefShort', 'ErrorResponse', 'AuditLogEntry', 'SuccessResponse',
            // Domain DTOs
            'ControlListItem', 'ControlDetail', 'ControlDashboard',
            'EvidenceListItem', 'EvidenceDetail', 'EvidenceReview',
            'PolicyListItem', 'PolicyDetail',
            'Audit',
            'AssetListItem', 'AssetDetail',
            'Task',
            'VendorListItem', 'VendorDetail',
            'Framework', 'Requirement',
        ];
        for (const name of expectedResponses) {
            expect(spec.components!.schemas![name]).toBeDefined();
        }
    });

    it('has at least 60 schemas registered (canonical surface coverage floor)', () => {
        // Floor below the actual count (65 at the time of writing) so
        // future additions don't trip this; if a refactor accidentally
        // drops below 60 something major was deleted.
        const count = Object.keys(spec.components!.schemas!).length;
        expect(count).toBeGreaterThanOrEqual(60);
    });

    // ─── Per-schema sanity ──────────────────────────────────────────

    it('every schema declares a type or refs another schema', () => {
        // A well-formed JSON-Schema entry has at least one of: `type`,
        // `$ref`, `oneOf`, `anyOf`, `allOf`. Catches a regression that
        // emits an empty `{}` for a component (which Swagger UI renders
        // as a useless blank panel).
        const schemas = spec.components!.schemas!;
        const culprits: string[] = [];
        for (const [name, schema] of Object.entries(schemas)) {
            const s = schema as Record<string, unknown>;
            const hasShape =
                'type' in s ||
                '$ref' in s ||
                'oneOf' in s ||
                'anyOf' in s ||
                'allOf' in s;
            if (!hasShape) culprits.push(name);
        }
        expect(culprits).toEqual([]);
    });

    it('schemas with descriptions carry a non-empty string', () => {
        // We require `description` on every annotated schema (per the
        // GAP-10 step 2 contract). Empty descriptions defeat the
        // purpose — Swagger UI shows a blank panel.
        const schemas = spec.components!.schemas!;
        const offenders: string[] = [];
        for (const [name, schema] of Object.entries(schemas)) {
            const s = schema as { description?: unknown };
            if ('description' in s && (typeof s.description !== 'string' || s.description.length === 0)) {
                offenders.push(name);
            }
        }
        expect(offenders).toEqual([]);
    });
});
