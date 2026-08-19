/**
 * Every client sign-out goes through `signOutAndPurge`.
 *
 * Signing out has to clear what this device cached, or a handover leaves
 * the next operator with the previous one's farm painted from disk. That
 * is a rule, and a rule spread across three call sites is a rule the
 * fourth call site will not know about — so it is a function, and this
 * guard is what makes it the only way in.
 *
 * SCOPE: the CLIENT sign-out (`signOut` from `next-auth/react`). The
 * `signOut` shim in `src/auth.ts` is a server-side `redirect()` used by
 * `/no-tenant` and `/tenants`; there is no browser context there and no
 * storage to clear, so it is deliberately out of scope — see the note in
 * `src/lib/auth/sign-out.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = 'src/lib/auth/sign-out.ts';

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
    }
    return acc;
}

describe('client sign-out purges cached tenant data', () => {
    const files = walk(path.join(ROOT, 'src')).map((f) =>
        path.relative(ROOT, f).split(path.sep).join('/'),
    );

    it('scans a real file tree', () => {
        expect(files.length).toBeGreaterThan(500);
    });

    it('only the wrapper imports signOut from next-auth/react', () => {
        const offenders = files.filter((rel) => {
            if (rel === WRAPPER) return false;
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            return /import\s*\{[^}]*\bsignOut\b[^}]*\}\s*from\s*['"]next-auth\/react['"]/.test(src);
        });
        if (offenders.length > 0) {
            throw new Error(
                `These call the client signOut directly instead of signOutAndPurge:\n  ` +
                    offenders.join('\n  ') +
                    `\n\nSigning out must clear what this device cached, or a handover leaves ` +
                    `the next operator with the previous one's data painted from disk. Import ` +
                    `\`signOutAndPurge\` from '@/lib/auth/sign-out' instead.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the wrapper actually purges, and purges at full strength', () => {
        const src = fs.readFileSync(path.join(ROOT, WRAPPER), 'utf8');
        // maxAgeMs: 0 is the point — a sign-out purge that honoured the
        // normal 24h window would clear nothing at all.
        expect(src).toMatch(/sweepClientStores\(\{\s*maxAgeMs:\s*0\s*\}\)/);
        expect(src).toMatch(/signOut\(\{\s*callbackUrl/);
    });

    it('purges BEFORE signing out', () => {
        // This app is used offline by design, so a sign-out can fail to
        // complete. Purging first means the device is clean regardless,
        // which is the entire point of purging.
        const src = fs.readFileSync(path.join(ROOT, WRAPPER), 'utf8');
        expect(src.indexOf('sweepClientStores')).toBeLessThan(src.indexOf('await signOut('));
    });

    it('a wedged purge cannot become a wedged sign-out', () => {
        const src = fs.readFileSync(path.join(ROOT, WRAPPER), 'utf8');
        expect(src).toMatch(/Promise\.race/);
        expect(src).toMatch(/PURGE_BUDGET_MS/);
    });
});
