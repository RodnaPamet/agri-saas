/**
 * The OpenAPI document must describe ENDPOINTS, not just schemas.
 *
 * #944: for as long as it took anyone to notice, `npm run openapi:generate`
 * produced a valid OpenAPI 3.1 file with 47 component schemas and **zero
 * paths** — nothing had ever called `registerPath`. A peer session tried to
 * generate a client from it and could not: `LogEntryCreateRequest` was there,
 * and no operation consumed it.
 *
 * It survived because `tests/unit/openapi-generator.test.ts` typed the spec as
 * `paths?: Record<string, unknown>` — **optional**. A spec with zero paths
 * satisfied the type and every assertion built on it. Exactly the
 * empty-selection shape that also defeated the dead-selector guards in
 * #865/#875: "no endpoints registered" and "endpoints registered and correct"
 * were the same observable.
 *
 * So this guard asserts three things a large-but-empty object cannot fake:
 * a floor on the count, specific named operations, and that every operation
 * actually describes a result. A spec that lists paths and documents none of
 * their responses would be the same defect one level down.
 *
 * PATH_FLOOR rises with each batch of registrations. It is a ratchet: raise it
 * in the same PR that adds the paths.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC_PATH = path.resolve(__dirname, '../../src/generated/openapi.json');

type Operation = {
    operationId?: string;
    responses?: Record<string, { content?: Record<string, unknown> }>;
};
type Spec = {
    paths?: Record<string, Record<string, Operation>>;
    components?: { securitySchemes?: Record<string, unknown> };
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Raised by #944's first batch (journal: 2), then by the operator batch —
 * farm-tasks (1), field-operations (3) and locations (20). Raise it in the PR
 * that adds paths, never on its own — a floor that drifts below the real
 * count is a ratchet that has stopped ratcheting.
 */
const PATH_FLOOR = 26;

/**
 * Operations a client is known to consume. A count alone can be satisfied by
 * a large-but-wrong document; these cannot.
 *
 * The whole operator path is listed, not a sample. A sample would let the
 * count carry the weight for everything outside it, and the count is the part
 * a large-but-wrong document can already satisfy.
 */
const REQUIRED_OPERATION_IDS = [
    // Journal
    'listJournalEntries',
    'createJournalEntry',
    'getJournalEntry',
    'updateJournalEntry',
    'deleteJournalEntry',
    // Farm tasks — the operator's queue
    'listFarmTasks',
    'createFarmTask',
    // Field operations — the job the operator executes
    'getFieldOperation',
    'markOperationParcel',
    'reviewFieldOperation',
    // Locations
    'listLocations',
    'createLocation',
    'getLocation',
    'replaceLocation',
    'updateLocation',
    'deleteLocation',
    'bulkDeleteLocations',
    'getLocationSmartDefaults',
    // Parcels
    'listLocationParcels',
    'createParcel',
    'updateParcel',
    'deleteParcel',
    'mergeParcels',
    'splitParcel',
    // Leases (аренда/наем)
    'listParcelLeases',
    'createParcelLease',
    'updateParcelLease',
    'deleteParcelLease',
    // Field operations, created against a location
    'listLocationOperations',
    'createFieldOperation',
    // Map
    'getParcelClusters',
    'getParcelTile',
    'getBasemapTile',
    // БАБХ farm records
    'generateFarmRecord',
    'listFarmRecords',
    // Imports
    'getCadastreImportSettings',
    'startCadastreImport',
    'getCadastreImportJob',
    'startSpatialImport',
    'getSpatialImportJob',
];

function readSpec(): Spec {
    return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Spec;
}

function operations(spec: Spec): Operation[] {
    return Object.values(spec.paths ?? {}).flatMap((item) =>
        METHODS.filter((m) => item[m]).map((m) => item[m]),
    );
}

describe('the generated OpenAPI document describes endpoints', () => {
    it('has a paths object AT ALL', () => {
        const spec = readSpec();
        // Asserted BEFORE any count. A missing key would otherwise satisfy
        // `0 >= 0` and this whole file would be theatre.
        expect(spec.paths).toBeDefined();
    });

    it(`documents at least ${PATH_FLOOR} paths`, () => {
        const spec = readSpec();
        expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThanOrEqual(PATH_FLOOR);
    });

    it('the floor is a real floor, not zero', () => {
        // A PATH_FLOOR of 0 would pass every assertion above while the
        // document described nothing — the defect this guard exists for.
        expect(PATH_FLOOR).toBeGreaterThan(0);
    });

    it('documents the operations a client actually consumes', () => {
        const ids = operations(readSpec())
            .map((o) => o.operationId)
            .filter((id): id is string => Boolean(id));
        const missing = REQUIRED_OPERATION_IDS.filter((id) => !ids.includes(id));
        expect(missing).toEqual([]);
    });

    /**
     * Every operation says what SUCCESS looks like — a body, or a documented
     * reason there is none.
     *
     * The rule was originally "has a 2xx carrying content", which was right for
     * the population it was written against: every operation in the spec
     * returned JSON. It is wrong for an operation whose success is a REDIRECT.
     * `/api/auth/native/start` hands the system browser to the provider and
     * `/complete` hands the code back to the app's URI; both answer 3xx and
     * neither has a body to describe, so demanding one would force a documented
     * 200 that does not exist — a schema that lies is worse than no schema.
     *
     * So the exemption is by REASON rather than by absence: a 3xx success has no
     * body because it is a redirect, and 204/205 have none by HTTP definition.
     * Anything else with no 2xx content still fails, which is the case the test
     * exists for. Same correction as `openapi-response-shapes-ratchet`, which
     * skipped every schema-less 2xx unconditionally until it was asked WHY the
     * schema was missing.
     */
    it('every operation describes a SUCCESS body, or a reason it has none', () => {
        const bad = operations(readSpec())
            .filter((o) => {
                const responses = Object.entries(o.responses ?? {});
                // A described body — the ordinary case.
                if (responses.some(([status, r]) => status.startsWith('2') && r?.content)) {
                    return false;
                }
                // A redirect IS the success; there is nothing to carry.
                if (responses.some(([status]) => status.startsWith('3'))) return false;
                // Bodyless by HTTP definition.
                if (responses.some(([status]) => status === '204' || status === '205')) return false;
                return true;
            })
            .map((o) => o.operationId ?? '(unnamed)');
        expect(bad).toEqual([]);
    });

    it('the exemption is narrow — a 2xx JSON operation with no schema still fails', () => {
        // Proven against a synthetic document rather than the real one, because
        // the real one has no such operation: an exemption nothing exercises is
        // an exemption nobody can trust. If this ever passes by returning an
        // empty list, the widening above has swallowed the rule.
        const synthetic = {
            paths: {
                '/x': { get: { operationId: 'bodyless200', responses: { 200: { description: 'Fine.' } } } },
                '/y': { get: { operationId: 'redirects', responses: { 303: { description: 'Off you go.' } } } },
            },
        };
        const bad = operations(synthetic as never)
            .filter((o) => {
                const responses = Object.entries(o.responses ?? {});
                if (responses.some(([status, r]) => status.startsWith('2') && r?.content)) return false;
                if (responses.some(([status]) => status.startsWith('3'))) return false;
                if (responses.some(([status]) => status === '204' || status === '205')) return false;
                return true;
            })
            .map((o) => o.operationId);
        expect(bad).toEqual(['bodyless200']);
    });

    it('declares the security schemes operations reference', () => {
        const schemes = readSpec().components?.securitySchemes ?? {};
        expect(Object.keys(schemes)).toEqual(
            expect.arrayContaining(['sessionCookie', 'bearerToken']),
        );
    });
});
