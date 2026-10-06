/**
 * ЕИК and ЕГН — the shared identifier contract (P3.2).
 *
 * ── how this avoids being circular ──
 *
 * The obvious test is "here are some valid ЕИК, assert they validate" — but any
 * vector I can produce comes from the same algorithm under test, so it proves
 * the module agrees with itself. If the weights are wrong, the vectors are
 * wrong in the same way and everything passes.
 *
 * Three things are done instead, none of which depends on my weights being
 * right:
 *
 *  1. **An independent re-implementation**, written out longhand below from the
 *     БУЛСТАТ rules rather than calling the module's shared `mod11` helper.
 *     Vectors are generated from THAT and checked against the module, so a
 *     refactor that breaks one and not the other is caught.
 *  2. **Digit uniqueness** — for any 8-digit prefix, at most one of the ten
 *     possible check digits may validate. A validator that is too permissive
 *     (`return true`, a missing mod, a wrong fallback that admits two answers)
 *     fails this without needing to know the right answer.
 *  3. **A rejection floor** — random digit strings must overwhelmingly fail.
 *     This is what a `return true` dies on.
 *
 * What none of it proves is conformance to the published standard. That needs
 * one real ЕИК checked against Търговския регистър by a person, and the iOS
 * side implementing from the standard rather than from these vectors. Both are
 * stated in the module docblock; this is the matching note.
 */
import {
    isValidEik,
    looksLikeEgn,
    classifyEikInput,
} from '@/lib/bg-identifiers';

// ── the independent implementation ────────────────────────────────────
// Deliberately longhand and deliberately not sharing the module's helper.

/** Check digit for the 9-digit base, per БУЛСТАТ. */
function eik9Check(first8: number[]): number {
    let s = 0;
    for (let i = 0; i < 8; i++) s += first8[i] * (i + 1); // weights 1..8
    let r = s % 11;
    if (r !== 10) return r;
    s = 0;
    for (let i = 0; i < 8; i++) s += first8[i] * (i + 3); // weights 3..10
    r = s % 11;
    return r === 10 ? 0 : r;
}

/** Check digit for the 13-digit extension. */
function eik13Check(d9to12: number[]): number {
    const w1 = [2, 7, 3, 5];
    const w2 = [4, 9, 5, 7];
    let s = 0;
    for (let i = 0; i < 4; i++) s += d9to12[i] * w1[i];
    let r = s % 11;
    if (r !== 10) return r;
    s = 0;
    for (let i = 0; i < 4; i++) s += d9to12[i] * w2[i];
    r = s % 11;
    return r === 10 ? 0 : r;
}

/** Build a valid 9-digit ЕИК from an 8-digit prefix. */
const eik9 = (prefix: string) => prefix + String(eik9Check([...prefix].map(Number)));

/**
 * Extend a valid 9-digit ЕИК to a valid 13-digit one.
 *
 * 9 base digits + THREE sub-unit digits + one check digit = 13. The check is
 * computed over four values — the base's own 9th digit plus the three sub-unit
 * digits — not over the sub-unit alone. The first draft of this helper passed
 * four sub-unit digits and built a 14-character string, which is exactly the
 * kind of off-by-one the independent implementation exists to surface.
 */
const eik13 = (base9: string, sub3: string) => {
    const input = [Number(base9[8]), ...[...sub3].map(Number)];
    return base9 + sub3 + String(eik13Check(input));
};

/** Build a valid ЕГН from its first nine digits. */
function egn(first9: string): string {
    const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
    const s = [...first9].map(Number).reduce((a, d, i) => a + d * w[i], 0);
    const r = s % 11;
    return first9 + String(r === 10 ? 0 : r);
}

describe('ЕИК — structural validity', () => {
    const prefixes = ['12345678', '83125426', '00000001', '99999999', '10203040'];

    it.each(prefixes)('accepts a 9-digit ЕИК built from %s', (p) => {
        expect(isValidEik(eik9(p))).toBe(true);
    });

    it('accepts a 13-digit ЕИК whose 9-digit base is valid', () => {
        expect(isValidEik(eik13(eik9('83125426'), '001'))).toBe(true);
    });

    it('REFUSES a 13-digit code whose base nine are invalid', () => {
        // Not "a branch of something unknown" — a typo. The base must hold.
        const badBase = '831254260'; // last digit deliberately wrong
        expect(isValidEik(badBase)).toBe(false);
        expect(isValidEik(eik13(badBase, '001'))).toBe(false);
    });

    it('for any prefix, AT MOST ONE check digit validates', () => {
        // The property that kills a too-permissive validator without needing to
        // know the right answer. A `return true`, a dropped mod, or a fallback
        // that admits a second answer all fail here.
        for (const p of prefixes) {
            const accepted = [...'0123456789'].filter((d) => isValidEik(p + d));
            expect(accepted).toHaveLength(1);
            expect(accepted[0]).toBe(String(eik9Check([...p].map(Number))));
        }
    });

    it('rejects the overwhelming majority of random 9-digit strings', () => {
        // ~1 in 11 should pass. A validator that passes most inputs is not
        // validating. Deterministic input, no RNG — a flaky guard is worse than
        // none.
        let pass = 0;
        const N = 2000;
        for (let i = 0; i < N; i++) {
            pass += isValidEik(String(100000000 + i * 7)) ? 1 : 0;
        }
        expect(pass).toBeGreaterThan(0);          // it is not `return false`
        expect(pass).toBeLessThan(N * 0.2);       // nor `return true`
    });

    it.each([
        ['', 'empty'],
        ['12345', 'too short'],
        ['1234567890', '10 digits — that length is an ЕГН, not an ЕИК'],
        ['12345678901234', '14 digits'],
        ['8312542 6', 'embedded space'],
        ['BG831254261', 'VAT prefix — strip it before calling'],
        ['abcdefghi', 'not digits'],
    ])('refuses %p (%s)', (v) => {
        expect(isValidEik(v)).toBe(false);
    });
});

describe('ЕГН — detected so it can be REFUSED', () => {
    it.each([
        ['7523169263', 'month 75 → 1800s (75-20=55? no: >40 → 2000s)'],
        ['8001010000', 'January 1980'],
        ['0041010000', 'month 41 → January 2000'],
    ])('recognises %s', (first9or10) => {
        expect(looksLikeEgn(egn(first9or10.slice(0, 9)))).toBe(true);
    });

    it('requires the checksum, not merely ten digits', () => {
        const good = egn('800101000');
        const bad = good.slice(0, 9) + String((Number(good[9]) + 1) % 10);
        expect(looksLikeEgn(good)).toBe(true);
        expect(looksLikeEgn(bad)).toBe(false);
    });

    it('requires a DECODABLE date, so a mistyped ЕИК is not called an ЕГН', () => {
        // Ten digits with a valid mod-11 check but month 77 is far more likely
        // a typo than a personal number, and calling it an ЕГН sends the user
        // the wrong error entirely.
        const impossible = egn('997701000'); // month 77 → 37 after -40
        expect(impossible).toHaveLength(10);
        expect(looksLikeEgn(impossible)).toBe(false);
    });

    it('decodes all three century offsets', () => {
        expect(looksLikeEgn(egn('801201000'))).toBe(true); // 12 → 1900s
        expect(looksLikeEgn(egn('805201000'))).toBe(true); // 52 → 2000s (-40)
        expect(looksLikeEgn(egn('803201000'))).toBe(true); // 32 → 1800s (-20)
    });

    it('is not fooled by an ЕИК', () => {
        expect(looksLikeEgn(eik9('83125426'))).toBe(false);
    });
});

describe('classifyEikInput — one answer per input', () => {
    it('a valid ЕИК is VALID', () => {
        expect(classifyEikInput(eik9('83125426'))).toBe('VALID');
    });

    it('an ЕГН typed into the ЕИК field is named, not just rejected', () => {
        // The whole reason the detector exists. Without it this is INVALID and
        // the user is told "that is not an ЕИК" while staring at a number they
        // know is theirs.
        expect(classifyEikInput(egn('800101000'))).toBe('LOOKS_LIKE_EGN');
    });

    it('anything else is INVALID', () => {
        expect(classifyEikInput('12345')).toBe('INVALID');
        expect(classifyEikInput('')).toBe('INVALID');
    });

    it('the two categories cannot overlap — they are different lengths', () => {
        // Provable disjointness rather than a precedence rule that could be got
        // wrong: ЕИК is 9 or 13 digits, ЕГН is exactly 10.
        for (const p of ['83125426', '12345678', '00000001']) {
            expect(looksLikeEgn(eik9(p))).toBe(false);
        }
        expect(isValidEik(egn('800101000'))).toBe(false);
    });
});
