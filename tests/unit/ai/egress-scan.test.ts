/**
 * The outbound scan for the assistant's answers — #2578.
 *
 * Executes the real scanner against the real generated pattern set. The
 * assertion that matters most is the NEGATIVE one: the verdict must never
 * carry the matched text, because the caller logs the verdict.
 */
import { EGRESS_PATTERN_COUNT, scanEgress } from '@/app-layer/ai/safety/egress-scan';

// A syntactically valid AWS key id that is not a credential — the shape is the
// point, and the value below is AWS's own published documentation example.
//
// The prose deliberately does NOT repeat the literal. `detect-secrets.sh` reads
// BYTES, so a comment discussing a key is a hit the same as a key, and the
// allowlist marker is per LINE — which is the hook refusing this very commit
// until the second spelling went away. One occurrence, one pragma, one reason.
const AWS_EXAMPLE = 'AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret -- AWS's published example

describe('egress scan (#2578)', () => {
    it('ranges over a real pattern set', () => {
        // An empty set reports every scan clean, so the count is the
        // denominator every assertion below depends on.
        console.log(`[egress-scan] ${EGRESS_PATTERN_COUNT} live pattern(s)`);
        expect(EGRESS_PATTERN_COUNT).toBeGreaterThanOrEqual(10);
    });

    it('passes an ordinary Bulgarian answer', () => {
        // The false-alarm direction, and it is the one that would kill the
        // feature: a control that refuses real answers gets turned off.
        const answers = [
            'Нива 4 няма почвена проба от 2024 г. Добивът е 5.2 т/дка.',
            'Имате 3 задачи за тази седмица: торене, оран и пръскане.',
            'Средната цена на пшеницата е 420 лв/т, с 4% повече от миналия месец.',
            'Разходите за дка са 180 лв, от които 95 лв за торове.',
        ];
        for (const text of answers) {
            expect({ text: text.slice(0, 24), verdict: scanEgress(text) }).toEqual({
                text: text.slice(0, 24),
                verdict: { clean: true, ruleIds: [] },
            });
        }
    });

    it('catches secret-shaped material in an answer', () => {
        const verdict = scanEgress(`Ключът е ${AWS_EXAMPLE} — използвайте го.`);
        expect(verdict.clean).toBe(false);
        expect(verdict.ruleIds.length).toBeGreaterThan(0);
    });

    it('NEVER returns the matched text — only rule names', () => {
        // The caller logs this verdict. A verdict carrying the match would move
        // the secret from one place it should not be to another with a longer
        // retention, which is the opposite of the control's purpose.
        const verdict = scanEgress(`token: ${AWS_EXAMPLE}`);
        expect(verdict.clean).toBe(false);
        const serialised = JSON.stringify(verdict);
        expect(serialised).not.toContain(AWS_EXAMPLE);
        // And not a fragment of it either — a truncated secret is still a clue.
        expect(serialised).not.toContain(AWS_EXAMPLE.slice(0, 8));
        // What it DOES carry is a name a reader can look up in `.secret-patterns`.
        expect(verdict.ruleIds.every((r) => r.length > 0 && !r.includes(AWS_EXAMPLE))).toBe(true);
    });

    it('is stateless across calls — no g flag, no lastIndex drift', () => {
        // A module-level global regex keeps `lastIndex` between calls and would
        // skip matches on alternate scans, so the control would work
        // intermittently. Scanning the same text twice must agree.
        const text = `key=${AWS_EXAMPLE}`;
        const first = scanEgress(text);
        const second = scanEgress(text);
        expect(second).toEqual(first);
        expect(first.clean).toBe(false);
        // And a clean scan between two dirty ones must not disturb them.
        expect(scanEgress('Нива 4 е засята.').clean).toBe(true);
        expect(scanEgress(text)).toEqual(first);
    });
});
