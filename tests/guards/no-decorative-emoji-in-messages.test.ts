/**
 * Roadmap-4 PR-2 — decorative emoji subtraction.
 *
 * The i18n message catalogues (`messages/*.json`) had accreted
 * decorative emoji prefixes on user-facing copy:
 *
 *   "exportReports": "📈 Export Reports"
 *   "heatmap":       "🗺️ Heatmap"
 *   "approveEvidence": "✅ Approve"
 *   "rejectEvidence":  "❌ Reject"
 *   …16 more in en.json, 29 in bg.json
 *
 * Two costs:
 *
 *   1. Visual noise. The buttons + headings these strings render
 *      into already carry icons in their component slots
 *      (`<Button icon={<Plus />}>`, `<HeroIcon name="map" />`).
 *      The emoji prefix is a SECOND icon, rendered as text — and
 *      a less consistent one, since the text emoji renders
 *      differently across platforms (system font dependency).
 *
 *   2. Tone. A compliance product reads as serious software when
 *      labels say "Approve" / "Reject"; less so when they say
 *      "✅ Approve" / "❌ Reject". The emoji collapses the
 *      semantic into a sticker.
 *
 * What this ratchet locks
 *
 *   No string in any `messages/*.json` may contain a decorative
 *   emoji codepoint. The detector covers the three Unicode
 *   blocks where the drift came from:
 *
 *     • Miscellaneous Symbols and Pictographs (U+1F300–U+1F9FF)
 *     • Miscellaneous Symbols (U+2600–U+26FF)
 *     • Dingbats (U+2700–U+27BF)
 *
 *   Plus a handful of stragglers that fall outside those blocks
 *   but acted as drift drivers: ✅ ❌ ➕ ✓ ✗.
 *
 * What this ratchet does NOT police
 *
 *   - Source code outside `messages/` (notification email
 *     templates in `src/app-layer/notifications/*.ts` legitimately
 *     use emoji urgency markers — email clients render emoji
 *     consistently and the urgency convention is established).
 *
 *   - Code-comment doc bullets (✓ / ✗ in JSDoc capability lists).
 *     These never reach a user.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const MESSAGES_DIR = path.join(ROOT, 'messages');

// Detector — covers the three Unicode blocks plus the stragglers
// that drove drift. Order doesn't matter; the test just needs to
// fire on any one of them.
const EMOJI_RE =
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2705}\u{274C}\u{2795}\u{2713}\u{2717}]/u;

interface Offence {
    file: string;
    key: string;
    value: string;
}

function walk(obj: unknown, file: string, prefix: string, into: Offence[]) {
    if (typeof obj === 'string') {
        if (EMOJI_RE.test(obj)) {
            into.push({ file, key: prefix, value: obj });
        }
        return;
    }
    if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            walk(v, file, prefix ? `${prefix}.${k}` : k, into);
        }
    }
}

describe('No decorative emoji in messages (Roadmap-4 PR-2)', () => {
    /**
     * CONTROL for `walk` — it had NO TEETH (survived all nine guts).
     *
     * `walk` returns nothing; it PUSHES into the `offences` array handed to
     * it. Gut its body to any constant and it pushes nothing, `offences`
     * stays empty, and the guard reports no decorative emoji having inspected
     * no keys at all — the void-collector form of empty-selection-is-a-pass
     * (#971). A return-value assertion cannot reach it, so the control has to
     * observe the SIDE EFFECT.
     */
    it('control: walk collects a planted emoji from a nested catalogue', () => {
        // Recursion matters: the real catalogues nest several levels, so a
        // walker that only reads the top object would miss almost everything.
        const into: Offence[] = [];
        walk(
            { a: { b: { c: 'Harvest complete \u{1F389}' } }, plain: 'no emoji here' },
            'synthetic.json',
            '',
            into,
        );
        expect(into).toHaveLength(1);
        expect(into[0].key).toBe('a.b.c');
        expect(into[0].file).toBe('synthetic.json');

        // ...and it does NOT flag ordinary copy.
        const clean: Offence[] = [];
        walk({ x: 'Plain text', y: { z: 'Also plain' } }, 'f.json', '', clean);
        expect(clean).toHaveLength(0);

        // Grounded: the real catalogues are non-trivial, so "no offences"
        // is a judgement over real keys rather than an empty traversal.
        const seen: Offence[] = [];
        const probe = JSON.parse(
            fs.readFileSync(
                path.join(MESSAGES_DIR, fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'))[0]),
                'utf-8',
            ),
        );
        let keyCount = 0;
        const count = (o: unknown): void => {
            if (o && typeof o === 'object') {
                for (const v of Object.values(o as Record<string, unknown>)) count(v);
            } else keyCount += 1;
        };
        count(probe);
        expect(keyCount).toBeGreaterThan(500);
        walk({ deep: { emoji: '\u{2705} done' } }, 'probe.json', '', seen);
        expect(seen).toHaveLength(1);
    });

    it('every messages/*.json is free of decorative emoji codepoints', () => {
        const files = fs
            .readdirSync(MESSAGES_DIR)
            .filter((f) => f.endsWith('.json'));
        const offences: Offence[] = [];
        for (const f of files) {
            const full = path.join(MESSAGES_DIR, f);
            const obj = JSON.parse(fs.readFileSync(full, 'utf-8'));
            walk(obj, f, '', offences);
        }
        if (offences.length > 0) {
            const lines = offences
                .map((o) => `  ${o.file}: ${o.key} = ${o.value}`)
                .join('\n');
            throw new Error(
                `Decorative emojis found in i18n message catalogues. Strip the emoji — the UI carries icons in component slots already.\n${lines}`,
            );
        }
        expect(offences).toEqual([]);
    });
});
