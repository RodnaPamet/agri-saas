/**
 * One module, one specifier — `@/lib/storage`, never `@/lib/storage/index`.
 *
 * `src/lib/storage.ts` and `src/lib/storage/index.ts` BOTH exist. Node and
 * jest resolve a bare `@/lib/storage` to the FILE (a file beats a sibling
 * directory), so the two specifiers name two different modules even though
 * they read as the same one. `storage.ts` re-exports the abstraction, so
 * production behaviour is identical either way and nothing ever fails at
 * runtime because of the difference.
 *
 * What is NOT identical is mocking. `jest.mock('@/lib/storage', …)` is keyed
 * on the resolved path, so it does not intercept `@/lib/storage/index`.
 *
 * That is not a hypothetical. `downloadEvidenceFile` statically imported
 * `@/lib/storage` at the top of its section and then dynamically imported
 * `@/lib/storage/index` further down. `evidence-download-gate.test.ts`
 * mocked the former and got the REAL LocalStorageProvider for the latter,
 * so `createReadStream` opened a fixture path that does not exist. The
 * failure mode is unusually bad:
 *
 *   - The stream's 'error' fires ASYNCHRONOUSLY with no listener, which
 *     terminates the worker PROCESS rather than failing an assertion.
 *   - Jest therefore prints no summary at all — CI shard 3/4 ended with
 *     `ENOENT … /tmp/ci-uploads/tenants/tenant-1/evidence/file-1.pdf`,
 *     `##[error]Process completed with exit code 1`, and nothing else.
 *   - Whether the process was still alive when the error landed depended
 *     on timing, so it presented as a FLAKY shard: two runs of the same
 *     SHA, one red, one green.
 *   - The tests themselves passed, because `resolves.toBeDefined()` is
 *     satisfied by a stream that is about to blow up.
 *
 * The rule is therefore about the specifier, not about behaviour: a reader
 * cannot tell the two apart by eye, and the cost of getting it wrong is a
 * dead worker somewhere else in the run.
 *
 * If `storage.ts` is ever collapsed into the directory, delete this guard
 * in the same diff — the ambiguity it exists for will be gone.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

/** The directory that legitimately refers to its own files. */
const STORAGE_DIR = join('src', 'lib', 'storage');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
}

/** Exported for the mutation proof. */
export function findIndexSpecifiers(
    files: ReadonlyArray<{ rel: string; text: string }>,
): string[] {
    const offenders: string[] = [];
    for (const f of files) {
        // Files inside src/lib/storage/ address their own siblings.
        if (f.rel.startsWith(STORAGE_DIR + '/')) continue;
        const lines = f.text.split('\n');
        lines.forEach((line, i) => {
            // Static `from '@/lib/storage/index'`, dynamic
            // `import('@/lib/storage/index')`, and require() alike.
            if (/['"]@\/lib\/storage\/index['"]/.test(line)) {
                offenders.push(`${f.rel}:${i + 1}: ${line.trim()}`);
            }
        });
    }
    return offenders;
}

describe('storage module specifier', () => {
    it('the ambiguity this guard exists for is real', () => {
        // If either of these stops being true the guard is either
        // pointless or wrong, and the docblock above needs re-reading.
        expect(existsSync(join(SRC, 'lib', 'storage.ts'))).toBe(true);
        expect(existsSync(join(SRC, 'lib', 'storage', 'index.ts'))).toBe(true);
    });

    it('storage.ts re-exports getProviderByName, so one specifier suffices', () => {
        // The reason normalising on `@/lib/storage` is safe rather than a
        // downgrade: the shim carries the symbol the dynamic import needs.
        const shim = readFileSync(join(SRC, 'lib', 'storage.ts'), 'utf8');
        expect(shim).toMatch(/getProviderByName/);
    });

    it('no file outside src/lib/storage/ imports @/lib/storage/index', () => {
        const files = walk(SRC).map((full) => ({
            rel: full.replace(ROOT + '/', ''),
            text: readFileSync(full, 'utf8'),
        }));
        expect({ offenders: findIndexSpecifiers(files) }).toEqual({ offenders: [] });
    });

    // ── Mutation proof ────────────────────────────────────────────────
    describe('the detector actually detects', () => {
        it('flags the exact line that broke CI', () => {
            const files = [{
                rel: 'src/app-layer/usecases/evidence.ts',
                text: "        const { getProviderByName } = await import('@/lib/storage/index');",
            }];
            expect(findIndexSpecifiers(files)).toHaveLength(1);
        });

        it('flags a static import too, not just a dynamic one', () => {
            const files = [{
                rel: 'src/lib/x.ts',
                text: `import { getProviderByName } from "@/lib/storage/index";`,
            }];
            expect(findIndexSpecifiers(files)).toHaveLength(1);
        });

        it('allows the canonical specifier', () => {
            const files = [{
                rel: 'src/app-layer/usecases/evidence.ts',
                text: "const { getProviderByName } = await import('@/lib/storage');",
            }];
            expect(findIndexSpecifiers(files)).toEqual([]);
        });

        it('exempts the storage directory addressing itself', () => {
            const files = [{
                rel: 'src/lib/storage/local-provider.ts',
                text: "import type { X } from '@/lib/storage/index';",
            }];
            expect(findIndexSpecifiers(files)).toEqual([]);
        });
    });
});
