/**
 * Roadmap-6 PR-9 — content-tone opacity discipline.
 *
 * Three callsites used `text-content-warning/80` — the
 * warning-tone token with an alpha-suffix modifier that
 * "softens" the warning by 20% opacity. Three sites:
 *
 *   admin/api-keys/page.tsx — full-access scope warning
 *   admin/scim/page.tsx     — SCIM token rotation warning
 *   admin/security/page.tsx — security policy warning
 *
 * Two issues with this pattern:
 *
 *   1. The semantic content-tone system already has a tier:
 *      `text-content-emphasis` / `default` / `muted` / `subtle`.
 *      A "warning that's quieter" is the wrong shape — warnings
 *      ARE the loud tone; quieting them defeats the semantic.
 *
 *   2. Opacity-modified semantic colors break theme parity. The
 *      light-theme warning color and dark-theme warning color
 *      have different luminance; the same /80 doesn't read the
 *      same on both.
 *
 * What lands
 *
 *   All 3 sites migrated `text-content-warning/80` →
 *   `text-content-warning`. Warnings now read at full strength
 *   on every theme.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may use a `text-content-X/N`
 *   alpha-suffix on the SEMANTIC tones (success / warning /
 *   error / info / attention). Those tones encode meaning;
 *   opacity-quieting breaks the meaning.
 *
 * What this ratchet does NOT police
 *
 *   - `text-content-emphasis/N` / `text-content-muted/N` /
 *     `text-content-subtle/N` — the DEFAULT-color tones can
 *     legitimately accept opacity for hover-fade or focus-trap
 *     interactions.
 *   - `bg-bg-X/N` opacity on backgrounds — that's the standard
 *     way to express tinted surfaces (e.g. `bg-bg-error/15`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

const VIOLATION_RE =
    /\btext-content-(success|warning|error|info|attention)\/[0-9]+\b/;

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * Was an inline recursive `walk` inside the `it()` below, so `selector-teeth`
 * found nothing at module scope to mutate. The assertion is
 * `expect(offenders).toEqual([])`, which an emptied walk satisfies for free.
 * `collectSourceFiles` REFUSES an empty result, so the population cannot be
 * empty rather than being emptied and caught (#865).
 *
 * Parity measured BEFORE the change: 872 files both ways, zero difference.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    floor: 600,
});

describe('Content-tone opacity discipline (Roadmap-6 PR-9)', () => {
    it('no semantic content-tone uses an alpha-suffix modifier', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            const raw = fs.readFileSync(full, 'utf-8');
            const stripped = blankNonCode(raw);
            const lines = stripped.split('\n');
            lines.forEach((line, i) => {
                if (VIOLATION_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        snippet: line.trim().slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Semantic content tone with alpha-suffix detected. Warnings/errors/successes/info encode meaning; opacity-quieting breaks the semantic. Use the tone at full strength:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
