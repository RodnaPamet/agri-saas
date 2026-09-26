/**
 * The spatial-import job's `details` payload matches the schema that PUBLISHES
 * it — asserted against the generated OpenAPI document, not a hand-written list.
 *
 * ## Why this exists
 *
 * #1135 added `matched` / `created` / `flagged` to the worker's return type and
 * to the audit entry. It did NOT add them to the executor's `details`, which is
 * the only place a polling client can read them — `GET .../spatial-import/{jobId}`
 * hands `job.returnvalue` back verbatim. So the counts existed in the type
 * system, existed in the audit log, and were absent from the wire.
 *
 * Nothing caught it. `tsc` was happy because `details` is
 * `Record<string, unknown>`; the response-shape ratchet was happy because
 * `ImportJobStatus` has properties and describes a shape; and the integration
 * tests were happy because they call `runLocationSpatialImport` DIRECTLY and
 * never travel through the executor that drops the fields.
 *
 * The iOS session found it by trying to build against the contract and
 * discovering the names were nowhere in the spec.
 *
 * ## The shape of the gap, because it will recur
 *
 * A fully-described operation can have an UNTYPED HOLE inside it. `result` was
 * `z.unknown()` nested in a schema that otherwise documents every field, so
 * every guard that asks "does this operation describe a response" answered yes.
 * Depth is the axis none of the ratchets measure.
 *
 * ## Why the expectation is DERIVED
 *
 * The required-key list comes from `SpatialImportDetails` in the generated
 * spec. A hardcoded list here would drift from the contract exactly the way the
 * executor drifted from the worker — and this test would then agree with itself
 * while disagreeing with what clients are told.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

jest.mock('@/app-layer/jobs/spatial-import', () => ({
    runLocationSpatialImport: jest.fn(async () => ({
        tenantId: 'ten_1',
        locationId: 'loc_1',
        fileRecordId: 'file_1',
        format: 'geojson',
        parcelCount: 5,
        matched: 3,
        created: 2,
        flagged: 1,
        bounds: [0, 0, 1, 1] as [number, number, number, number],
        skipped: 0,
        jobRunId: 'run_1',
    })),
}));

describe('spatial-import job result honours its published contract', () => {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')) as {
        components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
    };

    it('the contract exists and names the reconciliation counts', () => {
        // A positive control. If `SpatialImportDetails` stops being emitted —
        // it is registered explicitly, because nothing $refs it — every
        // assertion below would pass over an empty list.
        const schema = spec.components.schemas.SpatialImportDetails;
        expect(schema).toBeDefined();
        expect(schema.required ?? []).toEqual(
            expect.arrayContaining(['parcelCount', 'matched', 'created', 'flagged']),
        );
    });

    it('the executor emits EVERY key the contract requires', async () => {
        const { executorRegistry } = await import('@/app-layer/jobs/executor-registry');
        const executor = executorRegistry.getExecutor('spatial-import');
        expect(executor).toBeDefined();

        const result = (await executor!({
            tenantId: 'ten_1',
            initiatedByUserId: 'usr_1',
            locationId: 'loc_1',
            stagingPathKey: 'k',
            stagingFileRecordId: 'file_1',
            filename: 'f.geojson',
            mimeType: 'application/geo+json',
        } as never)) as { details?: Record<string, unknown> };

        const details = result.details ?? {};
        const required = spec.components.schemas.SpatialImportDetails.required ?? [];
        expect(required.length).toBeGreaterThan(0);

        const missing = required.filter((k) => !(k in details));
        expect(missing).toEqual([]);
    });

    it('the counts carry the worker’s values rather than placeholders', async () => {
        const { executorRegistry } = await import('@/app-layer/jobs/executor-registry');
        const result = (await executorRegistry.getExecutor('spatial-import')!({
            tenantId: 'ten_1',
            initiatedByUserId: 'usr_1',
            locationId: 'loc_1',
            stagingPathKey: 'k',
            stagingFileRecordId: 'file_1',
            filename: 'f.geojson',
            mimeType: 'application/geo+json',
        } as never)) as { details?: Record<string, unknown> };

        // Forwarding the KEYS but not the values would satisfy the test above.
        expect(result.details).toMatchObject({ matched: 3, created: 2, flagged: 1, parcelCount: 5 });
    });

    it('parcelCount is matched + created, and does NOT include flagged', async () => {
        // The arithmetic a client depends on when it reports "imported N".
        // `flagged` counts parcels the file OMITTED — they were kept, not
        // imported — so folding them in overstates what the farmer sent.
        const { executorRegistry } = await import('@/app-layer/jobs/executor-registry');
        const result = (await executorRegistry.getExecutor('spatial-import')!({
            tenantId: 'ten_1',
            initiatedByUserId: 'usr_1',
            locationId: 'loc_1',
            stagingPathKey: 'k',
            stagingFileRecordId: 'file_1',
            filename: 'f.geojson',
            mimeType: 'application/geo+json',
        } as never)) as { details?: Record<string, number> };

        const d = result.details!;
        expect(d.parcelCount).toBe(d.matched + d.created);
        expect(d.parcelCount).not.toBe(d.matched + d.created + d.flagged);
    });
});
