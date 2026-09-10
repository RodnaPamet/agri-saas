/**
 * Roadmap-3 PR-3 — hover-state language discipline.
 *
 * Repo audit found EIGHT competing hover treatments coexisting:
 *
 *   hover:bg-bg-muted       (56 sites — strong saturation)
 *   hover:bg-bg-muted/50    ( 5 sites — soft surface hover)
 *   hover:bg-bg-muted/40    ( 3 sites — soft input hover)
 *   hover:bg-bg-elevated/30 (12 sites — alternate "soft")
 *   hover:bg-bg-default/30  ( 6 sites — alternate "soft")
 *   hover:bg-transparent    (12 sites — ghost-button reset)
 *   hover:bg-neutral-50     ( 3 sites — off-token, raw palette)
 *   status-coloured hovers  (small counts — intentional, scoped)
 *
 * The product had three different "soft hover" approaches doing
 * the same job. The user feels the cursor moving across surfaces
 * with subtly different warmth and reads it as drift. This PR
 * consolidates the soft-hover language and bans the off-token
 * outlier.
 *
 * What this PR enforces (the canonical vocabulary)
 *
 *   • `hover:bg-bg-muted`         — full saturation. Used by
 *     buttons / inputs where the surface IS the affordance.
 *   • `hover:bg-bg-muted/50`      — soft surface hover. Used by
 *     rows / cards / nav items where the hover is a hint, not
 *     the primary affordance. THE canonical "soft" hover.
 *   • `hover:bg-bg-muted/40`      — soft input hover. Used by
 *     input-shaped affordances (search anchor, combobox
 *     trigger). Slightly lighter than the surface hover so
 *     input shapes feel a touch quieter.
 *   • `hover:bg-bg-{success,error,warning,info}` — status-
 *     context hover for color-coded interactive surfaces.
 *     Intentional, scoped, untouched.
 *   • `hover:bg-transparent`      — ghost-button reset only.
 *
 * What this PR bans
 *
 *   • `hover:bg-neutral-50` (and any `hover:bg-neutral-*`) —
 *     raw Tailwind palette, doesn't theme.
 *   • `hover:bg-bg-elevated/30` and `hover:bg-bg-default/30` —
 *     redundant with the soft surface hover. Pages that used
 *     these migrate to `hover:bg-bg-muted/50`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const BANNED_PATTERNS: Array<{ rx: RegExp; canonical: string }> = [
    {
        rx: /hover:bg-neutral-/,
        canonical: 'hover:bg-bg-muted/50 (or whichever fits — but never raw palette)',
    },
    {
        rx: /hover:bg-bg-elevated\/30\b/,
        canonical: 'hover:bg-bg-muted/50',
    },
    {
        rx: /hover:bg-bg-default\/30\b/,
        canonical: 'hover:bg-bg-muted/50',
    },
];

interface Hit {
    file: string;
    line: number;
    text: string;
    canonical: string;
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

describe('Hover-state language (Roadmap-3 PR-3)', () => {
    it('zero off-canon hover backgrounds in src/app + src/components', () => {
        const offenders: Hit[] = [];
        for (const root of ['src/app', 'src/components']) {
            for (const file of walk(path.join(ROOT, root))) {
                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*') ||
                        trimmed.startsWith('/*')
                    )
                        return;
                    for (const { rx, canonical } of BANNED_PATTERNS) {
                        if (rx.test(line)) {
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: i + 1,
                                text: trimmed.slice(0, 200),
                                canonical,
                            });
                            break;
                        }
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map(
                    (o) =>
                        `  ${o.file}:${o.line}\n    → use: ${o.canonical}\n    ${o.text}`,
                )
                .join('\n');
            throw new Error(
                `Found ${offenders.length} off-canon hover background(s).\n\nThe product carries TWO soft-hover variants and one full-saturation:\n  • hover:bg-bg-muted/50  — soft surface (rows / cards / nav items)\n  • hover:bg-bg-muted/40  — soft input (search anchor / combobox)\n  • hover:bg-bg-muted     — full saturation (buttons / inputs where the surface IS the affordance)\nplus status-coloured hovers (success/error/warning/info) for color-coded surfaces, and \`hover:bg-transparent\` for ghost-button resets.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
