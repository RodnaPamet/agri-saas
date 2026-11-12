/**
 * The cumulative-prefix egress gate — #2670 item 4.
 *
 * The property this file exists for: **no complete pattern match is ever
 * released**, however the answer is chunked. Everything else here supports
 * that claim or bounds it honestly.
 *
 * The population is the REAL pattern set, so a new secret pattern with no
 * declared sample fails `every pattern has a sample` — the forcing function
 * the design needs, because soundness is a property of today's patterns
 * rather than of the gate.
 */
import { SECRET_PATTERNS } from '@/lib/security/generated/secret-patterns';
import { scanEgress, EGRESS_PATTERN_COUNT } from '@/app-layer/ai/safety/egress-scan';
import { createPrefixReleaser } from '@/app-layer/ai/safety/prefix-release';
import {
    EGRESS_SAMPLES as SAMPLES,
    SPLIT_ASSIGNMENT_SAMPLES,
} from '../../fixtures/secrets/egress-samples';

/** Feed `text` to a fresh releaser in `size`-byte chunks; collect what escaped. */
function streamIn(text: string, size: number): { released: string; refused: boolean } {
    const r = createPrefixReleaser();
    let released = '';
    let refused = false;
    for (let i = 0; i < text.length; i += size) {
        const step = r.push(text.slice(i, i + size));
        released += step.release;
        if (!step.verdict.clean) refused = true;
    }
    const last = r.finish();
    released += last.release;
    if (!last.verdict.clean) refused = true;
    return { released, refused };
}

describe('the sample set covers the real pattern population', () => {
    it('every pattern has a sample, and every sample matches its pattern', () => {
        const missing = SECRET_PATTERNS.filter((p) => !(p.name in SAMPLES)).map((p) => p.name);
        expect(missing).toEqual([]);
        // A sample that does not match is worse than none: every row below
        // would read "clean" and the suite would prove nothing. This is the
        // positive control the owner's first probe of this class lacked.
        for (const p of SECRET_PATTERNS) {
            const re = new RegExp(p.source, p.flags);
            expect(re.test(SAMPLES[p.name])).toBe(true);
        }
    });

    it('prints its denominator', () => {
        console.log(
            `[prefix-release] ${SECRET_PATTERNS.length} pattern(s), `
                + `${Object.keys(SAMPLES).length} sample(s), `
                + `EGRESS_PATTERN_COUNT=${EGRESS_PATTERN_COUNT}`,
        );
        expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    });
});

describe('THE PROPERTY: no complete match is ever released', () => {
    const CHUNKS = [1, 3, 13, 10000];
    for (const p of SECRET_PATTERNS) {
        for (const size of CHUNKS) {
            it(`${p.name} @ ${size}B chunks`, () => {
                const answer = `Ето обобщението. ${SAMPLES[p.name]} Това е всичко.`;
                const { released, refused } = streamIn(answer, size);
                // The property. Not "it refused" — what matters is that the
                // bytes which escaped carry no complete match.
                expect(scanEgress(released).clean).toBe(true);
                expect(refused).toBe(true);
            });
        }
    }
});

describe('a clean answer streams in full', () => {
    it('releases every byte, and nothing is lost or duplicated', () => {
        const answer = 'Първо изречение. Второ изречение! Трето?\nИ ред накрая.';
        for (const size of [1, 5, 1000]) {
            const { released, refused } = streamIn(answer, size);
            expect(refused).toBe(false);
            // The strong form: byte-for-byte, not merely "contains".
            expect(released).toBe(answer);
        }
    });

    it('holds back an incomplete trailing sentence until it completes', () => {
        const r = createPrefixReleaser();
        expect(r.push('Готово. ').release).toBe('Готово. ');
        expect(r.push('Още не').release).toBe('');
        expect(r.push(' е готово').release).toBe('');
        expect(r.push('. ').release).toBe('Още не е готово. ');
        expect(r.releasedLength()).toBe(r.full().length);
    });

    it('finish() flushes a tail with no terminator at all', () => {
        const r = createPrefixReleaser();
        r.push('Без точка накрая');
        expect(r.finish().release).toBe('Без точка накрая');
    });
});

describe('cumulative beats per-sentence on the split-assignment class', () => {
    it.each(SPLIT_ASSIGNMENT_SAMPLES)('catches a value on the line AFTER its name', (secret) => {
        // Scanned a LINE at a time this is missed entirely — the defect that
        // makes the gate cumulative. Executable rather than a docblock claim.
        const perLineMisses = secret.split('\n').every((line) => scanEgress(line).clean);
        expect(perLineMisses).toBe(true);

        const { released, refused } = streamIn(`Ето. ${secret} Край.`, 3);
        expect(refused).toBe(true);
        expect(scanEgress(released).clean).toBe(true);
    });
});

describe('a dirty verdict is TERMINAL', () => {
    it('stops releasing for the rest of the answer', () => {
        const r = createPrefixReleaser();
        expect(r.push('Чисто изречение. ').release).toBe('Чисто изречение. ');
        const bad = r.push(`${SAMPLES['Anthropic API Key']} `);
        expect(bad.verdict.clean).toBe(false);
        expect(bad.release).toBe('');
        // Text already sent cannot be recalled, so appending to a dirty answer
        // would send more of it. Everything after is refused, including text
        // that would be clean on its own.
        const after = r.push('Съвсем безобидно изречение. ');
        expect(after.release).toBe('');
        expect(after.verdict.clean).toBe(false);
        expect(r.finish().release).toBe('');
    });

    it('names the rule that fired, so the refusal is diagnosable', () => {
        const r = createPrefixReleaser();
        const step = r.push(`${SAMPLES['GitHub Token']} `);
        expect(step.verdict.clean).toBe(false);
        expect(step.verdict.ruleIds).toContain('GitHub Token');
    });
});

describe('the honest residual', () => {
    it('a released sentence CAN contain a partial token — bounded, and stated', () => {
        // Detection needs the complete token, so a sentence ending mid-token
        // can be released. This is the weakening versus "the whole answer was
        // scanned clean", asserted rather than left for a reader to discover.
        const r = createPrefixReleaser();
        const step = r.push('Ключът е sk-ant-abcdefghij. ');
        expect(step.verdict.clean).toBe(true);
        expect(step.release).toContain('sk-ant-abcdefghij');
        // Not a usable credential: the pattern needs 40+ body chars, so what
        // escaped is strictly shorter than any key it could match.
        expect(scanEgress(step.release).clean).toBe(true);
    });
});

describe('observe() — the shape the routing layer can supply', () => {
    it('releases the same text as push() for the same stream', () => {
        const answer = 'Първо изречение. Второ изречение. Трето изречение.';
        const byDelta = createPrefixReleaser();
        const byAbsolute = createPrefixReleaser();
        let a = '';
        let b = '';
        let soFar = '';
        for (const ch of answer) {
            a += byDelta.push(ch).release;
            soFar += ch;
            b += byAbsolute.observe(soFar).release;
        }
        a += byDelta.finish().release;
        b += byAbsolute.finish().release;
        // The two paths must not disagree: one is fed increments and the other
        // absolute text, and a divergence would mean the streamed answer
        // depends on which layer happened to call it.
        expect(b).toBe(a);
        expect(b).toBe(answer);
    });

    it('treats a SHORTER cumulative as a retry, and does not re-release', () => {
        const r = createPrefixReleaser();
        const first = r.observe('Първо изречение. Второ изречение. ');
        expect(first.release).toBe('Първо изречение. Второ изречение. ');
        expect(first.restarted).toBe(false);

        // `completeWithRouting` retried: the second attempt's text starts over.
        const retry = r.observe('Първо ');
        expect(retry.restarted).toBe(true);
        expect(retry.release).toBe('');

        // And the attempt that completes releases its own text ONCE, rather
        // than appending to what the abandoned attempt had already sent.
        const done = r.observe('Първо изречение. Различно второ. ');
        expect(done.restarted).toBe(false);
        expect(done.release).toBe('Първо изречение. Различно второ. ');
        expect(r.full()).toBe('Първо изречение. Различно второ. ');
    });

    it('still refuses a secret that arrives via observe()', () => {
        // The property has to hold on this path too, or the redaction-driven
        // entry point would be the one that leaks.
        const r = createPrefixReleaser();
        const step = r.observe(`Ето. ${SAMPLES['Anthropic API Key']} Край.`);
        expect(step.verdict.clean).toBe(false);
        expect(step.release).toBe('');
    });
});
