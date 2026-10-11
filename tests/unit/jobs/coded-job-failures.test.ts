/**
 * A job failure that NAMES ITSELF — the brand, the stamp, and the registry
 * hop between them (#1447).
 *
 * The three pieces are tested together because the bug they exist to prevent
 * lives in the SEAMS: the thrower had a code, the poll route had a field, and
 * nothing carried one to the other. BullMQ persists `err.message` and nothing
 * else, so every part of this chain has to hold or a farmer reads English.
 */
import { CodedFailureError, isCodedFailure } from '@/lib/errors/coded-failure';
import { SpatialLimitError, assertUploadWithinSize, assertParcelComplexity } from '@/lib/spatial/limits';
import type { ParsedParcel } from '@/lib/spatial/parse';
import {
    JOB_FAILURE_STAMP_KEY,
    readFailureStamp,
    withFailureStamp,
} from '@/app-layer/jobs/failure-stamp';

describe('isCodedFailure — the brand, not a `code` property', () => {
    it('accepts an error that opted in', () => {
        expect(isCodedFailure(new CodedFailureError('m', 'SOME_CODE'))).toBe(true);
        expect(isCodedFailure(new SpatialLimitError('m', 'SOME_CODE', 422))).toBe(true);
    });

    it.each([
        ['a node fs error', Object.assign(new Error('no such file'), { code: 'ENOENT' })],
        ['a node socket error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
        ['a Prisma error', Object.assign(new Error('unique'), { code: 'P2002' })],
    ])('REJECTS %s, which carries a `code` of its own', (_label, err) => {
        // This is the whole reason the brand exists. Every one of these
        // matches /^[A-Z][A-Z0-9_]{2,}$/, so duck-typing on `err.code` would
        // have published a storage errno to a phone as though it were a
        // documented refusal code.
        expect(isCodedFailure(err)).toBe(false);
    });

    it.each([
        ['a plain Error', new Error('boom')],
        ['a string', 'boom'],
        ['null', null],
        ['undefined', undefined],
        ['a branded object with no code', { isCodedFailure: true }],
    ])('rejects %s', (_label, value) => {
        expect(isCodedFailure(value)).toBe(false);
    });

    it('a branded error still behaves as an Error', () => {
        const err = new CodedFailureError('the sentence', 'SOME_CODE', { n: 1 });
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('the sentence');
        expect(err.params).toEqual({ n: 1 });
    });
});

describe('the failure stamp — worker writes, poll route reads', () => {
    it('preserves the payload, which the tenant pin depends on', () => {
        const payload = { tenantId: 't1', locationId: 'l1', filename: 'a.zip' };
        const stamped = withFailureStamp(payload, { code: 'SPATIAL_PARSE_TIMEOUT' });
        // Losing `tenantId` here would turn every subsequent poll into a 404 —
        // the route reads it off `job.data` to prove the job is yours.
        expect(stamped.tenantId).toBe('t1');
        expect(stamped.locationId).toBe('l1');
        expect(stamped[JOB_FAILURE_STAMP_KEY]).toEqual({ code: 'SPATIAL_PARSE_TIMEOUT' });
    });

    it('round-trips a code and its params', () => {
        const data = withFailureStamp(
            { tenantId: 't1' },
            { code: 'SPATIAL_IMPORT_TOO_COMPLEX', params: { vertices: 812_340, limit: 500_000 } },
        );
        expect(readFailureStamp(data, 'failed')).toEqual({
            failedCode: 'SPATIAL_IMPORT_TOO_COMPLEX',
            failedParams: { vertices: 812_340, limit: 500_000 },
        });
    });

    it.each(['completed', 'active', 'waiting', 'delayed'])(
        'publishes NOTHING while the job is %s',
        (state) => {
            // The gate that matters. The worker's processor is shared by every
            // job name and some retry: a job that fails attempt 1 with a code
            // and succeeds on attempt 2 leaves the stamp behind in `job.data`.
            // Reading it unconditionally would hand a client a failure code for
            // a job that completed successfully.
            const data = withFailureStamp({ tenantId: 't1' }, { code: 'SPATIAL_PARSE_TIMEOUT' });
            expect(readFailureStamp(data, state)).toEqual({
                failedCode: null,
                failedParams: null,
            });
        },
    );

    it.each([
        ['no stamp at all', { tenantId: 't1' }],
        ['a null stamp', { tenantId: 't1', failure: null }],
        ['a stamp that is a string', { tenantId: 't1', failure: 'SPATIAL_PARSE_TIMEOUT' }],
        ['a stamp with no code', { tenantId: 't1', failure: { params: { n: 1 } } }],
        ['undefined data', undefined],
    ])('reads null from %s', (_label, data) => {
        expect(readFailureStamp(data, 'failed')).toEqual({ failedCode: null, failedParams: null });
    });

    it('drops params that are not scalars', () => {
        // The stamp round-trips through Redis as JSON. `ErrorParams` is
        // `string | number` and the error envelope documents that contract, so
        // the shape is re-checked on the way out rather than asserted.
        const data = { tenantId: 't1', failure: { code: 'X_Y_Z', params: { nested: { a: 1 } } } };
        expect(readFailureStamp(data, 'failed')).toEqual({
            failedCode: 'X_Y_Z',
            failedParams: null,
        });
    });
});

describe('the spatial limit codes a client switches on', () => {
    it('sends raw integer BYTES for the size cap, not formatted megabytes', () => {
        try {
            assertUploadWithinSize('shapefile', 6 * 1024 * 1024);
            throw new Error('expected a refusal');
        } catch (err) {
            expect(isCodedFailure(err)).toBe(true);
            const e = err as SpatialLimitError;
            expect(e.code).toBe('SPATIAL_UPLOAD_TOO_LARGE');
            expect(e.statusCode).toBe(413);
            // Integers. `toFixed(1)` writes an English decimal point, and a
            // client writing «7,2 MB» would have had to parse «6.0 MB» back
            // out — the nit agrent-ios raised on #1633.
            expect(e.params).toEqual({
                sizeBytes: 6 * 1024 * 1024,
                limitBytes: 5 * 1024 * 1024,
                format: 'shapefile',
            });
            for (const v of Object.values(e.params!)) {
                expect(typeof v === 'string' || typeof v === 'number').toBe(true);
            }
            // The English sentence keeps the human figure — it is the fallback.
            expect(e.message).toContain('6.0 MB');
        }
    });

    it('names the complexity cap it hit, with the numbers behind it', () => {
        const parcel = (name: string, vertices: number): ParsedParcel => ({
            name,
            geometry: {
                type: 'MultiPolygon' as const,
                coordinates: [[Array.from({ length: vertices }, () => [0, 0] as [number, number])]],
            },
            // Required by `ParsedParcel`. Annotating the return type rather
            // than leaving it inferred is the point: the first version was an
            // untyped object literal, so a missing required field only
            // surfaced in CI's typecheck.
            properties: {},
        });
        try {
            assertParcelComplexity([parcel('A', 60_000)]);
            throw new Error('expected a refusal');
        } catch (err) {
            const e = err as SpatialLimitError;
            expect(e.code).toBe('SPATIAL_PARCEL_TOO_COMPLEX');
            expect(e.params).toEqual({ vertices: 60_000, limit: 50_000 });
            // The parcel NAME is in the message and deliberately NOT in
            // params: it is operator-supplied content from inside the uploaded
            // file and can name a person.
            expect(e.message).toContain('"A"');
            expect(JSON.stringify(e.params)).not.toContain('A');
        }
    });
});
