/**
 * GAP-10 — OpenAPI annotation foundation.
 *
 * Asserts the Zod→OpenAPI integration works end-to-end:
 *
 *   1. The extension module loads and the `.openapi()` method is
 *      attached to Zod schema instances.
 *   2. Every named schema we expect in the published spec has an
 *      OpenAPI metadata block (proven by re-reading the metadata
 *      via `_def.openapi`).
 *   3. Component IDs are globally unique — no collision between
 *      the request schemas in `src/lib/schemas/index.ts` and the
 *      response DTOs in `src/lib/dto/`.
 *   4. The shared registry can register an arbitrary schema and
 *      surface it on `definitions`, proving the generator pattern
 *      will work in step 3 of the GAP-10 plan
 *      (`scripts/generate-openapi.ts`).
 *
 * If any of these regress, GAP-10 step 3 (spec generation) and
 * step 4 (Swagger UI) cannot work — this is the load-bearing
 * foundation.
 */

import { z as zPlain } from 'zod';
import { z } from '@/lib/openapi/zod';
import { registry } from '@/lib/openapi/registry';

// All annotated schemas — request side
import * as requestSchemas from '@/lib/schemas';
// All annotated schemas — response DTO side
import * as commonDTOs from '@/lib/dto/common';
import * as controlDTOs from '@/lib/dto/control.dto';
import * as evidenceDTOs from '@/lib/dto/evidence.dto';
import * as policyDTOs from '@/lib/dto/policy.dto';
import * as auditDTOs from '@/lib/dto/audit.dto';
import * as assetDTOs from '@/lib/dto/asset.dto';
import * as taskDTOs from '@/lib/dto/task.dto';
import * as vendorDTOs from '@/lib/dto/vendor.dto';
import * as frameworkDTOs from '@/lib/dto/framework.dto';

interface AnnotatedSchema {
    schema: unknown;
    /** Best-effort source identifier for failure messages. */
    sourceName: string;
}

function collectAnnotatedSchemas(
    namespace: Record<string, unknown>,
    moduleName: string,
): AnnotatedSchema[] {
    const out: AnnotatedSchema[] = [];
    for (const [exportName, value] of Object.entries(namespace)) {
        // Heuristic: anything that's a Zod schema (has a `.parse`
        // method on the prototype). We don't want to recurse into
        // helper exports, types, etc.
        if (
            value &&
            typeof value === 'object' &&
            typeof (value as { parse?: unknown }).parse === 'function' &&
            typeof (value as { _def?: unknown })._def === 'object'
        ) {
            out.push({ schema: value, sourceName: `${moduleName}.${exportName}` });
        }
    }
    return out;
}

// In zod-to-openapi v8, `.openapi(name, …)` no longer writes onto
// `_def.openapi` — it stores metadata in an internal WeakMap keyed by
// the zod schema instance. The package exports `getRefId` which is
// the canonical way to read the registered ref id back out, so the
// test re-uses that.
import { getRefId as getOpenApiRefId } from '@asteasolutions/zod-to-openapi';

function getRefId(schema: unknown): string | undefined {
    return getOpenApiRefId(schema as never);
}

describe('GAP-10 foundation — Zod→OpenAPI extension', () => {
    it('exposes .openapi() on z (extension was applied)', () => {
        // The extension is a runtime side effect of importing
        // @/lib/openapi/zod. Direct check: the method exists.
        const s = z.string();
        expect(typeof (s as unknown as { openapi?: unknown }).openapi).toBe('function');
    });

    it('z imported from the OpenAPI module is the SAME singleton as bare zod (prototype is shared)', () => {
        // The extension mutates the shared ZodType prototype. A schema
        // built via `import { z } from 'zod'` AFTER the extension has
        // run also has the method available at runtime — TS just
        // doesn't surface it. This test confirms the runtime behavior.
        const fromOpenApi = z.string();
        const fromBare = zPlain.string();
        expect(typeof (fromOpenApi as unknown as { openapi?: unknown }).openapi).toBe('function');
        expect(typeof (fromBare as unknown as { openapi?: unknown }).openapi).toBe('function');
    });
});

describe('GAP-10 foundation — annotated schemas have metadata', () => {
    // Map each module to a list of EXPECTED registered names.
    // Adding to this list forces a contributor to actually annotate
    // the schema — keeping the spec coverage honest.
    const expectedAnnotations: Record<string, readonly string[]> = {
        '@/lib/dto/common': [
            'UserRefSchema',
            'UserRefShortSchema',
            'ApiErrorResponseSchema',
            'AuditLogEntrySchema',
            'SuccessResponseSchema',
        ],
        '@/lib/dto/control.dto': [
            'ControlListItemDTOSchema',
            'ControlDetailDTOSchema',
            'ControlDashboardDTOSchema',
        ],
        '@/lib/dto/evidence.dto': [
            'EvidenceReviewDTOSchema',
            'EvidenceListItemDTOSchema',
            'EvidenceDetailDTOSchema',
        ],
        '@/lib/dto/policy.dto': [
            'PolicyListItemDTOSchema',
            'PolicyDetailDTOSchema',
        ],
        '@/lib/dto/audit.dto': ['AuditDTOSchema'],
        '@/lib/dto/asset.dto': [
            'AssetListItemDTOSchema',
            'AssetDetailDTOSchema',
        ],
        '@/lib/dto/task.dto': ['TaskDTOSchema'],
        '@/lib/dto/vendor.dto': [
            'VendorListItemDTOSchema',
            'VendorDetailDTOSchema',
        ],
        '@/lib/dto/framework.dto': ['FrameworkDTOSchema', 'RequirementDTOSchema'],
        '@/lib/schemas': [
            // Canonical CRUD pairs across the 9 domains
            'CreateAssetSchema', 'UpdateAssetSchema',
            'CreateControlSchema', 'UpdateControlSchema',
            'CreatePolicySchema', 'UpdatePolicyMetadataSchema',
            'CreateEvidenceSchema', 'UpdateEvidenceSchema',
            'CreateAuditSchema', 'UpdateAuditSchema',
            'CreateTaskSchema', 'UpdateTaskSchema',
            'CreateVendorSchema', 'UpdateVendorSchema',
            'CreateFindingSchema', 'UpdateFindingSchema',
            // Focused mutation requests
            'SetControlStatusSchema',
            'SetControlApplicabilitySchema', 'SetTaskStatusSchema',
            'EvidenceReviewSchema', 'PublishPolicySchema',
        ],
    };

    const moduleSources: Record<string, Record<string, unknown>> = {
        '@/lib/dto/common': commonDTOs,
        '@/lib/dto/control.dto': controlDTOs,
        '@/lib/dto/evidence.dto': evidenceDTOs,
        '@/lib/dto/policy.dto': policyDTOs,
        '@/lib/dto/audit.dto': auditDTOs,
        '@/lib/dto/asset.dto': assetDTOs,
        '@/lib/dto/task.dto': taskDTOs,
        '@/lib/dto/vendor.dto': vendorDTOs,
        '@/lib/dto/framework.dto': frameworkDTOs,
        '@/lib/schemas': requestSchemas,
    };

    for (const [moduleName, expectedNames] of Object.entries(expectedAnnotations)) {
        for (const exportName of expectedNames) {
            it(`${moduleName} exports ${exportName} with .openapi() metadata`, () => {
                const mod = moduleSources[moduleName];
                const schema = mod[exportName];
                expect(schema).toBeDefined();
                const refId = getRefId(schema);
                expect(refId).toBeDefined();
                expect(typeof refId).toBe('string');
                expect((refId as string).length).toBeGreaterThan(0);
            });
        }
    }
});

describe('GAP-10 foundation — component IDs are globally unique', () => {
    it('no two DISTINCT annotated schemas share an OpenAPI component ID', () => {
        // Collect every annotated schema across all the modules above,
        // dedupe by identity (the schema files re-export deprecated
        // aliases — `CreateIssueSchema === CreateTaskSchema`; same JS
        // object, same annotation, not a real collision). Then assert
        // no duplicate refId across the deduped set. A real collision
        // would mean the spec generator silently overwrites one
        // schema with another.
        const sources = [
            { ns: commonDTOs, name: 'common' },
            { ns: controlDTOs, name: 'control.dto' },
            { ns: evidenceDTOs, name: 'evidence.dto' },
            { ns: policyDTOs, name: 'policy.dto' },
            { ns: auditDTOs, name: 'audit.dto' },
            { ns: assetDTOs, name: 'asset.dto' },
            { ns: taskDTOs, name: 'task.dto' },
            { ns: vendorDTOs, name: 'vendor.dto' },
            { ns: frameworkDTOs, name: 'framework.dto' },
            { ns: requestSchemas, name: 'schemas' },
        ];

        // First pass: collect distinct schema instances (by JS reference).
        const distinctSchemas = new Map<unknown, string>(); // schema → first sourceName
        for (const { ns, name } of sources) {
            for (const { schema, sourceName } of collectAnnotatedSchemas(
                ns as Record<string, unknown>,
                name,
            )) {
                if (!distinctSchemas.has(schema)) {
                    distinctSchemas.set(schema, sourceName);
                }
            }
        }

        // Second pass: refId uniqueness across distinct schemas only.
        const seen = new Map<string, string>(); // refId → sourceName
        for (const [schema, sourceName] of distinctSchemas) {
            const refId = getRefId(schema);
            if (!refId) continue;
            if (seen.has(refId)) {
                throw new Error(
                    `Duplicate OpenAPI component ID '${refId}': ` +
                    `${seen.get(refId)} and ${sourceName} both register it. ` +
                    'Component IDs MUST be globally unique.',
                );
            }
            seen.set(refId, sourceName);
        }
        expect(seen.size).toBeGreaterThan(20);
    });
});

describe('GAP-10 foundation — registry is wired and reusable', () => {
    it('registers a schema and surfaces it under definitions', () => {
        const TestSchema = z.object({ id: z.string() }).openapi('OpenApiFoundationTest', {
            description: 'Test-only marker schema.',
        });
        registry.register('OpenApiFoundationTest', TestSchema);
        // The registry exposes definitions (the array the generator
        // walks). Asserting the entry exists is enough to prove the
        // generator pattern from GAP-10 step 3 will work. v8 stores
        // the ref id in an external WeakMap rather than on
        // `_def.openapi`, so we use the package-exported `getRefId`.
        const defs = registry.definitions;
        const found = defs.find((d) => {
            const schema = (d as { schema?: unknown }).schema;
            return schema && getRefId(schema) === 'OpenApiFoundationTest';
        });
        expect(found).toBeDefined();
    });
});
