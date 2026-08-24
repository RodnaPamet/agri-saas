/**
 * Ratchet: no NEW legacy-brand ("inflect" / "AgriSaaS") references.
 *
 * The Agrent rebrand (Roadmap-5 PR3) retired the previous brand from the
 * user-facing + infra strings. This guard scans src/ + deploy/ + messages/ +
 * public/ for `/inflect/i` and the stale "AgriSaaS" manifest name, and fails
 * CI on any occurrence that isn't an INTENTIONAL survivor.
 *
 * Intentional survivors fall into a small set of categories, each of which
 * canNOT be renamed without breaking something real. New references that don't
 * match a survivor category fail the build — rebrand them, or (rarely) add a
 * new category with a written reason.
 *
 * docs/implementation-notes are immutable history and are NOT scanned.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['src', 'deploy', 'messages', 'public'];

// Files that legitimately contain the token because they ARE the rebrand
// machinery / this scanner.
const SKIP_FILES = new Set([
    'tests/guards/no-legacy-brand.test.ts',
]);
const SKIP_SUBSTRINGS = [
    'docs/implementation-notes/',
    'node_modules/',
];
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf']);

/**
 * Intentional-survivor categories. A matched line is allowed iff it matches
 * one of these patterns. Each carries the reason it can't be renamed.
 */
const SURVIVORS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    // Colon-delimited storage/redis key namespaces + the two dot-namespaced
    // client keys. Deliberately NOT a bare `inflect\.` — that would falsely
    // allow brand domains like `inflect.app`.
    { pattern: /inflect:/i, reason: 'client localStorage / redis key namespace — renaming orphans persisted user prefs (theme, filters, column visibility, onboarding state)' },
    { pattern: /inflect\.(?:celebrate|coachmark)/i, reason: 'client localStorage key namespace (celebrations, coach-marks) — renaming orphans persisted state' },
    { pattern: /inflect_(?:invite|org_invite)_token/, reason: 'auth cookie names — renaming breaks in-flight invites/sessions' },
    { pattern: /X-Inflect-|LEGACY_OUTBOUND_WEBHOOK_HEADERS|legacyOutboundHeaders/, reason: 'legacy outbound-webhook headers — dual-emitted for SIEM back-compat (AUDIT_STREAM_LEGACY_HEADERS)' },
    { pattern: /__INFLECT_FORM_TELEMETRY__/, reason: 'dev-only form-telemetry debug global' },
    { pattern: /inflect-(?:data|mfa|startup-sentinel|dev-encryption)/, reason: 'encryption/MFA key-derivation salts + HKDF info — renaming breaks decryption of all existing ciphertext' },
    { pattern: /inflect-compliance|inflect-jobs/i, reason: 'OTel resource names / GHCR org / HIBP User-Agent — observability + operator-side identity, migration-noted' },
    { pattern: /inflect_compliance/, reason: "the OTHER product's production DB name (the inflect-compliance VM, a different repo) — not ours to rename. Ours was renamed to agrent_production 2026-08-24; see docs/implementation-notes." },
    { pattern: /:-inflect\b/, reason: 'operator-side Postgres role/db default in the vendored VM compose — the file must byte-match the live VM (PR2 drift check); migration-noted' },
    { pattern: /inflect-(?:soil)/, reason: 'BullMQ queue name — renaming orphans in-flight jobs on the old queue' },
    { pattern: /inflect-onboarding/, reason: 'driver.js popover class name — styled externally' },
    { pattern: /\/opt\/inflect/, reason: 'operator-side VM path — migration-noted, not scripted (renames are manual)' },
    { pattern: /packager:\s*inflect/, reason: 'seeded compliance-library package metadata — a data field, not a brand surface' },
    // Cosmetic prose in a code comment — not a user-facing or infra identifier.
    // Comments are non-functional; the ratchet's job is live strings.
    { pattern: /^\s*(?:\*|\/\/|<!--).*inflect/i, reason: 'cosmetic prose in a comment' },
];

function listFiles(): string[] {
    const out = execFileSync('git', ['ls-files', '-z', ...SCAN_ROOTS], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
}

interface Hit {
    file: string;
    line: number;
    text: string;
}

function scan(): { violations: Hit[]; survivorCount: number } {
    const violations: Hit[] = [];
    let survivorCount = 0;
    for (const rel of listFiles()) {
        if (SKIP_FILES.has(rel)) continue;
        if (SKIP_SUBSTRINGS.some((s) => rel.includes(s))) continue;
        if (BINARY_EXT.has(path.extname(rel))) continue;
        const abs = path.join(ROOT, rel);
        let content: string;
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];
            if (!/inflect/i.test(text)) continue;
            if (SURVIVORS.some((s) => s.pattern.test(text))) { survivorCount++; continue; }
            violations.push({ file: rel, line: i + 1, text: text.trim().slice(0, 160) });
        }
    }
    return { violations, survivorCount };
}

describe('no-legacy-brand ratchet', () => {
    const { violations } = scan();

    it('has no un-reasoned /inflect/i references outside the survivor categories', () => {
        if (violations.length > 0) {
            const report = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n');
            throw new Error(
                `Found ${violations.length} legacy-brand reference(s) that are not intentional survivors.\n` +
                `Rebrand them to "agrent", or add a survivor category with a written reason:\n${report}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it('the PWA manifest locks the Agrent home-screen identity', () => {
        const manifest = fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8');
        const json = JSON.parse(manifest);
        // Name — no stale brand.
        expect(json.name).not.toMatch(/AgriSaaS|Inflect/i);
        expect(json.short_name).not.toMatch(/AgriSaaS|Inflect/i);
        expect(json.name).toBe('Agrent — Field Operations');
        expect(json.short_name).toBe('Agrent');
        expect(manifest).not.toMatch(/inflect/i);
        // Chrome — dark app shell, not the pre-rebrand green (#15803d).
        expect(json.theme_color).toBe('#0b1220');
        expect(json.background_color).toBe('#0b1220');
        // Icons — SVG + the PNG set installed devices need.
        const srcs = (json.icons as Array<{ src: string; sizes: string; purpose: string }>).map((i) => i.src);
        expect(srcs).toContain('/icon.svg');
        expect(srcs).toContain('/icon-192.png');
        expect(srcs).toContain('/icon-512.png');
        const png192 = json.icons.find((i: { src: string }) => i.src === '/icon-192.png');
        expect(png192.sizes).toBe('192x192');
        expect(png192.purpose).toMatch(/maskable/);
    });

    it('the icon PNG set + apple-touch-icon exist (iOS ignores SVG manifest icons)', () => {
        for (const f of ['public/icon-192.png', 'public/icon-512.png', 'public/apple-touch-icon.png']) {
            expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
        }
    });

    it('detector self-test: an un-allowlisted "inflect" line IS a violation', () => {
        const line = 'const brand = "inflect-corp-internal";';
        const isSurvivor = SURVIVORS.some((s) => s.pattern.test(line));
        expect(/inflect/i.test(line)).toBe(true);
        expect(isSurvivor).toBe(false); // would be reported as a violation
    });

    it('detector self-test: a survivor line is NOT a violation', () => {
        const line = "headers['X-Inflect-Signature'] = sig;";
        expect(SURVIVORS.some((s) => s.pattern.test(line))).toBe(true);
    });
});
