import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * A `useTenantSWR` read that gates render on `!data` must handle `error`.
 *
 * The hook has always returned `{ data, error, isLoading }`, and nothing
 * obliged a caller to render `error`. Measured on a physical iPhone in
 * airplane mode 2026-09-10 (#862): two dashboard cards showed a loading
 * skeleton forever, and My work told an operator with queued jobs they had
 * **no records** — SWR gave up after two retries, set `isLoading` false with
 * `data` still undefined, and the render fell through to `rows.length === 0`.
 *
 * This guard is deliberately NARROW. A blanket "every useTenantSWR caller must
 * destructure error" fails ~19 files, many legitimately — a combobox that
 * falls back to an empty option list is not lying to anyone. Widening it would
 * force an allowlist, and an allowlist is the thing that decays.
 *
 * So it matches the exact defect shape instead: a component that decides what
 * to render on `!data` while never taking `error` off the hook. That component
 * cannot distinguish "loading", "failed" and "empty", because it only has one
 * of the three signals.
 */

const ROOT = join(__dirname, '..', '..');

/** Destructures `error` out of a useTenantSWR call. */
const TAKES_ERROR = /const\s*\{[^}]*\berror\b[^}]*\}\s*=\s*useTenantSWR/;
/** Gates render on the absence of data. */
const GATES_ON_DATA = /!data\s*\?/;
const CALLS_HOOK = /useTenantSWR\s*[<(]/;

function clientFiles(): string[] {
    const out = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' });
    return out
        .split('\n')
        .filter((f) => f.endsWith('.tsx'))
        .filter((f) => !f.endsWith('use-tenant-swr.ts'));
}

describe('a !data render gate implies error handling', () => {
    const files = clientFiles();

    it('the scan selected files — an empty scan passes vacuously', () => {
        // The lesson from #806: for any tool whose unit of work is a SELECTION,
        // an empty selection is a PASS.
        expect(files.length).toBeGreaterThan(200);
    });

    it('the predicate matches the shape it is meant to catch', () => {
        // Positive control on the regexes themselves, using the real pre-fix
        // source of TasksTrendCard. Without this a well-meaning tidy-up could
        // leave the guard structurally unable to fire.
        const broken = `const { data } = useTenantSWR<X>(k);\nreturn <>{!data ? <Skeleton/> : <C/>}</>;`;
        expect(CALLS_HOOK.test(broken)).toBe(true);
        expect(GATES_ON_DATA.test(broken)).toBe(true);
        expect(TAKES_ERROR.test(broken)).toBe(false);

        const fixed = `const { data, error, isLoading } = useTenantSWR<X>(k);`;
        expect(TAKES_ERROR.test(fixed)).toBe(true);
    });

    it('no component gates on !data without taking error off the hook', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const src = readFileSync(join(ROOT, file), 'utf8');
            if (!CALLS_HOOK.test(src)) continue;
            if (!GATES_ON_DATA.test(src)) continue;
            if (TAKES_ERROR.test(src)) continue;
            offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });
});
