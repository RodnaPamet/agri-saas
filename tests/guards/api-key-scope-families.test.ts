/**
 * The API-key scope vocabulary keeps up with the API.
 *
 * `API_KEY_SCOPE_FAMILIES` is the list of path families a key's scopes may
 * name. A family absent from it cannot be reached by any key — including a `*`
 * key — which is the fail-closed default that makes adding a route safe.
 *
 * Fail-closed is only half a policy, though. Left alone, the list silently
 * falls behind the route tree, and a family added a year from now is refused
 * for reasons nobody remembers deciding. So this guard compares the list
 * against the filesystem and fails when they diverge, in EITHER direction:
 *
 *   - a new path family means someone must decide whether keys may reach it
 *     (adding it is a one-line, reviewed act — and NOT adding it is equally
 *     valid, which is why the refusal is a documented exclusion rather than an
 *     omission);
 *   - a family in the list that no longer exists is a scope customers can be
 *     issued that grants access to nothing.
 */
import * as path from 'node:path';

import { API_KEY_SCOPE_FAMILIES } from '@/lib/auth/api-key-scope';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const TENANT_API_DIR = path.join(REPO_ROOT, 'src/app/api/t/[tenantSlug]');

/**
 * Families deliberately withheld from key access.
 *
 * Empty today: every family is scopable, because a scope must still be GRANTED
 * for a key to use one, and withholding a family here is a second, blunter
 * control that nobody has needed yet. Listing one is how to refuse a surface
 * to machine clients outright — `sso` or `security` would be the candidates.
 */
const DELIBERATELY_EXCLUDED: readonly string[] = [
    // P6.1 (#1810). `PUT /farm-brand/publication` is the only route here, and
    // it is the act of making a real farm's identity public — a page that can
    // be shared, printed onto A6 paper and into a QR code (P6.7), and later
    // indexed. It is gated on `assertCanAdmin` for that reason.
    //
    // Excluded rather than scoped because the question an API key answers is
    // "may this machine client do routine work on my behalf", and publishing
    // is not routine: it is a one-off decision with a consent record attached,
    // and the consent is the OWNER's. A key that could flip it would let an
    // integration publish a farm whose owner never saw the sheet.
    //
    // The current behaviour is already refusal (fail-closed), so this entry
    // changes nothing at runtime — it records that the refusal is a decision.
    // Revisit if an integration ever has a real reason to publish, which would
    // also need an answer for whose consent it is acting under.
    'farm-brand',
];

/**
 * The families that actually carry routes.
 *
 * Derived from `collectSourceFiles` rather than a `readdirSync`, because a
 * hand-rolled collector can be gutted to return `[]` with every assertion
 * built on it still green — `file-collection-is-not-silently-empty` measured
 * that at 81 percent of the guards it could audit, and refuses new ones. The
 * helper's `floor` is the stronger guarantee: it REFUSES to return a short
 * list rather than reporting one.
 *
 * Deriving from route files rather than directories also asks the better
 * question. A directory with no route under it is not a reachable surface, so
 * it needs no scope.
 */
function familiesOnDisk(): string[] {
    const files = collectSourceFiles({
        roots: [TENANT_API_DIR],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith('route.ts'),
        floor: 200,
    });
    const families = new Set(
        files.map((f) => path.relative(TENANT_API_DIR, f).split(path.sep)[0]),
    );
    return [...families].sort();
}

describe('the scope vocabulary tracks the route tree', () => {
    const onDisk = familiesOnDisk();

    it('finds the route tree (positive control)', () => {
        // An empty read would make every assertion below vacuously true.
        expect(onDisk.length).toBeGreaterThan(30);
    });

    it('every path family is either scopable or deliberately excluded', () => {
        const unaccounted = onDisk.filter(
            (f) => !API_KEY_SCOPE_FAMILIES.includes(f) && !DELIBERATELY_EXCLUDED.includes(f),
        );
        if (unaccounted.length > 0) {
            throw new Error(
                `New tenant API path families are not accounted for in the API-key scope ` +
                    `vocabulary:\n\n  ${unaccounted.join('\n  ')}\n\n` +
                    `API keys are refused there (fail-closed, which is the safe default). ` +
                    `Decide deliberately: add each to API_KEY_SCOPE_FAMILIES in ` +
                    `src/lib/auth/api-key-scope.ts to allow scoped access, or to ` +
                    `DELIBERATELY_EXCLUDED in this file to record that machine clients ` +
                    `must not reach it.`,
            );
        }
        expect(unaccounted).toEqual([]);
    });

    it('no scopable family has been deleted from the API', () => {
        // A scope customers can be granted that reaches nothing is a support
        // cycle waiting to happen.
        const stale = API_KEY_SCOPE_FAMILIES.filter((f) => !onDisk.includes(f));
        expect(stale).toEqual([]);
    });

    it('the four pre-existing scope resources are still scopable', () => {
        // Backward compatibility, explicitly. Every key ever issued was scoped
        // with some of these; dropping one silently revokes live credentials.
        for (const legacy of ['evidence', 'tasks', 'reports', 'admin']) {
            expect(API_KEY_SCOPE_FAMILIES).toContain(legacy);
        }
    });
});
