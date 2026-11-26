/**
 * `RlsBypassReason` and `REASON_REGISTRY` must name the same reasons — #3095.
 *
 * `runWithoutRls` checks its argument against `KNOWN_REASONS`, which is built
 * from `Object.keys(REASON_REGISTRY)` — a SECOND object literal, a few lines
 * below the union type that gives the argument its compile-time shape. So
 * there are two spellings of one list, and they fail in opposite directions:
 *
 *   - **In the type, not the registry** — the call site type-checks and then
 *     THROWS at runtime, from inside a privileged read. Whatever that read was
 *     for is now broken on a path a reviewer has no reason to re-examine,
 *     because the diff that added the reason looked complete.
 *   - **In the registry, not the type** — no call site can name it, so the
 *     entry is dead weight that reads as coverage.
 *
 * I walked into the first one while wiring #3095's writer: added
 * `'agro-calendar-overrides'` to the union, type-checked clean, and would have
 * shipped a `runWithoutRls` call that throws the first time an operator
 * corrected a calendar window. Nothing in the repo tested the pairing —
 * measured, `REASON_REGISTRY` had zero references under `tests/`.
 *
 * This is the same class as the two-copy rules CLAUDE.md already names (the
 * route derivation held once in `scripts/lib/api-routes.ts`, the outbox
 * completion mirror, `coverage-groups.mjs`), and the same remedy: one
 * assertion that the copies agree, rather than care.
 *
 * Both extractors are proved against synthetic source, because an extractor
 * that matches nothing makes two empty sets compare equal — the
 * `an-empty-window-passes-a-negated-assertion` shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const SOURCE = 'src/lib/db/rls-middleware.ts';

/**
 * Comments blanked, strings KEPT: the reasons are string literals, so
 * blanking strings would hide the subject. Docblocks name reasons in prose,
 * which is exactly why the comments have to go.
 */
const code = blankNonCode(readFileSync(join(REPO_ROOT, SOURCE), 'utf8'), { strings: false });

/** `| 'some-reason'` arms of the union. */
const TYPE_ARM = /\|\s*'([a-z0-9-]+)'/g;
/** `'some-reason': true` entries of the registry. */
const REGISTRY_KEY = /'([a-z0-9-]+)'\s*:\s*true/g;

function slice(from: string, to: string): string {
    const a = code.indexOf(from);
    const b = code.indexOf(to);
    if (a < 0 || b < 0 || b <= a) {
        throw new Error(`Could not slice ${SOURCE} between '${from}' and '${to}'.`);
    }
    return code.slice(a, b);
}

function extract(block: string, pattern: RegExp): Set<string> {
    return new Set([...block.matchAll(new RegExp(pattern.source, 'g'))].map((m) => m[1]));
}

const typeArms = extract(
    slice('export type RlsBypassReason =', 'const REASON_REGISTRY'),
    TYPE_ARM,
);
const registryKeys = extract(
    slice('const REASON_REGISTRY', 'const KNOWN_REASONS'),
    REGISTRY_KEY,
);

describe('RLS bypass reasons are one list in two places', () => {
    it('prints its denominator', () => {
        console.log(
            `[rls-bypass-reasons] type arms=${typeArms.size} registry keys=${registryKeys.size}`,
        );
        // A floor, so an extractor that stopped matching fails here rather
        // than making two empty sets agree.
        expect(typeArms.size).toBeGreaterThanOrEqual(15);
        expect(registryKeys.size).toBeGreaterThanOrEqual(15);
    });

    describe('the extractors can see (positive controls)', () => {
        it('finds a union arm', () => {
            expect(extract("| 'probe-reason'", TYPE_ARM)).toEqual(new Set(['probe-reason']));
        });

        it('finds a registry entry', () => {
            expect(extract("'probe-reason': true,", REGISTRY_KEY)).toEqual(
                new Set(['probe-reason']),
            );
        });

        it('finds a real member of each, by name', () => {
            // Pinned to a reason that predates this guard, so the controls do
            // not pass merely because the file happens to be non-empty.
            expect(typeArms.has('auth-tenant-discovery')).toBe(true);
            expect(registryKeys.has('auth-tenant-discovery')).toBe(true);
        });

        it('does not read a reason out of a COMMENT', () => {
            const commented = blankNonCode("// | 'ghost-reason'\n", { strings: false });
            expect(extract(commented, TYPE_ARM).size).toBe(0);
        });
    });

    it('every union arm is in the registry — else runWithoutRls throws at runtime', () => {
        const missing = [...typeArms].filter((r) => !registryKeys.has(r)).sort();
        expect(missing).toEqual([]);
    });

    it('every registry key is in the union — else nothing can name it', () => {
        const dead = [...registryKeys].filter((r) => !typeArms.has(r)).sort();
        expect(dead).toEqual([]);
    });
});
