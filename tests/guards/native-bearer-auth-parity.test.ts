/**
 * An API route must not reach for `getServerSession` directly.
 *
 * ## What this protects
 *
 * The native iOS client (`RodnaPamet/agrent-ios`) authenticates with PKCE and
 * then calls this API with `Authorization: Bearer <token>`. That works because
 * `auth()` in `src/auth.ts` is a WRAPPER: it tries the cookie session first and,
 * only when there is none, lazily imports `resolveBearerSession()` and resolves
 * the native principal.
 *
 *     auth()  ->  getServerSession(authOptions)   // cookie
 *             ->  resolveBearerSession()          // bearer, if no cookie
 *
 * A route that imports `getServerSession` from `next-auth` itself SKIPS that
 * fallback. It keeps working perfectly in a browser and returns 401 to the
 * phone — the failure mode that reads as a broken app rather than a missing
 * feature, and the one least likely to be noticed by anyone testing on desktop.
 *
 * Measured 2026-09-20: five routes did exactly this, and all five were
 * account-level features a client needs on day one —
 * `/account/profile`, `/account/language`, `/account/avatar`,
 * `/account/avatar/[userId]` and `/promotions/[id]/image`.
 *
 * ## Why this guard and not the parity test
 *
 * `tests/unit/bearer-cookie-parity.test.ts` proves the MIDDLEWARE answers a
 * bearer and a cookie identically. It cannot see a route that never asks the
 * middleware's question. The two are complementary: that one pins the
 * mechanism, this one pins that every route uses it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** Direct import of the un-wrapped helper — the thing that breaks bearer auth. */
const RAW_IMPORT = /import\s*\{[^}]*\bgetServerSession\b[^}]*\}\s*from\s*['"]next-auth['"]/;

function apiFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app/api'],
        extensions: ['.ts'],
        // ~390 .ts files under src/app/api today. The floor sits far below so
        // ordinary churn never trips it, and only an empty scan does. The
        // collector throws on a renamed root (#875) and on falling under this.
        floor: 200,
    });
}

describe('native bearer auth parity — no route bypasses auth()', () => {
    it('control: the scan reads a real population of API files', () => {
        const files = apiFiles();
        expect(files.length).toBeGreaterThan(200);
        for (const f of files) {
            expect(typeof f).toBe('string');
            expect(fs.existsSync(f)).toBe(true);
        }
    });

    it('control: the detector flags a planted offender and spares the correct form', () => {
        // Without this, a regex that matched nothing would report a clean API
        // surface — the empty-selection pass this whole guard class exists for.
        expect(RAW_IMPORT.test("import { getServerSession } from 'next-auth';")).toBe(true);
        expect(RAW_IMPORT.test('import { getServerSession } from "next-auth";')).toBe(true);
        expect(RAW_IMPORT.test("import { getServerSession, getSession } from 'next-auth';")).toBe(true);
        // The correct form must NOT be flagged, or the guard would be
        // unsatisfiable and someone would delete it.
        expect(RAW_IMPORT.test("import { auth } from '@/auth';")).toBe(false);
        expect(RAW_IMPORT.test("import { authOptions } from '@/auth';")).toBe(false);
    });

    it('control: the wrapper it defends still has the bearer fallback', () => {
        // If `auth()` ever stops falling back to the bearer principal, this
        // guard would be policing a rule that no longer buys anything.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src/auth.ts'), 'utf8');
        expect(src).toMatch(/resolveBearerSession/);
        expect(src).toMatch(/export async function auth\(/);
    });

    it('no API route imports getServerSession from next-auth directly', () => {
        const offenders: string[] = [];
        for (const file of apiFiles()) {
            if (RAW_IMPORT.test(fs.readFileSync(file, 'utf8'))) {
                offenders.push(path.relative(REPO_ROOT, file));
            }
        }
        expect({ offenders }).toEqual({ offenders: [] });
    });
});
