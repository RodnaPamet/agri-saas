/**
 * Every documented 409 names the `code` a client switches on (#1391).
 *
 * ## The gap, in the client's words
 *
 * From the agrent-ios inventory: *"iOS currently treats every 409 as a stale
 * edit, so a coded 409 per route would let it tell them apart."*
 *
 * The prose was already good — the catalogue's duplicate-name 409 even said
 * "Not a stale edit — re-reading will not free the name". What it did not do
 * was name the **code**, and `error.code` is the field the spec tells clients
 * to switch on. A sentence a human reads is not a value a client branches on,
 * so a correct description and an undistinguishable response coexisted.
 *
 * Six of the eight were unnamed when this landed. Both named ones were named
 * by accident of how their description happened to be written.
 *
 * ## Why 409 specifically
 *
 * Because its codes fall into two families with **opposite remedies**, and
 * guessing wrong is worse than not guessing:
 *
 *   `STALE_DATA`                    re-read and retry — the write may succeed
 *   `ITEM_NAME_ALREADY_EXISTS`      re-reading changes nothing, ever
 *   `LISTING_INTEREST_ALREADY_SENT` the request already happened; it is a
 *                                   duplicate, not a failure
 *
 * A client that assumes the first family retries forever against the second.
 *
 * ## Derived from the published spec, not from a list
 *
 * The population is every operation in `openapi.json` that declares a 409, so
 * a NEW 409 is in scope the moment it is declared. A curated list is a list
 * somebody forgets (#805).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();

interface Spec {
    paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, { description?: string }> }>>;
}

/**
 * Responses whose machine-readable identifier is NOT an UPPER_SNAKE `code`,
 * each with the reason. An entry is a response that answers a different
 * envelope, not one nobody got round to coding.
 */
const NON_CODE: Readonly<Record<string, string>> = {
    'GET /api/auth/native/complete':
        'Answers a BARE body rather than the `{ error: { code } }` envelope — ' +
        'the native hand-off is pre-session, so there is no envelope to carry a ' +
        'code. Its identifier is the literal `session_not_tracked`, which the ' +
        'description names, and the description says it is bare.',
};

const spec = (): Spec =>
    JSON.parse(readFileSync(join(REPO, 'src/generated/openapi.json'), 'utf8')) as Spec;

/** Every operation declaring a 409, as `VERB /path`. */
function with409(): Array<{ key: string; description: string }> {
    const out: Array<{ key: string; description: string }> = [];
    for (const [p, ops] of Object.entries(spec().paths)) {
        for (const [verb, op] of Object.entries(ops)) {
            if (!op || typeof op !== 'object') continue;
            const r = op.responses?.['409'];
            if (!r) continue;
            out.push({ key: `${verb.toUpperCase()} ${p}`, description: r.description ?? '' });
        }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** A backticked UPPER_SNAKE token of 4+ characters. */
const CODE = /`([A-Z][A-Z0-9_]{3,})`/;

describe('documented 409s name their code (#1391)', () => {
    const ops = with409();

    it('prints the denominator', () => {
        console.log(
            `[documented-409s-name-their-code] ${ops.length} operation(s) declare a 409; ` +
                `${Object.keys(NON_CODE).length} answer a non-envelope body:\n  ` +
                ops.map((o) => o.key).join('\n  '),
        );
        // A spec that stopped declaring 409s, or a parse that returned nothing,
        // would satisfy the assertion below over an empty set.
        expect(ops.length).toBeGreaterThanOrEqual(8);
    });

    it('every one names a code, or is listed with a reason', () => {
        const offenders = ops
            .filter((o) => !CODE.test(o.description) && !(o.key in NON_CODE))
            .map((o) => o.key);
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} operation(s) document a 409 without naming the ` +
                    `\`code\` a client switches on (#1391):\n\n` +
                    offenders.map((o) => `  ${o}`).join('\n') +
                    `\n\nName it in the description, in backticks — e.g. \`STALE_DATA\`. ` +
                    `409 codes split into two families with OPPOSITE remedies: ` +
                    `\`STALE_DATA\` means re-read and retry, a duplicate/collision code ` +
                    `means retrying identically never works. A client that cannot tell ` +
                    `them apart retries forever against the second.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('a stale-edit 409 says so, and a collision 409 says it is NOT one', () => {
        // The families are the point, so the distinction is asserted rather
        // than left to whoever writes the next description. Without this, every
        // 409 could name `STALE_DATA` and satisfy the assertion above.
        const byCode = new Map<string, string[]>();
        for (const o of ops) {
            const m = o.description.match(CODE);
            if (!m) continue;
            byCode.set(m[1], [...(byCode.get(m[1]) ?? []), o.key]);
        }
        // Both families are represented, so neither is a theoretical category.
        expect([...byCode.keys()]).toContain('STALE_DATA');
        expect(byCode.size).toBeGreaterThanOrEqual(3);
        // And the collision descriptions warn against the stale-edit path.
        for (const o of ops) {
            if (/ALREADY_EXISTS|ALREADY_SENT|TAKEN/.test(o.description)) {
                expect(o.description).toMatch(/re-read|stale/i);
            }
        }
    });

    it('every listed non-envelope response carries a substantive reason', () => {
        for (const [key, reason] of Object.entries(NON_CODE)) {
            expect(reason.trim().length).toBeGreaterThan(120);
            // Removes the cover the moment that operation stops declaring a 409.
            expect(ops.map((o) => o.key)).toContain(key);
        }
    });

    it('the code detector can tell a named description from an unnamed one', () => {
        // `a-probe-with-no-discriminating-power`: the assertions above pass the
        // same way when the regex is broken as when every description is right.
        expect(CODE.test('`STALE_DATA` — optimistic-lock conflict.')).toBe(true);
        expect(CODE.test('Optimistic-lock conflict — the entry moved on.')).toBe(false);
        // Prose about a code in lowercase is not a code.
        expect(CODE.test('a stale data conflict')).toBe(false);
        // And a short backticked word is not one either.
        expect(CODE.test('`GET` the row again')).toBe(false);
    });
});
