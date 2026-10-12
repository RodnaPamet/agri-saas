/**
 * Guard: a server-rendered page that resolves a session reaches the suspension
 * check, or says why not (#1657).
 *
 * ## The sibling, and why this is not it
 *
 * `api-routes-resolve-sessions-through-the-gate` holds the raw-`auth()` count
 * at zero under `src/app/api` (#1652). It printed, deliberately, the number it
 * was NOT covering:
 *
 *     OUT OF SCOPE: 19 non-API file(s) under src/app call auth().
 *
 * This is that number, governed. #1657 asked for exactly this — *"fold the
 * count into the guard either way, so the number is governed rather than merely
 * printed"* — and warned about the shape to avoid: extending the roots with 19
 * blanket exemptions would look like coverage and be none.
 *
 * ## What the classification found
 *
 * I filed #1657 believing most of the 19 reached a ctx resolver via
 * `TenantLayout`. They do not. `getTenantServerContext` takes the `userId` as a
 * PARAMETER, so `getSessionOrThrow` is not on the path and neither is
 * `isAccountSuspended` — **no page reached the check at all**, and four rendered
 * farm data straight from Prisma off a bare `auth()`: `admin/billing`,
 * `admin/rbac`, `t/{slug}/(app)/layout` and the `/tenants` picker.
 *
 * ## Coverage is by SUBTREE, because that is how layouts work
 *
 * A page under `t/{slug}/` is covered by `t/{slug}/layout.tsx`, which resolves
 * the tenant context — so the rule cannot be per-file. A file is a GATE if it
 * calls `redirectIfSuspended` or `getTenantServerContext`, and a gate covers its
 * own directory and everything below it.
 *
 * That is derived from the filesystem rather than listed, so a new page under a
 * gated directory needs nothing, and a new TOP-LEVEL surface fails until
 * somebody decides.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** A bare session resolution. The same pattern the API-side guard uses. */
const RAW_AUTH = /(?<![A-Za-z0-9_$.])auth\s*\(\s*\)/;

/** Either door: the helper itself, or the tenant resolver that calls it. */
const GATE = /\b(?:redirectIfSuspended|getTenantServerContext)\s*\(/;

/**
 * Surfaces that resolve a session and deliberately do NOT check suspension,
 * each with what it renders.
 *
 * The bar is what a suspended person would SEE. "It is only a layout" is not a
 * reason — `account/layout.tsx` is a layout and it is gated, because its
 * subtree renders the person's own data.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
    'src/app/layout.tsx':
        'Reads `session.user.id` for one thing only: namespacing the persistent ' +
        'SWR cache bucket so a second operator on a shared device cannot ' +
        'rehydrate the first one\'s rows. It renders no farm or person data, and ' +
        'gating the ROOT layout would redirect every page in the app including ' +
        '/suspended itself.',
    'src/app/page.tsx':
        'The unauthenticated landing surface. It resolves a session only to ' +
        'decide where to send somebody who already has one, and renders nothing ' +
        'about them — so a suspended account is routed onward and met by the ' +
        'gate on whatever it was routed to.',
    'src/app/start/page.tsx':
        'Onboarding. Renders no existing farm or person data; a suspended ' +
        'account has nothing here to be shown, and the writes it leads to are ' +
        'refused by the API, which IS checked (#1652).',
    'src/app/no-tenant/page.tsx':
        'Informational, for an account with no membership. It shows the signed-in ' +
        'email and a sign-out button, both of which a suspended person needs ' +
        'rather than should be denied — /suspended offers the same two things.',
    'src/app/dashboard/page.tsx':
        'A router, not a surface: it resolves the session to pick a tenant and ' +
        'redirects into `/t/{slug}`, where the gate runs. Renders no data of its ' +
        'own, so gating it would only move the same redirect one hop earlier.',
    'src/app/accept-terms/page.tsx':
        'Consent capture, which an unconsented session is HELD at by the Edge. ' +
        'Renders no farm or person data, and `POST /api/auth/accept-terms` is ' +
        'checked since #1652 — so a suspended account can read the terms and ' +
        'cannot record acceptance.',
    'src/app/invite/[token]/page.tsx':
        'An invite PREVIEW, which proceeds for a suspended account by the same ' +
        'owner ruling that covers the API preview halves (#1652): the ruling was ' +
        'about ACCEPTANCE, this is a read of an invite the person was sent, and ' +
        'the redeem routes refuse. Hiding it would conceal what they are being ' +
        'told about rather than stop them acting on it.',
    'src/app/invite/org/[token]/page.tsx':
        'The organisation half of the invite preview, for the reason given on ' +
        'its tenant sibling above — the ruling was about acceptance, and both ' +
        'redeem paths refuse a suspended account.',
    'src/app/suspended/page.tsx':
        'The destination. It resolves a session only to decide whether to offer ' +
        'sign-out, and gating it would redirect it to ITSELF — an infinite loop ' +
        'on the one page a person reads when they have just lost access. It is ' +
        'deliberately not gated on BEING suspended either: anyone may open it, ' +
        'so its reachability does not depend on the condition it describes.',
    'src/app/org/[orgSlug]/layout.tsx':
        'Resolves an ORG context, which has no suspension story yet: P5.9 ' +
        'suspends a USER and the org surface is platform-admin-adjacent rather ' +
        'than farmer-facing. Listed rather than gated so the decision is ' +
        'visible; it renders no farm data (0 prisma reads, 0 usecase imports, ' +
        'measured).',
};

describe('server-rendered pages reach the suspension check (#1657)', () => {
    const files = collectSourceFiles({
        roots: ['src/app'],
        extensions: ['.ts', '.tsx'],
        exclude: (rel) => rel.startsWith('src/app/api/'),
        // ~470 today. A floor near reality catches an exclude that ate the tree.
        floor: 200,
    });

    const read = (abs: string) => blankNonCode(readFileSync(abs, 'utf8'));

    /** Directories covered by a gate, including everything beneath them. */
    const gatedDirs = files
        .filter((abs) => GATE.test(read(abs)))
        .map((abs) => `${dirname(relative(REPO_ROOT, abs))}/`);

    const covered = (rel: string): boolean =>
        gatedDirs.some((dir) => `${rel}`.startsWith(dir));

    const resolvers = files
        .map((abs) => relative(REPO_ROOT, abs))
        .filter((rel) => RAW_AUTH.test(read(`${REPO_ROOT}/${rel}`)));

    it('prints the denominator', () => {
        console.log(
            `[server-pages-check-suspension] ${files.length} non-API file(s) under ` +
                `src/app; ${resolvers.length} resolve a session; ${gatedDirs.length} ` +
                `gate(s) covering ${resolvers.filter((r) => covered(r)).length} of them; ` +
                `${Object.keys(ALLOWLIST).length} allowlisted.`,
        );
        expect(files.length).toBeGreaterThan(200);
        // The gates have to EXIST, or "everything is covered or excused" is
        // satisfied by a tree with no checks and a long allowlist.
        expect(gatedDirs.length).toBeGreaterThanOrEqual(3);
    });

    it('every session-resolving page is gated or excused', () => {
        const open = resolvers.filter((r) => !covered(r) && !(r in ALLOWLIST));
        if (open.length > 0) {
            throw new Error(
                `${open.length} server-rendered file(s) resolve a session and never ` +
                    `reach the suspension check:\n\n` +
                    open.map((f) => `  ${f}`).join('\n') +
                    `\n\nCall redirectIfSuspended(userId) from '@/lib/auth/suspension-page' ` +
                    `after your own unauthenticated branch — or, if the surface ` +
                    `deliberately renders for a suspended account, add an ALLOWLIST ` +
                    `entry here saying what it renders. "It is only a layout" is not a ` +
                    `reason; account/layout.tsx is a layout and it is gated.`,
            );
        }
        expect(open).toEqual([]);
    });

    it('carries a substantive reason per exemption, and no stale ones', () => {
        for (const [path, reason] of Object.entries(ALLOWLIST)) {
            expect(reason.trim().length).toBeGreaterThan(140);
            // Stale in either direction: the file stopped resolving a session,
            // or it has since been gated and the entry is now a lie.
            expect(resolvers).toContain(path);
            expect(covered(path)).toBe(false);
        }
    });

    it('the INDIRECT gate really checks — the hop this guard takes on trust', () => {
        // `GATE` counts `getTenantServerContext(` as coverage, which is a hop
        // removed from the actual check: the file calls a resolver that calls
        // `redirectIfSuspended`. Without this assertion, deleting the check
        // from the resolver leaves every tenant page "covered" and the guard
        // green — measured, as a surviving mutation, before this was added.
        //
        // So the hop is verified rather than assumed, and the mutation now
        // fails here.
        const resolver = blankNonCode(
            readFileSync(`${REPO_ROOT}/src/lib/server/tenant-context.server.ts`, 'utf8'),
        );
        expect(resolver).toContain('redirectIfSuspended(params.userId)');
        // And BEFORE the membership lookup: after it, a suspended member gets
        // the resolver's throw, which the layout turns into "no such farm".
        //
        // Anchored on the CALL spellings, not the bare names. The first version
        // compared `indexOf('redirectIfSuspended')` against
        // `indexOf('resolveTenantContext(')` and was inert: both names appear
        // in the IMPORT block at the top, so it was comparing line 17 with line
        // 16 and would pass whatever the body did. Measured — moving the call
        // after the resolver left all five tests green.
        expect(resolver.indexOf('await redirectIfSuspended(params.userId)')).toBeLessThan(
            resolver.indexOf('await resolveTenantContext('),
        );
        // Both anchors must EXIST, or `indexOf` returns -1 and `-1 < n` is
        // trivially true — the comparison would pass by matching nothing.
        expect(resolver).toContain('await resolveTenantContext(');
    });

    it('the three data-rendering surfaces are gated, not excused', () => {
        // The ones the classification found rendering real data. Named
        // explicitly because they are the reason this guard exists, and an
        // allowlist entry for any of them would be a regression that the
        // assertion above would otherwise accept.
        for (const rel of [
            'src/app/t/[tenantSlug]/(app)/admin/billing/page.tsx',
            'src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx',
            'src/app/tenants/page.tsx',
            'src/app/account/layout.tsx',
        ]) {
            expect(covered(rel)).toBe(true);
            expect(ALLOWLIST[rel]).toBeUndefined();
        }
    });
});
