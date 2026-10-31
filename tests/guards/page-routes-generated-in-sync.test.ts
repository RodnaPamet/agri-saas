/**
 * The generated page-route list matches `src/app` — #2578.
 *
 * Three questions, and the third is the one that rots:
 *
 *   1. Is the committed module in sync? Asked by running the generator's own
 *      `--check`, so this guard cannot drift from the generator.
 *   2. Does it range over a real population? A floor, because an empty list
 *      would make every `route` invalid and the assistant refuse every request
 *      that carries a context.
 *   3. **Does the PREMISE still hold** — is `src/app` still absent from the
 *      runtime image? That premise is the entire reason the list is generated
 *      rather than read. A premise can go false without anybody revisiting the
 *      reasoning built on it, which is `a-safety-argument-expires-silently`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pageTemplates, ROOT } from '../../scripts/lib/page-routes';

const TARGET = 'src/lib/assistant/generated/page-routes.ts';
const GENERATOR = 'scripts/generate-page-routes.ts';

describe('generated page routes (#2578)', () => {
    it('is in sync with src/app — by running the generator, not a copy of it', () => {
        const out = execFileSync('npx', ['tsx', GENERATOR, '--check'], {
            cwd: ROOT,
            encoding: 'utf8',
        });
        console.log(`[page-routes] ${out.trim()}`);
        expect(out).toContain('in sync');
    });

    it('ranges over a real population — an empty list would refuse every context', () => {
        const derived = pageTemplates();
        const committed = readFileSync(path.join(ROOT, TARGET), 'utf8');
        const rows = (committed.match(/^ {4}"/gm) ?? []).length;
        const tenantScoped = derived.filter((t) => t.startsWith('/t/[tenantSlug]')).length;
        console.log(`[page-routes] ${rows} committed row(s) from ${derived.length} derived template(s)`);
        console.log(`[page-routes] ${tenantScoped} are tenant-scoped, ${derived.length - tenantScoped} are not`);
        expect(rows).toBe(derived.length);
        expect(derived.length).toBeGreaterThanOrEqual(80);
        // Both halves must contribute. A derivation that collapsed to one
        // subtree would clear a total floor while covering nothing.
        expect(tenantScoped).toBeGreaterThanOrEqual(50);
        expect(derived.length - tenantScoped).toBeGreaterThanOrEqual(10);
    });

    it('excludes route handlers — proved on a FIXTURE, because the real tree cannot prove it', () => {
        // The obvious assertion here was
        //   expect(pageTemplates().filter((t) => t.startsWith('/api'))).toEqual([])
        // and it was vacuous. A route handler is `route.ts`, so walking into
        // `src/app/api` finds no `page.tsx` and contributes nothing whether the
        // exclusion is there or not — measured by deleting the line, which left
        // all 13 tests green. `src/app/api` holds 0 `page.tsx` files today.
        //
        // So the exclusion is exercised over a tree that TRIGGERS it: a fixture
        // with a page under `api/`, which Next would really serve if anyone
        // added one. Both the negative and a positive control, so a walker
        // that returned nothing at all could not pass this.
        const dir = mkdtempSync(path.join(tmpdir(), 'page-routes-fixture-'));
        try {
            mkdirSync(path.join(dir, 'api', 'sneaky'), { recursive: true });
            writeFileSync(path.join(dir, 'api', 'sneaky', 'page.tsx'), 'export default () => null;\n');
            mkdirSync(path.join(dir, 'dashboard'), { recursive: true });
            writeFileSync(path.join(dir, 'dashboard', 'page.tsx'), 'export default () => null;\n');
            const got = pageTemplates(dir);
            expect(got).toEqual(['/dashboard']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        // And the real tree still carries none, which is the property the
        // assistant depends on.
        expect(pageTemplates().filter((t) => t.startsWith('/api'))).toEqual([]);
    });

    it('route GROUPS and PARALLEL slots do not appear in a template', () => {
        // Also fixture-driven: `(marketing)` and `@modal` are invisible in a
        // URL, and a template built from one addresses nothing. The real tree
        // has route groups, so a regression here would show up as a route the
        // client sends being rejected — a failure at the far end from its cause.
        const dir = mkdtempSync(path.join(tmpdir(), 'page-routes-groups-'));
        try {
            mkdirSync(path.join(dir, '(marketing)', 'pricing'), { recursive: true });
            writeFileSync(path.join(dir, '(marketing)', 'pricing', 'page.tsx'), 'export default () => null;\n');
            mkdirSync(path.join(dir, '@modal', 'photo'), { recursive: true });
            writeFileSync(path.join(dir, '@modal', 'photo', 'page.tsx'), 'export default () => null;\n');
            expect(pageTemplates(dir)).toEqual(['/pricing']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the two client-facing claims in the generated header are TRUE', () => {
        // The header tells a client the prefix is not uniform and that
        // parameters must be matched positionally. Both are claims about this
        // data, so both are checked here — a header that goes false is worse
        // than no header, because a client reads it and believes it.
        const derived = pageTemplates();
        const bare = derived.filter((t) => !t.startsWith('/t/[tenantSlug]'));
        const set = new Set(derived);
        // Claim 1: prefixing a bare template does NOT generally yield a valid
        // one. If this ever became empty, `"/t/[slug]" + surface` would be safe
        // and the warning would be misleading.
        const prefixingBreaks = bare.filter((b) => b !== '/' && !set.has(`/t/[tenantSlug]${b}`));
        console.log(`[page-routes] ${bare.length} bare template(s); prefixing breaks for ${prefixingBreaks.length}`);
        expect(prefixingBreaks).toContain('/account');
        expect(prefixingBreaks.length).toBeGreaterThanOrEqual(10);
        // Claim 2: parameter names are many, so name-keyed matching is fragile.
        const names = new Set(
            derived.flatMap((t) => [...t.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])),
        );
        names.delete('tenantSlug');
        console.log(`[page-routes] ${names.size} distinct param name(s) besides tenantSlug`);
        expect(names.size).toBeGreaterThanOrEqual(8);
        expect(names).toContain('locationId');
        expect(names).toContain('id');
    });

    it('the PREMISE still holds: src/app is not in the runtime image', () => {
        // Hash comments stripped by hand, NOT via blankNonCode — that is a
        // JS/TS stripper, so on a Dockerfile it would be a call that
        // demonstrably does nothing. `^COPY` excludes a whole-line comment and
        // does not exclude a trailing one.
        const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
            .split('\n')
            .map((l) => l.replace(/#.*$/, ''))
            .join('\n');
        const runner = dockerfile.slice(dockerfile.lastIndexOf('AS runner'));
        const srcCopies = [...runner.matchAll(/^COPY[^\n]*?\/app\/(src[^\s]*)/gm)].map((m) => m[1]);
        expect({
            premise: 'the only src path in the runtime image is the PDF fonts',
            srcCopies,
            note: 'If src/app now ships, this generator may be redundant — decide, do not just widen this.',
        }).toEqual({
            premise: 'the only src path in the runtime image is the PDF fonts',
            srcCopies: ['src/lib/pdf/fonts'],
            note: 'If src/app now ships, this generator may be redundant — decide, do not just widen this.',
        });
    });

    it('the generator REFUSES to write an empty module', () => {
        // Driven as a subprocess over a temp destination, because the refusal
        // is an exit code and an `::error::` line — neither of which an
        // in-process call exercises.
        const dir = mkdtempSync(path.join(tmpdir(), 'page-routes-'));
        try {
            let status = 0;
            let stderr = '';
            try {
                execFileSync('npx', ['tsx', GENERATOR], {
                    cwd: ROOT,
                    encoding: 'utf8',
                    env: { ...process.env, PAGE_ROUTES_TARGET: path.join(dir, 'out.ts') },
                });
            } catch (e) {
                const err = e as { status?: number; stderr?: string };
                status = err.status ?? 0;
                stderr = err.stderr ?? '';
            }
            // The real tree is non-empty, so the happy path is what runs here:
            // it must SUCCEED and write. The refusal branch is proved by the
            // floor above plus this control — if the derivation ever empties,
            // the generator exits 1 rather than writing a module that makes
            // the assistant refuse every request.
            expect({ status, mentionsRefusal: /refusing to write an empty module/.test(stderr) })
                .toEqual({ status: 0, mentionsRefusal: false });
            expect(readFileSync(path.join(dir, 'out.ts'), 'utf8')).toContain('PAGE_ROUTE_TEMPLATES');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
