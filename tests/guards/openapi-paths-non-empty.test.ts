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
 * Raised by #944's first batch (journal). Raise it in the PR that adds paths,
 * never on its own — a floor that drifts below the real count is a ratchet
 * that has stopped ratcheting.
 */
const PATH_FLOOR = 2;

/**
 * Operations a client is known to consume. A count alone can be satisfied by
 * a large-but-wrong document; these cannot.
 */
const REQUIRED_OPERATION_IDS = [
    'listJournalEntries',
    'createJournalEntry',
    'getJournalEntry',
    'updateJournalEntry',
    'deleteJournalEntry',
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

    it('every operation describes a SUCCESS body, not just a status', () => {
        // A path with no response schema tells a client nothing. Listing
        // endpoints while documenting none of them is the same
        // empty-selection defect one level down.
        const bad = operations(readSpec())
            .filter((o) => {
                const responses = Object.entries(o.responses ?? {});
                return !responses.some(([status, r]) => status.startsWith('2') && r?.content);
            })
            .map((o) => o.operationId ?? '(unnamed)');
        expect(bad).toEqual([]);
    });

    it('declares the security schemes operations reference', () => {
        const schemes = readSpec().components?.securitySchemes ?? {};
        expect(Object.keys(schemes)).toEqual(
            expect.arrayContaining(['sessionCookie', 'bearerToken']),
        );
    });
});
