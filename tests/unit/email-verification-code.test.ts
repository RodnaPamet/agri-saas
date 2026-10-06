/**
 * The 6-digit code primitive, whose whole design is "this credential is
 * guessable, so bound the guessing".
 *
 * These tests are mostly about the attempt counter, because that is the only
 * thing standing between a 10^6 keyspace and an attacker. The parts that
 * matter and are easy to get wrong:
 *
 *   * the counter is incremented by the DATABASE, not by reading and writing
 *     back — otherwise parallel guesses share one slot;
 *   * exhaustion DESTROYS the code, so the budget cannot be topped up by
 *     waiting for the honest user to request a new one;
 *   * a code is a STRING, so `012345` survives.
 */
const mockFindFirst = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockDeleteMany = jest.fn();
const mockCreate = jest.fn();
const mockTransaction = jest.fn(async (ops: unknown) => ops);

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        emailVerificationCode: {
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
            update: (...a: unknown[]) => mockUpdate(...a),
            delete: (...a: unknown[]) => mockDelete(...a),
            deleteMany: (...a: unknown[]) => mockDeleteMany(...a),
            create: (...a: unknown[]) => mockCreate(...a),
        },
        $transaction: (...a: unknown[]) => mockTransaction(...(a as [unknown])),
    },
}));

jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    hashForLookup: (s: string) => `H(${s})`,
    hashForLookupCandidates: (s: string) => [`H(${s})`],
}));

import crypto from 'node:crypto';
import {
    generateCode,
    verifyEmailVerificationCode,
    normaliseEmail,
    CODE_LENGTH,
    MAX_ATTEMPTS,
    CODE_TTL_MS,
} from '@/lib/auth/email-verification-code';

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const future = () => new Date(Date.now() + 60_000);

beforeEach(() => {
    jest.clearAllMocks();
    mockDelete.mockResolvedValue({});
    mockUpdate.mockResolvedValue({ attempts: 1 });
});

describe('generateCode', () => {
    it('is always exactly 6 digits, as a string', () => {
        for (let i = 0; i < 500; i++) {
            const c = generateCode();
            expect(typeof c).toBe('string');
            expect(c).toMatch(/^\d{6}$/);
            expect(c.length).toBe(CODE_LENGTH);
        }
    });

    it('produces leading-zero codes, which a number round-trip would destroy', () => {
        // Not a style point. `012345` is 1-in-10 of the keyspace; if any layer
        // turned a code into a number it would become `12345`, fail to verify,
        // and do so for exactly one user in ten with no signal why. Forcing
        // the issue with a stubbed RNG rather than waiting for luck.
        const spy = jest.spyOn(crypto, 'randomInt').mockReturnValue(42 as never);
        try {
            expect(generateCode()).toBe('000042');
        } finally {
            spy.mockRestore();
        }
    });

    it('draws uniformly — not via a biased modulo', () => {
        // `randomBytes(4) % 1000000` is the tempting one-liner and is biased
        // toward low values, because 2^32 is not a multiple of 10^6. The bias
        // is small but it sits exactly where a guesser starts. A chi-square
        // would be flaky in CI, so this asserts the MECHANISM: randomInt is
        // called with the full range, which is bias-free by construction.
        const spy = jest.spyOn(crypto, 'randomInt');
        generateCode();
        expect(spy).toHaveBeenCalledWith(0, 1_000_000);
        spy.mockRestore();
    });
});

describe('normaliseEmail', () => {
    it.each([
        ['  Ivan@Example.BG ', 'ivan@example.bg'],
        ['IVAN@EXAMPLE.BG', 'ivan@example.bg'],
        ['', ''],
    ])('%p → %p', (input, expected) => {
        expect(normaliseEmail(input)).toBe(expected);
    });
});

describe('verifyEmailVerificationCode', () => {
    it('accepts the right code and consumes it', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'c1',
            codeHash: sha('048212'),
            expiresAt: future(),
            attempts: 0,
        });
        await expect(verifyEmailVerificationCode('a@b.bg', '048212')).resolves.toEqual({ ok: true });
        // Single-use: a code that survived its own success would be replayable.
        expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });

    it('rejects a wrong code and counts the attempt via the DATABASE', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'c1',
            codeHash: sha('048212'),
            expiresAt: future(),
            attempts: 0,
        });
        mockUpdate.mockResolvedValue({ attempts: 1 });

        await expect(verifyEmailVerificationCode('a@b.bg', '000000')).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });

        // `{ increment: 1 }`, NOT `attempts: row.attempts + 1`. With a
        // read-then-write, N concurrent guesses all read `attempts: 0` and all
        // write `1` — consuming one slot between them, so the cap would bound
        // round trips rather than guesses.
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'c1' },
                data: { attempts: { increment: 1 } },
            }),
        );
    });

    it('DESTROYS the code when the attempts run out', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'c1',
            codeHash: sha('048212'),
            expiresAt: future(),
            attempts: MAX_ATTEMPTS - 1,
        });
        mockUpdate.mockResolvedValue({ attempts: MAX_ATTEMPTS });

        await expect(verifyEmailVerificationCode('a@b.bg', '000000')).resolves.toEqual({
            ok: false,
            reason: 'too_many_attempts',
        });
        // The destruction is the control, not the refusal. Refusing while
        // leaving the row alive would let an attacker keep guessing across the
        // honest user's reissues, making the cap a speed bump per code rather
        // than a wall.
        expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });

    it('refuses an already-exhausted code without spending another attempt', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'c1',
            codeHash: sha('048212'),
            expiresAt: future(),
            attempts: MAX_ATTEMPTS,
        });
        await expect(verifyEmailVerificationCode('a@b.bg', '048212')).resolves.toEqual({
            ok: false,
            reason: 'too_many_attempts',
        });
        expect(mockUpdate).not.toHaveBeenCalled();
        // Note: the CORRECT code is refused here. That is intended — once the
        // budget is gone the code is gone, and the user requests a new one.
    });

    it('rejects an expired code and removes it', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'c1',
            codeHash: sha('048212'),
            expiresAt: new Date(Date.now() - 1),
            attempts: 0,
        });
        await expect(verifyEmailVerificationCode('a@b.bg', '048212')).resolves.toEqual({
            ok: false,
            reason: 'expired',
        });
        expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });

    it('reports `invalid` when no code exists, without touching anything', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(verifyEmailVerificationCode('a@b.bg', '048212')).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });
        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it.each([
        ['empty code', 'a@b.bg', ''],
        ['empty email', '', '048212'],
    ])('%s is invalid before any query', async (_l, email, code) => {
        await expect(verifyEmailVerificationCode(email, code)).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });
        expect(mockFindFirst).not.toHaveBeenCalled();
    });
});

describe('the TTL is short, which is a property not a preference', () => {
    it('is minutes, not the link flow 24 hours', () => {
        // A code is typed from an open inbox during a signup in progress, so a
        // long life buys nothing and widens the guessing window. If someone
        // raises this to a day, they have turned a guessable credential into a
        // day-long one and this test is where they find out.
        expect(CODE_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000);
        expect(CODE_TTL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    });

    it('the attempt cap keeps one code well out of brute-force range', () => {
        // One code's exposure is MAX_ATTEMPTS in 10^CODE_LENGTH. Asserted as
        // the ratio rather than the two constants separately, so shortening
        // the code and raising the cap cannot each look locally reasonable
        // while together making the credential guessable.
        const keyspace = 10 ** CODE_LENGTH;
        expect(MAX_ATTEMPTS / keyspace).toBeLessThan(1e-4);
    });
});
