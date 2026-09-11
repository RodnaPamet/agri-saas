/**
 * Roadmap-4 PR-3 — `<Eyebrow>` weight uniformity.
 *
 * The Eyebrow primitive renders with an intrinsic style:
 *
 *   block mb-1 text-xs font-semibold uppercase tracking-wider
 *   text-content-muted
 *
 * Five aspects are now LOCKED — no consumer should override them:
 *   • display       — block
 *   • bottom-margin — mb-1 (default; override only with another
 *                     spacing token, not raw values)
 *   • size          — text-xs
 *   • weight        — font-semibold
 *   • case          — uppercase
 *   • tracking      — tracking-wider
 *   • color         — text-content-muted (the canonical
 *                     secondary tone, per Roadmap-4 PR-1)
 *
 * What this ratchet bans on `<Eyebrow>` callsites
 *
 *   • text-{xs|sm|base|lg|xl|...} — size override.
 *   • font-{thin|light|normal|medium|semibold|bold|black} —
 *     weight override (a bare `font-semibold` would be redundant
 *     but harmless; a different weight is the real offence).
 *   • text-content-{emphasis|default|subtle} —
 *     tone override.
 *   • text-{gray|slate|neutral|zinc|stone}-N — raw palette grey
 *     (already banned by Roadmap-4 PR-1; this rule is the
 *     Eyebrow-specific reinforcement).
 *
 * What this ratchet does NOT police
 *
 *   • Layout overrides — `mb-N`, `mt-N`, `px-N`, `py-N`, `pt-N`,
 *     `pb-N`, `ml-N`, `mr-N`. The Eyebrow may sit in different
 *     spatial contexts (sidebar nav, card header, form field).
 *     The ratchet locks the typographic identity, not the
 *     position. Layout overrides remain legitimate.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const EYEBROW_OPEN_RE = /<Eyebrow\b[^>]*?className\s*=\s*["']([^"']+)["']/g;

const BANNED_PATTERNS: Array<{ rx: RegExp; label: string }> = [
    { rx: /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)\b/, label: 'size override' },
    {
        rx: /\bfont-(?:thin|extralight|light|normal|medium|bold|extrabold|black)\b/,
        label: 'weight override',
    },
    {
        rx: /\btext-content-(?:emphasis|default|subtle)\b/,
        label: 'tone override',
    },
    {
        rx: /\btext-(?:gray|slate|neutral|zinc|stone)-\d+\b/,
        label: 'raw palette grey',
    },
];

interface Hit {
    file: string;
    line: number;
    text: string;
    label: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Eyebrow uniformity (Roadmap-4 PR-3)', () => {
    it('Eyebrow primitive locks intrinsic styling', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/typography.tsx'),
            'utf-8',
        );
        // The intrinsic style must contain block + mb-1 + text-xs +
        // font-semibold + uppercase + tracking-wider + text-content-muted.
        for (const cls of [
            'block',
            'mb-1',
            'text-xs',
            'font-semibold',
            'uppercase',
            'tracking-wider',
            'text-content-muted',
        ]) {
            expect(src).toMatch(new RegExp(`['"\\s]${cls}\\b`));
        }
    });

    it('no Eyebrow callsite overrides typography (size / weight / tone / raw grey)', () => {
        const offenders: Hit[] = [];
        for (const root of ['src/app', 'src/components']) {
            for (const file of walk(path.join(ROOT, root))) {
                const content = fs.readFileSync(file, 'utf-8');
                const rx = new RegExp(EYEBROW_OPEN_RE.source, 'g');
                let m: RegExpExecArray | null;
                while ((m = rx.exec(content)) !== null) {
                    const className = m[1];
                    for (const { rx: bx, label } of BANNED_PATTERNS) {
                        if (bx.test(className)) {
                            const before = content.slice(0, m.index);
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: before.split('\n').length,
                                text: m[0].slice(0, 200),
                                label,
                            });
                            break;
                        }
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map(
                    (o) =>
                        `  ${o.file}:${o.line} [${o.label}]\n    ${o.text}`,
                )
                .join('\n');
            throw new Error(
                `Found ${offenders.length} Eyebrow callsite(s) overriding typography.\n\nThe Eyebrow primitive locks size, weight, case, tracking, and tone. Override layout (margin / padding) only — never typography.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
