/**
 * Every read of `TenantSecuritySettings` names its columns — #2723.
 *
 * That model carries `auditStreamSecretEncrypted`, which is in
 * `ENCRYPTED_FIELDS` and NOT in `GLOBAL_KEK_MODELS`, so it decrypts under the
 * tenant's DEK — resolved from the ALS audit context, not from the row. A read
 * with no tenant bound fetches it as a `v2:` envelope with no error and no log.
 *
 * ## Why this model and not the whole class
 *
 * #2723 reasons that a repo-wide static guard cannot work, and that is right:
 * the discriminator is whether a read happens to run inside
 * `runInTenantContext`, which is reachability. The scan written for that issue
 * approximates it per FILE, and a file with one tenant-bound read and one
 * global read reads as mitigated — it fails OPEN, which is why it stays a
 * diagnostic rather than becoming a gate.
 *
 * "Does this read name its columns" needs no such analysis. It is decidable
 * from the text, and for THIS model the consequence is not a garbled string on
 * a screen:
 *
 *   - `auditStreamSecretEncrypted` is not display text. It is the key the
 *     outbound audit HMAC is computed with, so reading it as ciphertext signs
 *     every SIEM delivery with the wrong bytes while nothing errors.
 *   - the live reader in `src/auth.ts` is the `jwt` callback, where the lines
 *     after it copy fields ONTO the token. An accident there puts a ciphertext
 *     secret in a cookie.
 *
 * Both of the narrowings this guard protects were made for #2723 and neither
 * was a live defect at the time — they were each one edit away, which is
 * exactly the kind of thing that needs a gate rather than a memory.
 */

import * as fs from 'fs';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import * as path from 'path';

const SCANNED = collectSourceFiles({ roots: ['src'], floor: 1000 });

const rel = (p: string) => path.relative(REPO_ROOT, p);

/** `prisma.tenantSecuritySettings.findX(` / `.upsert(` and friends. */
const READ = /\b(?:prisma|db|tx)\.tenantSecuritySettings\.(find\w+|aggregate)\s*\(/g;

function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

interface Site {
    file: string;
    narrow: boolean;
}

function sites(): Site[] {
    const out: Site[] = [];
    for (const abs of SCANNED) {
        const code = stripComments(fs.readFileSync(abs, 'utf8'));
        READ.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = READ.exec(code)) !== null) {
            // The call's own argument object, bounded so a later unrelated
            // `select:` cannot vouch for this read.
            const tail = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
            out.push({ file: rel(abs), narrow: /\bselect\s*:/.test(tail) });
        }
    }
    return out;
}

describe('TenantSecuritySettings reads name their columns', () => {
    const found = sites();

    it('[security-settings-narrow-reads] prints the denominator', () => {
        // A floor, because a selector that stopped matching would select zero
        // reads and satisfy the assertion below over nothing.
        expect(found.length).toBeGreaterThanOrEqual(2);
        // No eslint-disable: `no-console` does not apply under tests/, so a
        // directive would be an UNUSED directive, which is itself a finding.
        console.log(`[security-settings-narrow-reads] ${found.length} read(s) of TenantSecuritySettings`);
    });

    /**
     * The control for `rel()`, and this is the SECOND time in one session that
     * `scripts/selector-teeth.mjs` caught this exact helper in a new guard of
     * mine — the first was #2811's. `rel()` is only reached to build a FAILURE
     * message, so with every site compliant it is never called and gutting it
     * to `''` leaves the guard green.
     *
     * The lesson is not "be careful": a guard whose only use of a selector is
     * on the failure path has an untested selector BY CONSTRUCTION, so the
     * control belongs in the same commit as the guard rather than after the
     * harness says so.
     */
    it('rel() maps the population to repo-relative paths', () => {
        const files = found.map((s) => s.file);
        expect(files).toContain('src/auth.ts');
        for (const f of files) {
            expect(path.isAbsolute(f)).toBe(false);
            expect(f.startsWith('src/')).toBe(true);
        }
    });

    it('every read narrows its select', () => {
        const unnarrowed = found.filter((s) => !s.narrow).map((s) => s.file);
        expect(unnarrowed).toEqual([]);
    });

    /**
     * The detector's own proof: every real site is compliant, so without this
     * the assertion above would pass whether or not the matcher can see
     * anything.
     */
    it('detects an unnarrowed read', () => {
        const narrow = 'prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { mfaPolicy: true } });';
        const wide = 'prisma.tenantSecuritySettings.findUnique({ where: { tenantId } });';
        const check = (src: string) => {
            READ.lastIndex = 0;
            const m = READ.exec(src);
            expect(m).not.toBeNull();
            const tail = src.slice(m!.index + m![0].length, m!.index + m![0].length + 400);
            return /\bselect\s*:/.test(tail);
        };
        expect(check(narrow)).toBe(true);
        expect(check(wide)).toBe(false);
    });
});
