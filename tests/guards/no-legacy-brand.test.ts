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
import * as zlib from 'node:zlib';

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
        // P2.4 — the app shell is GREEN, matching `--bg-page` in the dark
        // theme and the dark `theme-color` meta that layout.tsx already
        // advertises. It was #0b1220, the PwC navy this item removes; the
        // pre-rebrand green was a different, brighter #15803d and is not what
        // this is.
        //
        // Pinned in the same diff as the manifest change, per the plan: a
        // guard that trails its subject by a commit is a guard that has to be
        // re-argued by whoever next reads a red build.
        expect(json.theme_color).toBe('#05231B');
        expect(json.background_color).toBe('#05231B');
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

    /**
     * The icons are the right COLOUR, not merely present.
     *
     * The text scan above cannot answer this: `BINARY_EXT` skips `.png` by
     * design, because a byte-grep of compressed pixel data is meaningless. So
     * for the whole of the rebrand this guard asserted the three PNGs EXIST
     * and was structurally blind to the fact that all three still carried the
     * `#0b1220` PwC navy ground — it passed 5/5 while shipping the old brand
     * on every installed home screen. Existence was never the property worth
     * guarding.
     *
     * Decoding one pixel is the smallest honest fix. Note the assertion is
     * EQUALITY to the new colour rather than inequality to the old one: a
     * decoder bug that returned zeroes, or a wrong stride, would satisfy
     * "not navy" trivially, so only the positive form validates the
     * measurement at the same time as the asset.
     */
    describe('app icon pixels carry the Agrent brand, not the PwC navy', () => {
        /**
         * Minimal 8-bit RGBA PNG reader.
         *
         * Only the subset these three files use, and it REFUSES anything else
         * rather than mis-decoding it — an Adam7-interlaced or palette PNG run
         * through this code would produce plausible nonsense, which is exactly
         * the failure a guard must not have.
         */
        function readPng(buf: Buffer) {
            const w = buf.readUInt32BE(16);
            const h = buf.readUInt32BE(20);
            const [bitDepth, colourType] = [buf[24], buf[25]];
            const interlace = buf[28];
            if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
                throw new Error(`unsupported PNG: depth=${bitDepth} colour=${colourType} interlace=${interlace}`);
            }

            const idat: Buffer[] = [];
            for (let off = 8; off + 8 <= buf.length; ) {
                const len = buf.readUInt32BE(off);
                if (buf.toString('ascii', off + 4, off + 8) === 'IDAT') {
                    idat.push(buf.subarray(off + 8, off + 8 + len));
                }
                off += 12 + len;
            }
            const raw = zlib.inflateSync(Buffer.concat(idat));

            // Un-filter. Each scanline is prefixed with its filter type and is
            // decoded against the ALREADY-decoded bytes to its left and above,
            // so this cannot be done for one pixel in isolation.
            const bpp = 4;
            const stride = w * bpp;
            const out = Buffer.alloc(h * stride);
            let p = 0;
            for (let y = 0; y < h; y++) {
                const filter = raw[p++];
                for (let x = 0; x < stride; x++) {
                    const cur = raw[p + x];
                    const a = x >= bpp ? out[y * stride + x - bpp] : 0;
                    const b = y > 0 ? out[(y - 1) * stride + x] : 0;
                    const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
                    let v: number;
                    if (filter === 0) v = cur;
                    else if (filter === 1) v = cur + a;
                    else if (filter === 2) v = cur + b;
                    else if (filter === 3) v = cur + ((a + b) >> 1);
                    else if (filter === 4) {
                        const pred = a + b - c;
                        const [pa, pb, pc] = [Math.abs(pred - a), Math.abs(pred - b), Math.abs(pred - c)];
                        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
                    } else throw new Error(`unknown PNG filter ${filter}`);
                    out[y * stride + x] = v & 0xff;
                }
                p += stride;
            }

            const px = (x: number, y: number) => [
                out[y * stride + x * 4],
                out[y * stride + x * 4 + 1],
                out[y * stride + x * 4 + 2],
                out[y * stride + x * 4 + 3],
            ];
            const hex = (x: number, y: number) =>
                '#' + px(x, y).slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');
            return { w, h, px, hex, bytes: out };
        }

        const ICONS = ['public/icon-192.png', 'public/icon-512.png', 'public/apple-touch-icon.png'];

        it.each(ICONS)('%s has the forest-green ground', (file) => {
            const img = readPng(fs.readFileSync(path.join(ROOT, file)));
            // Sampled low and centre: below the furrows, inside the rounded
            // rect at every size, and clear of the sprout.
            const [x, y] = [Math.floor(img.w / 2), Math.floor(img.h * 0.85)];
            expect(img.hex(x, y)).toBe('#05231b'); // --bg-page, dark theme
            expect(img.px(x, y)[3]).toBe(255);
        });

        it.each(ICONS)('%s keeps its transparent corner (the rounded mask)', (file) => {
            const img = readPng(fs.readFileSync(path.join(ROOT, file)));
            expect(img.px(1, 1)[3]).toBe(0);
        });

        it.each(ICONS)('%s still carries the gold mark — not a blank square', (file) => {
            // Without this, a solid #05231B rectangle would satisfy every
            // assertion above. The gradient runs #E8C766 -> #C79A2E, so the
            // test is for pixels that are decisively warm, not an exact value.
            const img = readPng(fs.readFileSync(path.join(ROOT, file)));
            let gold = 0;
            for (let i = 0; i < img.bytes.length; i += 4) {
                const [r, g, b, a] = [img.bytes[i], img.bytes[i + 1], img.bytes[i + 2], img.bytes[i + 3]];
                if (a === 255 && r > 150 && g > 110 && b < 110 && r > b + 60) gold++;
            }
            expect(gold).toBeGreaterThan(img.w * img.h * 0.01);
        });

        it('the decoder REFUSES a format it would otherwise mis-read', () => {
            // The guard's own control: `readPng` returning plausible nonsense
            // for an unexpected format is the way this check goes quietly
            // wrong, so the refusal is asserted rather than assumed.
            const buf = Buffer.from(fs.readFileSync(path.join(ROOT, ICONS[0])));
            buf[25] = 3; // claim palette colour
            expect(() => readPng(buf)).toThrow(/unsupported PNG/);
        });
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
