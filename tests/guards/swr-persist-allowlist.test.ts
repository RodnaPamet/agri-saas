/**
 * The persist allowlist stays an allowlist, and stays small.
 *
 * The behaviour is covered by executing tests
 * (`tests/rendered/swr-persist-allowlist.test.tsx`). This guard exists for
 * the two things a behavioural test cannot see:
 *
 *  1. That the policy is still an ALLOWLIST. Flipping it to a denylist
 *     would keep every existing test green — the allowed endpoints still
 *     persist, the named ones still don't — while silently reopening the
 *     class. The whole point is that an endpoint nobody has written yet is
 *     safe by DEFAULT, and only the direction of the check delivers that.
 *
 *  2. That growth is deliberate. Each entry is a decision that this
 *     response is acceptable on a phone that may be lost, sold, or handed
 *     to another worker. A list that grows without anyone noticing is how
 *     `lessorName` reached plaintext localStorage in the first place: not
 *     by decision, but because the Rent page used the same hook as
 *     everything else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src/lib/swr/persistent-cache.ts');

function source(): string {
    return fs.readFileSync(SRC, 'utf8');
}

function allowlist(): string[] {
    const m = source().match(/const PERSISTABLE_PATHS: readonly string\[\] = \[([\s\S]*?)\];/);
    if (!m) {
        throw new Error(
            'PERSISTABLE_PATHS not found in src/lib/swr/persistent-cache.ts. If it was ' +
                'renamed or removed, this guard is protecting nothing — update it in the ' +
                'same change, and make sure the replacement is still an ALLOWLIST.',
        );
    }
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('the SWR persist allowlist', () => {
    it('is readable and non-empty', () => {
        expect(allowlist().length).toBeGreaterThan(0);
    });

    it('holds only the cold-start lists, and stays that size without a decision', () => {
        // Not a floor — a CAP. Adding an endpoint means deciding its
        // response may sit on a lost phone. Raise this number in the same
        // diff, in a PR that says why.
        const MAX_PERSISTED_ENDPOINTS = 4;
        const list = allowlist();
        if (list.length > MAX_PERSISTED_ENDPOINTS) {
            throw new Error(
                `PERSISTABLE_PATHS has grown to ${list.length} entries:\n  ${list.join('\n  ')}\n\n` +
                    `Each entry writes that endpoint's responses to disk on a device that may ` +
                    `be lost, sold, or handed to another worker. If the response carries names, ` +
                    `contacts, identifiers, financial terms, or anything in ENCRYPTED_FIELDS, ` +
                    `it does not belong here — leave it memory-only and let it refetch.\n\n` +
                    `If the addition IS right, raise MAX_PERSISTED_ENDPOINTS in this file in ` +
                    `the same diff and say why in the PR.`,
            );
        }
        expect(list.length).toBeLessThanOrEqual(MAX_PERSISTED_ENDPOINTS);
    });

    it('never lists an endpoint known to carry third-party personal data', () => {
        // The specific ones that were on disk before this landed. Naming
        // them means a future "just add /leases, the Rent page is slow"
        // fails loudly instead of quietly.
        const FORBIDDEN = ['/leases', '/reports/rent-roll', '/admin', '/farm-profile'];
        const offenders = allowlist().filter((p) =>
            FORBIDDEN.some((f) => p === f || p.startsWith(f + '/') || f.startsWith(p + '/')),
        );
        if (offenders.length > 0) {
            throw new Error(
                `PERSISTABLE_PATHS contains ${offenders.join(', ')}. These carry personal ` +
                    `data about people who are not users of this product (ParcelLease.lessorName ` +
                    `/ lessorEik are in ENCRYPTED_FIELDS for that reason), or admin surfaces. ` +
                    `They are encrypted at rest on the server; persisting them puts the ` +
                    `plaintext on a phone.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('gates BOTH funnels — the write and the rehydrate', () => {
        // collectEntries is the single write funnel (flush serialises one
        // array for localStorage AND the IDB spill). applyBucket is the
        // read funnel; without it a bucket already on disk keeps
        // rehydrating disallowed entries into memory and onto the screen.
        const src = source();
        const collect = src.slice(src.indexOf('function collectEntries'));
        const apply = src.slice(src.indexOf('function applyBucket'), src.indexOf('function collectEntries'));
        expect(collect).toMatch(/isPersistableKey\(key\)/);
        expect(apply).toMatch(/isPersistableKey\(key\)/);
    });

    it('is an allowlist, not a denylist — the direction is the feature', () => {
        const src = source();
        // `some(...)` over the allowlist returning TRUE for persistable is
        // the allowlist shape. A denylist would negate it.
        expect(src).toMatch(/return PERSISTABLE_PATHS\.some\(/);
        expect(src).not.toMatch(/const (BLOCKED|DENY|NEVER_PERSIST)_PATHS/);
    });

    it('the cache version was bumped past the pre-allowlist buckets', () => {
        // The allowlist stops new writes; only the version bump removes
        // what is already on operators' phones.
        const m = source().match(/export const SWR_CACHE_VERSION = (\d+)/);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeGreaterThanOrEqual(2);
    });
});
