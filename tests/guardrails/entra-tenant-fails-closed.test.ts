/**
 * Structural ratchet for the MICROSOFT_TENANT_ID "no multi-tenant authority
 * in production" enforcement.
 *
 * The defect: `MICROSOFT_TENANT_ID: z.string().default("common")`. `common`
 * is a MULTI-TENANT Entra authority, so a deploy that simply forgot the
 * variable silently chose the widest possible setting — and four of our own
 * example files recommended `common` outright, which made the widest setting
 * the DOCUMENTED one.
 *
 * Why the value is load-bearing rather than cosmetic: an Entra ID token
 * carries no `email_verified` claim, and the `signIn` callback in
 * `src/auth.ts` links an OAuth identity to an existing user whenever the
 * addresses match, guarded only by a check for `email_verified === false`
 * — which an ABSENT claim does not trigger. On a multi-tenant authority
 * those compose: setting a mailbox address in any directory you control
 * becomes signing in as whoever holds that address here. Scoping the
 * authority to one directory is what keeps the composition out of reach.
 *
 * Production was found correctly scoped to a directory GUID when this
 * landed, so this is hardening against a future deploy, a new environment,
 * or anyone following our own examples — not an incident.
 *
 * Enforcement lives on two surfaces, and a "simplify the env schema" PR
 * could quietly drop either:
 *
 *   1. Zod schema — a production-gated `superRefine` on the field.
 *   2. Operator documentation — the prod/staging examples must not hand
 *      someone a multi-tenant authority to paste.
 *
 * Functional behaviour (what actually boots and what refuses) is covered by
 * `tests/unit/env.test.ts`. This file asserts only that the surfaces still
 * exist, which is the part a refactor silently removes. Mirrors
 * `tests/guardrails/redis-prod-required.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Authorities that admit users from directories we do not control. */
const MULTI_TENANT = ['common', 'organizations', 'consumers'];

/** The examples an operator copies when standing up a deployed environment. */
const DEPLOYED_EXAMPLES = [
    '.env.production.example',
    '.env.staging.example',
    'deploy/.env.prod.example',
];

function readCode(rel: string): string {
    return blankNonCode(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
}

describe('Entra tenant fails closed — schema layer', () => {
    const src = readCode('src/env.ts');

    it('control: the schema was read and declares the field', () => {
        expect(src).toMatch(/MICROSOFT_TENANT_ID/);
    });

    it('the MICROSOFT_TENANT_ID field itself carries a superRefine', () => {
        // Windowed deliberately. A global match for `superRefine` would pass
        // thanks to REDIS_URL's or DATA_ENCRYPTION_KEY's refinement while
        // this field had none — the exact shape this guard exists to catch.
        const at = src.indexOf('MICROSOFT_TENANT_ID');
        expect(at).toBeGreaterThan(-1);
        const field = src.slice(at, at + 2000);
        expect(field).toContain('superRefine');
        expect(field).toContain('NODE_ENV');
    });

    it('the refinement knows every multi-tenant authority, not just "common"', () => {
        // A check that only knew the literal `common` would pass while an
        // operator picked `organizations` from Microsoft's own documentation.
        const at = src.indexOf('MICROSOFT_TENANT_ID');
        const field = src.slice(at, at + 2000);
        for (const authority of MULTI_TENANT) {
            expect(field).toContain(authority);
        }
    });

    it('the opt-in escape hatch is declared in the schema', () => {
        // Declared rather than read as an ambient magic string, so the
        // override is discoverable and greppable.
        expect(src).toContain('ENTRA_ALLOW_MULTITENANT');
    });
});

describe('Entra tenant fails closed — operator documentation', () => {
    it('control: each deployed example exists and names the variable', () => {
        for (const rel of DEPLOYED_EXAMPLES) {
            const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
            expect(raw).toContain('MICROSOFT_TENANT_ID');
        }
    });

    it('no deployed example assigns a multi-tenant authority', () => {
        // The original defect was as much documentation as code: three of
        // these files told an operator to paste `common` into production.
        for (const rel of DEPLOYED_EXAMPLES) {
            const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
            for (const line of raw.split(/\r?\n/)) {
                const m = /^\s*MICROSOFT_TENANT_ID\s*=\s*"?([^"\s#]*)"?/.exec(line);
                if (!m) continue;
                expect(MULTI_TENANT).not.toContain(m[1].trim().toLowerCase());
            }
        }
    });

    it('each deployed example explains why, not just what', () => {
        // A bare placeholder gets "fixed" back to `common` by the next
        // person who cannot get sign-in working. The reason has to travel
        // with the value.
        for (const rel of DEPLOYED_EXAMPLES) {
            const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
            const at = raw.indexOf('MICROSOFT_TENANT_ID');
            // Look at the commentary immediately preceding the assignment.
            const preamble = raw.slice(Math.max(0, at - 900), at).toLowerCase();
            expect(preamble).toContain('multi-tenant');
        }
    });
});
