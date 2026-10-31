/**
 * `emitAnswer` — the behavioural half of the egress control (#2578).
 *
 * The guard counts construction sites; this asserts the BYTES. A secret must
 * not appear in anything sent, which is the only question that matters.
 */
import { emitAnswer } from '@/app-layer/ai/assistant/emit-answer';

// AWS's own published example key — a valid SHAPE that is not a credential.
// This comment does NOT spell it; `detect-secrets.sh` reads bytes and its
// marker is per line, so prose describes the value and never repeats it.
const AWS_EXAMPLE = 'AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret -- AWS's published example

const collect = (): { sent: string[]; send: (c: string) => void } => {
    const sent: string[] = [];
    return { sent, send: (c) => sent.push(c) };
};
const types = (sent: string[]): string[] =>
    sent.map((c) => (JSON.parse(c.replace(/^data: /, '').trim()) as { type: string }).type);

describe('emitAnswer (#2578)', () => {
    it('sends a clean answer, once', async () => {
        const { sent, send } = collect();
        const out = await emitAnswer(send, 'Поливайте рано сутрин.', { tenantId: 't1' });
        expect(out).toEqual({ sent: true, ruleIds: [] });
        expect(types(sent)).toEqual(['answer']);
        expect(sent[0]).toContain('Поливайте рано сутрин.');
    });

    it('a secret-shaped answer is DISCARDED, and appears in no byte sent', async () => {
        const { sent, send } = collect();
        const out = await emitAnswer(send, `Ключът е ${AWS_EXAMPLE}`, { tenantId: 't1' });
        expect(out.sent).toBe(false);
        expect(out.ruleIds.length).toBeGreaterThan(0);
        expect(types(sent)).toEqual(['refusal']);
        const raw = sent.join('');
        expect(raw).not.toContain(AWS_EXAMPLE);
        // Not even a recognisable prefix — a partly-shown credential is a
        // credential with a hint attached.
        expect(raw).not.toContain(AWS_EXAMPLE.slice(0, 8));
        // And the refusal still reads as a sentence, in Bulgarian.
        expect(raw).toMatch(/[Ѐ-ӿ]/);
    });

    it('the ruleIds it returns name RULES, never the matched text', async () => {
        const { send } = collect();
        const out = await emitAnswer(send, `x ${AWS_EXAMPLE} y`, { tenantId: 't1' });
        for (const id of out.ruleIds) {
            expect(id).not.toContain(AWS_EXAMPLE);
            expect(id).not.toContain(AWS_EXAMPLE.slice(0, 8));
        }
    });

    it('an empty or whitespace answer is no-grounding, not an empty bubble', async () => {
        for (const text of ['', '   ', '\n\t ']) {
            const { sent, send } = collect();
            const out = await emitAnswer(send, text, { tenantId: 't1' });
            expect(out.sent).toBe(false);
            expect(types(sent)).toEqual(['refusal']);
            expect(sent[0]).toContain('ASSISTANT_NO_GROUNDING');
        }
    });

    it('does NOT emit a terminal event — ending a turn belongs to the caller', async () => {
        // Burying `done` here is how a stream ends twice.
        const { sent, send } = collect();
        await emitAnswer(send, 'ок', { tenantId: 't1' });
        expect(types(sent)).not.toContain('done');
    });
});
