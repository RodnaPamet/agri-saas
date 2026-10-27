/**
 * Guardrail test: Prevents reintroduction of the removed "Scope" concept.
 * 
 * Scope was removed in Phase 3-5 and replaced by tenant-wide certification
 * with practice applicability. This test fails if any scope artifacts reappear.
 */
import { readCatalogue } from '../helpers/catalogue';
import path from 'path';
import fs from 'fs';
import { readPrismaSchema } from '../helpers/prisma-schema';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * Recursively scan all .ts/.tsx files in a directory and return
 * lines matching a pattern (as { file, line, content }[]).
 */
function scanFiles(dir: string, pattern: RegExp, extensions = ['.ts', '.tsx']): Array<{ file: string; line: number; content: string }> {
    const results: Array<{ file: string; line: number; content: string }> = [];
    // An empty return here is CORRECT. Some roots this scans are DELIBERATELY
    // absent — the scope-era `app/api/t/[tenantSlug]/s` and `…/scopes`, whose
    // non-existence another test in this file asserts outright
    // (`expect(fs.existsSync(scopeDir)).toBe(false)`). A throw would fail the
    // guard for the exact state it exists to confirm.
    if (!fs.existsSync(dir)) return results;

    function walk(d: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.next') continue;
                walk(full);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                const content = blankNonCode(fs.readFileSync(full, 'utf-8'));
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (pattern.test(lines[i])) {
                        // Skip lines that are only comments
                        const trimmed = lines[i].trim();
                        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
                        results.push({ file: path.relative(ROOT, full), line: i + 1, content: lines[i].trim() });
                    }
                }
            }
        }
    }

    walk(dir);
    return results;
}

describe('Scope Reintroduction Guardrails', () => {

    // ── File path guardrails ──

        it('[scope-guards] the src scan reaches a real population — the denominator', () => {
        // Three tests below scan all of `src/` for `scopeId`,
        // `resolveScopeContext` and `ScopeMembership` and assert ZERO matches.
        // A walk that returned nothing satisfies all three perfectly, and
        // would report the scope migration complete having read no files
        // (#2377).
        //
        // Asserted on the FILE COUNT, not on the findings: zero findings is
        // the pass condition here and must stay so, which is exactly why the
        // population needs its own floor rather than a non-empty assertion on
        // the results.
        const everything = scanFiles(SRC, /./);
        const distinctFiles = new Set(everything.map((r) => r.file));
        console.log(`[scope-guards] scanned ${distinctFiles.size} file(s) under src/`);
        expect(distinctFiles.size).toBeGreaterThan(500);
    });

it('no UI pages under /s/[scopeSlug]', () => {
        const scopeDir = path.join(SRC, 'app', 't', '[tenantSlug]', '(app)', 's');
        expect(fs.existsSync(scopeDir)).toBe(false);
    });

    it('no API routes under /s/[scopeSlug]', () => {
        const scopeDir = path.join(SRC, 'app', 'api', 't', '[tenantSlug]', 's');
        expect(fs.existsSync(scopeDir)).toBe(false);
    });

    it('no /api/t/[tenantSlug]/scopes route exists', () => {
        const scopesDir = path.join(SRC, 'app', 'api', 't', '[tenantSlug]', 'scopes');
        expect(fs.existsSync(scopesDir)).toBe(false);
    });

    // ── Code reference guardrails ──

    it('no code references scopeId as a variable or field', () => {
        const matches = scanFiles(SRC, /scopeId/);
        const filtered = matches.filter(m => !m.file.includes('scope-guardrails'));
        expect(filtered).toEqual([]);
    });

    it('no code imports or references resolveScopeContext', () => {
        const matches = scanFiles(SRC, /resolveScopeContext/);
        const filtered = matches.filter(m => !m.file.includes('scope-guardrails'));
        expect(filtered).toEqual([]);
    });

    it('no code references ScopeMembership', () => {
        const matches = scanFiles(SRC, /ScopeMembership/);
        const filtered = matches.filter(m => !m.file.includes('scope-guardrails'));
        expect(filtered).toEqual([]);
    });

    // ── Schema guardrails ──

    it('Prisma schema has no Scope or ScopeMembership model', () => {
        const schema = readPrismaSchema();
        expect(schema).not.toMatch(/^model\s+Scope\s*\{/m);
        expect(schema).not.toMatch(/^model\s+ScopeMembership\s*\{/m);
    });

    it('Prisma schema has no scopeId fields', () => {
        const schema = readPrismaSchema();
        expect(schema).not.toMatch(/scopeId/);
    });

    // ── i18n guardrails ──

    it('no i18n files reference scopeRisks key', () => {
        const enJson = JSON.stringify(readCatalogue('en'));
        const bgJson = JSON.stringify(readCatalogue('bg'));
        expect(enJson).not.toContain('"scopeRisks"');
        expect(bgJson).not.toContain('"scopeRisks"');
    });

    // ── Middleware guardrails ──

    it('middleware has no scope redirect shim', () => {
        const middleware = blankNonCode(fs.readFileSync(path.join(SRC, 'middleware.ts'), 'utf-8'));
        expect(middleware).not.toContain('SCOPE_URL_PATTERN');
        expect(middleware).not.toContain('scopeSlug');
    });
});
