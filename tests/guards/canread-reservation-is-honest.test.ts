/**
 * `assertCanRead`'s docblock claims no current role is refused. This keeps
 * that claim true (#1766).
 *
 * The owner's ruling was to ANNOTATE rather than change the ladder — the
 * reservation of level 0 is deliberate, and a future read-restricted role
 * below READER would make all 126 call sites bite at once.
 *
 * An annotation is exactly the kind of claim that expires silently. If
 * someone lowers a role beneath the `canRead` threshold, the docblock starts
 * saying the opposite of the truth — and it would then mislead in the MORE
 * dangerous direction, telling a reviewer the line cannot refuse anyone when
 * it can. So the refused set is DERIVED here from the ladder and compared
 * against what the docblock asserts, rather than restated.
 *
 * Deliberately not a test that a role is refused: none is, and writing one
 * would mean inventing a context no HTTP request produces. See the docblock.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CTX = path.join(REPO_ROOT, 'src', 'lib', 'tenant-context.ts');
const POLICIES = path.join(REPO_ROOT, 'src', 'app-layer', 'policies', 'common.ts');

/** `ROLE_ORDER` as the runtime computes it, not as a list here. */
function roleLevels(): Record<string, number> {
    const src = fs.readFileSync(CTX, 'utf8');
    const block = src.slice(src.indexOf('const ROLE_ORDER'));
    const body = block.slice(0, block.indexOf('};'));
    const out: Record<string, number> = {};
    for (const [, role, lv] of body.matchAll(/(\w+):\s*(\d+)/g)) out[role] = Number(lv);
    return out;
}

function threshold(field: 'canRead' | 'canWrite'): number {
    const src = fs.readFileSync(CTX, 'utf8');
    const m = new RegExp(`${field}:\\s*level\\s*>=\\s*(\\d+)`).exec(src);
    if (!m) throw new Error(`could not find the ${field} threshold — the derivation is broken`);
    return Number(m[1]);
}

const refusedBy = (field: 'canRead' | 'canWrite'): string[] => {
    const need = threshold(field);
    return Object.entries(roleLevels())
        .filter(([, lv]) => lv < need)
        .map(([r]) => r)
        .sort();
};

describe('the canRead reservation stays honest', () => {
    it('the ladder is readable at all — positive control', () => {
        // An empty parse would make every assertion below pass over nothing.
        const levels = roleLevels();
        expect(Object.keys(levels).sort()).toEqual(
            ['ADMIN', 'AUDITOR', 'EDITOR', 'MECHANISATOR', 'OWNER', 'READER'].sort(),
        );
        expect(threshold('canRead')).toBeGreaterThan(0);
    });

    it('canRead still refuses NO role, which is what the docblock says', () => {
        // If this fails, the ladder changed and `assertCanRead` became a live
        // gate. That is not a problem to suppress — it is the reservation
        // being taken up. Update the docblock in `policies/common.ts`, which
        // currently tells readers the line cannot refuse anyone, and decide
        // whether the 126 call sites now want tests.
        expect(refusedBy('canRead')).toEqual([]);
    });

    it('canWrite still refuses the three it claims, so the contrast holds', () => {
        // The docblock draws a contrast with `assertCanWrite`. A contrast
        // that stops being true is a worse explanation than none.
        expect(refusedBy('canWrite')).toEqual(['AUDITOR', 'MECHANISATOR', 'READER']);
    });

    it('the docblock actually carries the claim, not just the issue number', () => {
        // Guards against the annotation being trimmed away while these
        // assertions keep passing — at which point the derivation is correct
        // and nobody reads it.
        const src = fs.readFileSync(POLICIES, 'utf8');
        const doc = src.slice(0, src.indexOf('export function assertCanRead'));
        expect(doc).toMatch(/No CURRENT role is refused/i);
        expect(doc).toMatch(/126 call sites/);
        expect(doc).toMatch(/RESERVATION of level 0/i);
    });
});
