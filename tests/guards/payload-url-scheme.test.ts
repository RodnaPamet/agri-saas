/**
 * Every URL field in a request payload pins its scheme — repo-wide (#667).
 *
 * #652 pinned the three promotions URL fields and left the rest. This closes
 * the sweep across `src/app-layer/schemas/` + `src/lib/schemas/`, and the file
 * list is derived from the FILESYSTEM so a schema file added tomorrow is
 * covered the moment it exists.
 *
 * ── What the classification actually found ──────────────────────────
 *
 * #667 predicted three fields would be wrong to pin. Measuring each one
 * inverted all three:
 *
 *   · `sso-config.issuer` — "a URN is legitimate". Not for OIDC: Discovery 1.0
 *     §2 requires "a URI with a scheme component that MUST be https, a host
 *     component". The URN intuition belongs to SAML entity IDs, and
 *     `SamlConfigSchema.entityId` is already correctly NOT a `.url()`.
 *   · `automation.url` — "self-hosted operators may want internal http".
 *     `checkWebhookUrl` already refuses non-https at execution time, so the
 *     loose schema was not permissive, it was contradicting the runtime.
 *   · `push.endpoint` — "rejecting one silently breaks a device". It is a
 *     server-side fetch target from client input, and `web-push@3.6.7` does no
 *     scheme validation at all (measured: it attempts
 *     `http://169.254.169.254/`). Leaving it open was the riskier half.
 *
 * And the peer-review candidate for exemption, `automation.linkUrl`, turned
 * out to be the one field that can put an absolute URL into a `<Link href>` —
 * all ten in-repo producers write relative in-app paths, and production agrees
 * (3660 notification rows with a link, 0 absolute).
 *
 * So every REQUEST field measured out as pin. The two allowlist entries below
 * came from somewhere else entirely: the filesystem-derived scan found two
 * fields the issue's hand-counted table of 15 had missed, because they are not
 * `.url()` at all — the detector also matches on a name ending in `Url`. Both
 * are output-DTO fields carrying server-minted relative paths, which
 * `httpsUrl()` would REJECT. That is the shape a real exemption has, and it is
 * an argument for scanning by name rather than by call.
 *
 * ── Severity, stated so nobody re-derives it in a panic ─────────────
 *
 * This is contract-narrowing, not XSS remediation. React 19 rewrites
 * `javascript:` hrefs and the CSP carries no `unsafe-inline` in `script-src`.
 * What survives both is the plain `http://` downgrade and a field contract far
 * wider than the field's purpose. See `src/lib/schemas/url.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { findUnpinnedUrlFields } from '../helpers/url-field-parser';

const REPO = path.resolve(__dirname, '..', '..');
const SCHEMA_DIRS = [
    path.join('src', 'app-layer', 'schemas'),
    path.join('src', 'lib', 'schemas'),
];

/**
 * Fields deliberately left open, keyed `<repo-relative path>:<field>`.
 *
 * An entry is a DECISION, and the reason is the deliverable — "it was already
 * like that" is not one. The `no stale entries` test below deletes the
 * exemption's cover the moment the field is pinned, so an entry cannot outlive
 * its reason.
 */
const OPEN_BY_DESIGN: Record<string, string> = {
    // Output DTO, not a request payload: `portfolio.ts` describes RESPONSE
    // shapes, and both of these carry a server-minted RELATIVE path
    // (`/t/<slug>/dashboard`, `/t/<slug>/evidence/<id>` — see
    // `usecases/portfolio.ts:169,180,447,691`). No client value ever reaches
    // them, and `httpsUrl()` would reject the relative path they actually
    // hold. Pinning these would be a bug, not a narrowing.
    'src/app-layer/schemas/portfolio.ts:drillDownUrl':
        'output DTO carrying a server-minted relative in-app path; https would reject it',
};

/** Every `.ts` under the schema directories, filesystem-derived. */
function schemaFiles(): string[] {
    const out: string[] = [];
    for (const rel of SCHEMA_DIRS) {
        const dir = path.join(REPO, rel);
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.ts')) {
                out.push(path.join(rel, entry.name));
            }
        }
    }
    return out.sort();
}

function scanAll(): { keys: string[]; unpinned: string[] } {
    const keys: string[] = [];
    const unpinned: string[] = [];
    for (const rel of schemaFiles()) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
        const scan = findUnpinnedUrlFields(rel, src);
        keys.push(...scan.keys);
        unpinned.push(...scan.unpinned);
    }
    return { keys, unpinned };
}

describe('payload URL fields pin their scheme', () => {
    test('the scan still resolves — a broken parser must not report clean', () => {
        const { keys } = scanAll();
        // 18 today (15 from #667 + the 3 #652 already pinned). The floor is
        // the anti-vacuity check: an empty `unpinned` below means nothing if
        // the parser stopped finding fields.
        expect(keys.length).toBeGreaterThanOrEqual(15);
        expect(schemaFiles().length).toBeGreaterThanOrEqual(8);
    });

    test('no payload URL field accepts an arbitrary scheme', () => {
        const { unpinned } = scanAll();
        const unexcused = unpinned.filter((line) => {
            const [loc] = line.split(' — ');
            const file = loc.slice(0, loc.lastIndexOf(':'));
            const field = line.split(' — ')[1].split(' ')[0];
            return OPEN_BY_DESIGN[`${file}:${field}`] === undefined;
        });
        expect(unexcused).toEqual([]);
    });

    test('no stale entries — an exemption cannot outlive its reason', () => {
        const { keys, unpinned } = scanAll();
        const stillOpen = new Set(
            unpinned.map((line) => {
                const [loc] = line.split(' — ');
                const file = loc.slice(0, loc.lastIndexOf(':'));
                return `${file}:${line.split(' — ')[1].split(' ')[0]}`;
            }),
        );
        for (const [key, reason] of Object.entries(OPEN_BY_DESIGN)) {
            expect(keys).toContain(key); // the field still exists
            expect(stillOpen.has(key)).toBe(true); // …and is still unpinned
            expect(reason.trim().length).toBeGreaterThan(20); // …with a real reason
        }
    });

    test('every exemption carries a written reason', () => {
        for (const [key, reason] of Object.entries(OPEN_BY_DESIGN)) {
            expect(typeof reason).toBe('string');
            expect(reason).not.toMatch(/^(todo|tbd|n\/a|it was already like that)$/i);
            expect(key).toMatch(/^src\/.+\.ts:.+$/);
        }
    });
});

/**
 * The real allowlist has one key covering two occurrences, so the tests above
 * exercise the happy path but never the failure modes. These do — the
 * mechanism is driven against probe sources rather than trusted because it
 * compiles.
 */
describe('the allowlist mechanism itself', () => {
    const PROBE = `
import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';
export const S = z.object({
    goodUrl: httpsUrl().optional(),
    badUrl: z.string().url(),
});
`;

    it('flags the unpinned field and not the pinned one', () => {
        const scan = findUnpinnedUrlFields('probe.ts', PROBE);
        expect(scan.keys).toEqual(['probe.ts:goodUrl', 'probe.ts:badUrl']);
        expect(scan.unpinned).toHaveLength(1);
        expect(scan.unpinned[0]).toContain('badUrl');
    });

    it('an allowlist entry silences exactly its own field', () => {
        const allow: Record<string, string> = {
            'probe.ts:badUrl': 'a reason long enough to be a real one',
        };
        const scan = findUnpinnedUrlFields('probe.ts', PROBE);
        const unexcused = scan.unpinned.filter((line) => {
            const field = line.split(' — ')[1].split(' ')[0];
            return allow[`probe.ts:${field}`] === undefined;
        });
        expect(unexcused).toEqual([]);

        // …and does NOT silence a second unpinned field added later.
        const two = findUnpinnedUrlFields(
            'probe.ts',
            PROBE.replace('    badUrl: z.string().url(),', '    badUrl: z.string().url(),\n    otherUrl: z.string().url(),'),
        );
        const stillLoud = two.unpinned.filter((line) => {
            const field = line.split(' — ')[1].split(' ')[0];
            return allow[`probe.ts:${field}`] === undefined;
        });
        expect(stillLoud).toHaveLength(1);
        expect(stillLoud[0]).toContain('otherUrl');
    });

    it('a stale entry — the field got pinned — is caught', () => {
        const allow = { 'probe.ts:badUrl': 'stale reason, field since pinned' };
        const pinned = PROBE.replace('badUrl: z.string().url(),', 'badUrl: httpsUrl(),');
        const scan = findUnpinnedUrlFields('probe.ts', pinned);
        const stillOpen = new Set(
            scan.unpinned.map((l) => `probe.ts:${l.split(' — ')[1].split(' ')[0]}`),
        );
        for (const key of Object.keys(allow)) {
            expect(stillOpen.has(key)).toBe(false); // the staleness this catches
        }
    });

    it('a stale entry — the field got deleted — is caught', () => {
        const allow = { 'probe.ts:goneUrl': 'field no longer exists' };
        const scan = findUnpinnedUrlFields('probe.ts', PROBE);
        for (const key of Object.keys(allow)) {
            expect(scan.keys).not.toContain(key);
        }
    });
});

/**
 * The parser must read code, not prose. Live condition: several of the pinned
 * schemas now carry docblocks that QUOTE `z.string().url()` while explaining
 * why the field no longer uses it. A grep-based guard would flag those.
 */
describe('prose is not code', () => {
    it('a docblock mentioning z.string().url() next to a pinned field is not flagged', () => {
        const src = `
import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';
export const S = z.object({
    /** Was z.string().url(); see #667 for why it is now pinned. */
    ctaUrl: httpsUrl().optional(),
});
`;
        expect(findUnpinnedUrlFields('probe.ts', src).unpinned).toEqual([]);
    });

    it('and the real repo contains that exact condition', () => {
        // Asserted across ALL schema files rather than one named file, so
        // rewording a single docblock cannot fail this for a cosmetic reason
        // while the condition is still live somewhere.
        const quoting = schemaFiles().filter((rel) =>
            fs.readFileSync(path.join(REPO, rel), 'utf-8').includes('z.string().url()'),
        );
        expect(quoting.length).toBeGreaterThanOrEqual(1);
        for (const rel of quoting) {
            const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
            expect(findUnpinnedUrlFields(rel, src).unpinned).toEqual([]);
        }
    });
});
