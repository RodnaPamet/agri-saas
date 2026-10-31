/**
 * The per-tenant «Документи» byte ceiling (#2495 Decision 3).
 *
 * The thing under test is a REFUSAL, and the reason its default lives in code
 * rather than in `env.ts` is that a `.default()` there would be inert in this
 * very file: `jest.setup.js` sets `SKIP_ENV_VALIDATION=1`, and `@t3-oss/env`
 * then skips zod entirely — no validation, no defaults (#2518). So a ceiling
 * declared `.default(2 * 1024 ** 3)` would read `undefined` here, and every
 * assertion below would be about a limit that only exists in production.
 *
 * The env override is driven through a Proxy over the real `env`, which is the
 * shape CLAUDE.md prescribes: `env` has ZERO own keys (measured —
 * `Object.keys(env).length === 0` while `env.DATABASE_URL` is a string), so
 * the obvious `{ ...actual.env, X }` spread produces an EMPTY env and every
 * variable in the process reads undefined.
 */
let override: number | undefined;

jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get(target, prop) {
                if (prop === 'DOCUMENT_STORAGE_LIMIT_BYTES') return override;
                return target[prop as string];
            },
        }),
    };
});

import {
    assertDocumentStorageBudget,
    documentStorageLimitBytes,
    DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES,
} from '@/app-layer/documents/budget';

const GIB = 1024 * 1024 * 1024;

beforeEach(() => {
    override = undefined;
});

describe('the ceiling in force', () => {
    it('is 2 GiB when nothing is configured — the owner ruling, and a real value under test', () => {
        expect(DEFAULT_DOCUMENT_STORAGE_LIMIT_BYTES).toBe(2 * GIB);
        expect(documentStorageLimitBytes()).toBe(2 * GIB);
    });

    it('honours an env override', () => {
        override = 5 * GIB;
        expect(documentStorageLimitBytes()).toBe(5 * GIB);
    });

    it.each([
        [0, 'zero would refuse the very first upload'],
        [-1, 'negative is not a ceiling'],
        [Number.NaN, 'NaN compares false against everything, so every upload would pass'],
        [Number.POSITIVE_INFINITY, 'an infinite ceiling is no ceiling'],
    ])('falls back to the default for %p (%s)', (bad) => {
        override = bad as number;
        expect(documentStorageLimitBytes()).toBe(2 * GIB);
    });

    it('the zod schema would reject those too — but it does not run here', () => {
        // `z.coerce.number().int().positive()` refuses 0 and -1 WHERE IT RUNS.
        // Under SKIP_ENV_VALIDATION it does not run at all, which is why the
        // check above is repeated in code rather than assumed. This test exists
        // to stop someone deleting that repetition as redundant.
        override = 0;
        expect(documentStorageLimitBytes()).toBeGreaterThan(0);
    });
});

describe('the refusal', () => {
    it('admits an upload that lands exactly ON the ceiling', () => {
        // `>` and not `>=`: a farm whose documents sum to exactly its limit has
        // used its allowance, not exceeded it, and refusing the file that
        // reaches the line would make the ceiling one byte lower than stated.
        expect(() => assertDocumentStorageBudget(2 * GIB - 100, 100)).not.toThrow();
    });

    it('refuses the upload that would cross it, by one byte', () => {
        expect(() => assertDocumentStorageBudget(2 * GIB - 100, 101)).toThrow();
    });

    it('counts the INCOMING bytes, so the refusal happens before they land', () => {
        // The whole point of a disk ceiling. A check that ignored
        // `incomingBytes` would admit a 3 GiB file into an empty farm and
        // report the overflow afterwards.
        expect(() => assertDocumentStorageBudget(0, 3 * GIB)).toThrow();
    });

    it('carries the code and the three numbers, and authors no sentence about them', () => {
        let caught: unknown;
        try {
            assertDocumentStorageBudget(2 * GIB, 1);
        } catch (err) {
            caught = err;
        }
        expect(caught).toMatchObject({
            code: 'DOCUMENT_STORAGE_FULL',
            params: {
                usedBytes: String(2 * GIB),
                limitBytes: String(2 * GIB),
                incomingBytes: '1',
            },
        });
        // The numbers are params, not prose: the client renders «1,9 GB от
        // 2 GB» itself, and iOS and the web may phrase it differently.
        expect(JSON.stringify(caught)).not.toMatch(/GB|ГБ/);
    });

    it('returns the usage it checked, so a caller need not recompute it', () => {
        expect(assertDocumentStorageBudget(10, 5)).toEqual({
            usedBytes: 10,
            limitBytes: 2 * GIB,
        });
    });

    it('an override moves the refusal boundary with it', () => {
        override = 1024;
        expect(() => assertDocumentStorageBudget(1000, 24)).not.toThrow();
        expect(() => assertDocumentStorageBudget(1000, 25)).toThrow();
    });
});
