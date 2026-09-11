/**
 * Roadmap-3 PR-4 — focus-ring discipline.
 *
 * Repo audit: 47 sites use `focus-visible:ring-2`, 4 used
 * `focus-visible:ring-1`. The 4 outliers were the kind of
 * detail that whispers "second-class" to keyboard users — a
 * thinner halo on a few primitives within an otherwise
 * consistent product. This PR locks `ring-2` as the canonical
 * focus ring and bans `ring-1` outright.
 *
 * What this ratchet enforces
 *   • In src/app + src/components, every `focus-visible:ring-N`
 *     reads `ring-2`. No `ring-1`, no `ring-0`, no `ring-3+`.
 *
 * What this ratchet does NOT police (yet)
 *   • The full ring chain composition (offset, color, offset
 *     color). Those are the polish items in Roadmap-6 (States &
 *     Motion). For this round we just lock the ring SIZE so a
 *     keyboard user lands the same-thickness halo on every
 *     interactive primitive.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const RING_OUTLIER_RE = /focus-visible:ring-(?:0|1|3|4|5|6|7|8)\b/;

interface Hit {
    file: string;
    line: number;
    text: string;
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

describe('Focus-ring discipline (Roadmap-3 PR-4)', () => {
    it('every focus-visible:ring-* uses ring-2 (canonical)', () => {
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
                    if (RING_OUTLIER_RE.test(line)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: i + 1,
                            text: trimmed.slice(0, 200),
                        });
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} non-canonical focus ring(s).\n\nThe canonical focus ring is \`focus-visible:ring-2\`. Thinner rings (ring-1) read as second-class to keyboard users; thicker rings (ring-3+) compete with hover state. Use \`ring-2\` everywhere.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
