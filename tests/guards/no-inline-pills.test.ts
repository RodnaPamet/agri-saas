/**
 * Roadmap-2 PR-7 — no inline status-pill construction in app code.
 *
 * `<StatusBadge>` and `<Badge>` are the canonical pill primitives.
 * Until this PR a handful of surfaces hand-rolled their own pills
 * with `inline-flex … px-2 py-0.5 rounded-full text-…`, drifting
 * from the canonical shape. Each one was a tiny visual divergence
 * from the rest of the product. The migrations in this PR
 * collapsed five of those onto the primitives — the ratchet
 * prevents new ones from emerging.
 *
 * What this ratchet detects
 *   In `src/app/**`, look for spans / divs that combine ALL of:
 *     • `inline-flex items-center` OR similar pill-shape signal
 *     • `rounded-full` OR `rounded` (with px-2 py-0.5)
 *     • a `bg-bg-*` background AND a `text-content-*` foreground
 *   These signal a pill being hand-rolled instead of consumed
 *   from `<StatusBadge>` / `<Badge>` / `<FreshnessBadge>` /
 *   `<ComplianceStatusIndicator>`.
 *
 * Allowlist
 *   The five primitive bodies themselves — `status-badge.tsx`,
 *   `badge.tsx`, `FreshnessBadge.tsx`, `ComplianceStatusIndicator.tsx`,
 *   plus the print-view `SoAPrintView.tsx` (intentionally bespoke
 *   styling for paper output, lives outside the design system).
 *
 *   The legacy admin/roles preset-buttons aren't pills — they're
 *   small click triggers — but their geometry would trip the
 *   detector. Allowlisted as a known interactive element.
 *
 * What this ratchet does NOT police
 *   Components / shared primitives outside `src/app/**` — those
 *   are owned by their own discipline ratchets (`status-badge`
 *   has its own structural test).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');

interface PillPattern {
    rx: RegExp;
    label: string;
}

// Each pattern looks for a className string that combines the
// pill-shape signal + a tone pair. The patterns are deliberately
// tight — false positives would force noisy allowlists.
const PATTERNS: PillPattern[] = [
    {
        rx: /inline-flex[^"']*?\bpx-[0-9]+\s+py-[0-9]+\.?5?[^"']*?\brounded(?:-full)?[^"']*?\bbg-bg-[a-z]+[^"']*?\btext-content-[a-z]+/,
        label: 'inline-flex pill with bg-bg-* + text-content-*',
    },
    {
        rx: /\bpx-[0-9]+\s+py-[0-9]+\.?5?[^"']*?\brounded-full[^"']*?\bbg-bg-[a-z]+[^"']*?\btext-content-[a-z]+/,
        label: 'rounded-full pill with bg-bg-* + text-content-*',
    },
];

const ALLOWLIST_FILES = new Set<string>([
    // Print view — intentionally bespoke styling for paper.
]);

const ALLOWLIST_LINE_FRAGMENTS: Array<{ file: string; substring: string; reason: string }> = [
    {
        file: 'src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx',
        substring: 'preset-${r}',
        reason: 'Preset-role buttons are interactive triggers (click → setPermissions), not status pills. Geometry overlaps with the pill detector but the semantic role is a button.',
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
    if (!fs.existsSync(dir)) return out;
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

describe('No inline status pills in app code (Roadmap-2 PR-7)', () => {
    it('every pill-shaped element in src/app uses the canonical primitive', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const rel = path.relative(ROOT, file);
            if (ALLOWLIST_FILES.has(rel)) continue;
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
                // Skip lines that are inside an allowlisted button
                // context (admin/roles preset-buttons).
                const allowlisted = ALLOWLIST_LINE_FRAGMENTS.some(
                    (e) =>
                        e.file === rel &&
                        (line.includes(e.substring) ||
                            (i > 0 &&
                                lines[i - 1]?.includes(e.substring))),
                );
                if (allowlisted) return;
                for (const p of PATTERNS) {
                    if (p.rx.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            text: trimmed.slice(0, 200),
                            label: p.label,
                        });
                        break;
                    }
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line} [${o.label}]\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} hand-rolled status-pill construction(s) in src/app.\n\nReplace with <StatusBadge>, <Badge>, <FreshnessBadge>, or <ComplianceStatusIndicator> — whichever fits the entity's pill vocabulary. The primitives lock pill shape, tone-mapping, and theme parity.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
