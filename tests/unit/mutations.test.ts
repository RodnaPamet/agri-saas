/**
 * Branch coverage for the shared mutation helpers.
 *
 * `extractMutationError` is the single funnel every mutation
 * surface uses to turn an arbitrary thrown value into a string the
 * user sees — its branch table (Error / string / object-with-error
 * / object-with-message / object-with-non-string / fallback) is the
 * contract. `optimisticListUpdate` is the generic React Query
 * optimistic patcher; the present/absent-cache branch is the risk.
 */
import { QueryClient } from '@tanstack/react-query';
import {
    extractMutationError,
    optimisticListUpdate,
} from '@/lib/mutations';

describe('extractMutationError', () => {
    it('returns the message of an Error instance', () => {
        expect(extractMutationError(new Error('boom'))).toBe('boom');
    });

    it('returns a thrown string verbatim', () => {
        expect(extractMutationError('plain failure')).toBe('plain failure');
    });

    it('reads the `error` field of an object', () => {
        expect(extractMutationError({ error: 'server said no' })).toBe(
            'server said no',
        );
    });

    it('falls back to the `message` field when `error` is absent', () => {
        expect(extractMutationError({ message: 'message field' })).toBe(
            'message field',
        );
    });

    it('prefers `error` over `message` when both are present', () => {
        expect(
            extractMutationError({ error: 'E', message: 'M' }),
        ).toBe('E');
    });

    it('JSON-stringifies a non-string `error` value', () => {
        expect(
            extractMutationError({ error: { code: 'X', detail: 'y' } }),
        ).toBe(JSON.stringify({ code: 'X', detail: 'y' }));
    });

    it('uses the default fallback for an object with neither field', () => {
        expect(extractMutationError({ unrelated: 1 })).toBe(
            'An error occurred',
        );
    });

    it('honours a custom fallback for an object with neither field', () => {
        expect(extractMutationError({}, 'custom fallback')).toBe(
            'custom fallback',
        );
    });

    it('uses the fallback for null', () => {
        expect(extractMutationError(null, 'nil fallback')).toBe(
            'nil fallback',
        );
    });

    it('uses the fallback for undefined', () => {
        expect(extractMutationError(undefined)).toBe('An error occurred');
    });

    it('uses the fallback for a bare number', () => {
        expect(extractMutationError(42, 'numeric')).toBe('numeric');
    });
});

describe('optimisticListUpdate', () => {
    interface Row {
        id: string;
        name: string;
        done?: boolean;
    }
    const KEY = ['practices', 'list'] as const;

    function makeClient(seed?: Row[]): QueryClient {
        const qc = new QueryClient();
        if (seed) qc.setQueryData<Row[]>(KEY, seed);
        return qc;
    }

    it('patches the matching item and leaves siblings untouched', () => {
        const seed: Row[] = [
            { id: 'a', name: 'Alpha' },
            { id: 'b', name: 'Bravo' },
        ];
        const qc = makeClient(seed);

        const previous = optimisticListUpdate<Row>(qc, KEY, 'b', {
            name: 'Bravo!',
            done: true,
        });

        // Returns the pre-mutation snapshot for rollback.
        expect(previous).toEqual(seed);

        const after = qc.getQueryData<Row[]>(KEY);
        expect(after).toEqual([
            { id: 'a', name: 'Alpha' },
            { id: 'b', name: 'Bravo!', done: true },
        ]);
    });

    it('returns undefined and writes nothing when the cache is empty', () => {
        const qc = makeClient(); // no seed → getQueryData returns undefined

        const previous = optimisticListUpdate<Row>(qc, KEY, 'a', {
            name: 'New',
        });

        expect(previous).toBeUndefined();
        expect(qc.getQueryData<Row[]>(KEY)).toBeUndefined();
    });

    it('is a no-op patch when no item id matches', () => {
        const seed: Row[] = [{ id: 'a', name: 'Alpha' }];
        const qc = makeClient(seed);

        optimisticListUpdate<Row>(qc, KEY, 'missing', { name: 'X' });

        expect(qc.getQueryData<Row[]>(KEY)).toEqual(seed);
    });
});
