/**
 * `capabilities.documentStorage` reports a BAND, and that is a disclosure
 * property rather than a formatting preference (#2495 step 3).
 *
 * `/api/readyz` is the GCP uptime check's target, probed unauthenticated from
 * six regions every 60 seconds. Anything this capability returns is therefore
 * public — so the exact number of bytes the business stores must not be in
 * it. The band preserves the only thing an operator acts on (a threshold
 * crossing) and discloses nothing finer.
 *
 * Two failure directions, and they are not symmetric:
 *
 *   - **Reporting the figure** leaks business volume to anyone who curls the
 *     endpoint. Silent, permanent, and invisible in a green build.
 *   - **Reporting a band on a FAILED read** says "plenty of room" during a
 *     database incident, which is the alarming direction being wrong in the
 *     reassuring way. Hence `unknown` as a fourth state, the same shape
 *     `capabilities.platformConsole` carries for the same reason.
 *
 * The query is also asserted here, because this sum is deployment-wide and
 * unscoped by design — an operator signal about the DISK. A sum that quietly
 * started counting every `FileRecord` in the deployment would still produce a
 * plausible band, so the `domain` and `status` filters are part of the
 * contract rather than an implementation detail.
 */
import {
    documentStorageCapability,
    type DocumentStorageReader,
} from '@/lib/documents/storage-capability';
import { documentStorageLimitBytes } from '@/app-layer/documents/budget';

const GB = 1024 ** 3;

/** A reader that answers one SUM row, recording the query it was given. */
function readerReturning(total: bigint | number | null): {
    db: DocumentStorageReader;
    queries: string[];
} {
    const queries: string[] = [];
    return {
        queries,
        db: {
            $queryRawUnsafe: async <T>(query: string): Promise<T> => {
                queries.push(query);
                return [{ total }] as unknown as T;
            },
        },
    };
}

describe('documentStorageCapability', () => {
    it('reports unknown — never a band — when there is no client', async () => {
        const result = await documentStorageCapability(null);
        expect(result.band).toBe('unknown');
        // The limit is configuration, not a reading, so it survives a failed
        // read: an operator still needs to know what the ceiling IS.
        expect(result.perTenantLimitBytes).toBe(documentStorageLimitBytes());
    });

    it('reports unknown when the read THROWS, and not the smallest band', async () => {
        const db: DocumentStorageReader = {
            $queryRawUnsafe: async () => {
                throw new Error('connection terminated');
            },
        };
        const result = await documentStorageCapability(db);
        expect(result.band).toBe('unknown');
        // The load-bearing half: a database incident must not read as "plenty
        // of room". Asserting `unknown` alone would pass if the fallback were
        // changed to the smallest band only on SOME paths.
        expect(result.band).not.toBe('under_1gb');
    });

    it('buckets a total into its band', async () => {
        for (const [bytes, band] of [
            [0, 'under_1gb'],
            [500 * 1024 * 1024, 'under_1gb'],
            [2 * GB, '1_5gb'],
            [9 * GB, '5_20gb'],
            [40 * GB, 'over_20gb'],
        ] as const) {
            const { db } = readerReturning(bytes);
            await expect(documentStorageCapability(db)).resolves.toMatchObject({ band });
        }
    });

    it('resolves a boundary to the HIGHER band', async () => {
        // A farm exactly at a threshold has crossed it. The other direction
        // would report the quieter band on the exact value an operator set an
        // expectation against.
        for (const [bytes, band] of [
            [1 * GB, '1_5gb'],
            [5 * GB, '5_20gb'],
            [20 * GB, 'over_20gb'],
        ] as const) {
            const { db } = readerReturning(bytes);
            await expect(documentStorageCapability(db)).resolves.toMatchObject({ band });
        }
    });

    it('handles the bigint a ::bigint cast returns, and a NULL empty table', async () => {
        // `SUM()` over no rows is NULL, and the `::bigint` cast arrives as a
        // JS BigInt — which `Number.isFinite` rejects, so an unconverted
        // value would fall into the broken-read arm and report over_20gb on
        // an EMPTY deployment.
        await expect(documentStorageCapability(readerReturning(BigInt(2 * GB)).db)).resolves
            .toMatchObject({ band: '1_5gb' });
        await expect(documentStorageCapability(readerReturning(null).db)).resolves
            .toMatchObject({ band: 'under_1gb' });
    });

    it('never puts the byte total in the payload', async () => {
        // The disclosure assertion. A distinctive total, then a search of the
        // WHOLE serialised capability for it — so adding a `usedBytes` field,
        // or widening the band to carry its input, fails here rather than in
        // review.
        const distinctive = 7_777_777_777;
        const { db } = readerReturning(distinctive);
        const result = await documentStorageCapability(db);

        expect(JSON.stringify(result)).not.toContain(String(distinctive));
        expect(Object.values(result)).not.toContain(distinctive);
        // And the band is a label, not a figure dressed as one.
        expect(result.band).not.toMatch(/^[0-9]+$/);
    });

    it('sums only STORED document bytes, deployment-wide', async () => {
        const { db, queries } = readerReturning(0);
        await documentStorageCapability(db);

        expect(queries).toHaveLength(1);
        const sql = queries[0].replace(/\s+/g, ' ');
        expect(sql).toContain('"FileRecord"');
        expect(sql).toContain("\"domain\" = 'documents'");
        expect(sql).toContain("\"status\" = 'STORED'");
        // Unscoped BY DESIGN: this is a disk signal, not a farm's quota. A
        // tenant filter here would make the band meaningless as an operator
        // reading, so its absence is asserted rather than assumed.
        expect(sql).not.toContain('tenantId');
    });
});
