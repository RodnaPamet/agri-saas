/**
 * Roadmap-4 PR-1 — no raw palette greys in app pages.
 *
 * The product carries semantic content tones (`text-content-emphasis`,
 * `text-content-default`, `text-content-muted`, `text-content-subtle`)
 * that theme through the dark↔light flip. Raw Tailwind greys
 * (`text-gray-*`, `text-slate-*`, `text-neutral-*`, `text-zinc-*`,
 * `text-stone-*`) don't theme — a `text-slate-400` line stays the
 * same shade in both themes, looking right in one and wrong in the
 * other.
 *
 * The semantic tone vocabulary is documented in
 * `docs/typography-tones.md`. This ratchet enforces it in app code.
 *
 * What this ratchet bans
 *
 *   In every `.tsx` under `src/app`, any of:
 *     • `text-gray-N`   (any N)
 *     • `text-slate-N`  (any N)
 *     • `text-neutral-N`(any N)
 *     • `text-zinc-N`   (any N)
 *     • `text-stone-N`  (any N)
 *
 * Allowlist
 *
 *   • `src/app/audit/shared/[token]/page.tsx` — public share-link
 *     pack page rendered for external auditors. Has its own
 *     deliberate dark surface vocabulary outside the canonical
 *     dark/light system. Allowlisted with reason.
 *   • `src/app/vendor-assessment/[assessmentId]/VendorAssessmentClient.tsx`
 *     — external vendor-facing assessment surface. Same reason.
 *
 *   Both surfaces sit OUTSIDE the authenticated tenant shell;
 *   they're rendered for users who don't have a session and don't
 *   participate in the tenant's theme system. Their bespoke greys
 *   are deliberate.
 *
 * What this ratchet does NOT police
 *
 *   • `bg-gray-*` / `bg-slate-*` etc — backgrounds are sometimes
 *     load-bearing in chart and shimmer contexts. A separate
 *     ratchet (or future round) handles surface tokens.
 *   • `border-gray-*` / `ring-gray-*` etc — same reasoning.
 *   • Anything under `src/components` — primitives sometimes need
 *     precise raw values for shadow + decorative rendering.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');

const RAW_GREY_RE =
    /\btext-(?:gray|slate|neutral|zinc|stone)-\d+\b/;

const ALLOWLIST_FILES = new Set<string>([
    // Public audit-pack share view (rendered for external
    // auditors via a share token; sits outside the tenant
    // theme system and uses a bespoke dark vocabulary).
    // External vendor-assessment surface (vendor-facing
    // outside-the-shell page; same reasoning).
]);

interface Hit {
    file: string;
    line: number;
    text: string;
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

describe('No raw palette greys (Roadmap-4 PR-1)', () => {
    it('every text-color in src/app uses a semantic content token', () => {
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
                if (RAW_GREY_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} raw palette grey class(es) in app pages.\n\nUse a semantic content token instead — see docs/typography-tones.md:\n  text-content-emphasis  — page titles, primary values\n  text-content-default   — body copy\n  text-content-muted     — secondary copy (Caption, Eyebrow, helper text)\n  text-content-subtle    — tertiary copy (pagination, disabled, tab counts)\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('every allowlisted file actually uses raw palette greys (no stale entries)', () => {
        const stale: string[] = [];
        for (const rel of ALLOWLIST_FILES) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) {
                stale.push(`${rel} (file deleted)`);
                continue;
            }
            const content = fs.readFileSync(abs, 'utf-8');
            if (!RAW_GREY_RE.test(content)) {
                stale.push(`${rel} (no raw palette grey use)`);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `Stale entries in ALLOWLIST_FILES — remove in the same diff that retires the file or migrates its colors:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });
});
