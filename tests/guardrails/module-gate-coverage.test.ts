/**
 * Guardrail: WP-2 module-gate coverage.
 *
 * Invariant: every API route that belongs to a *module-gated* domain
 * MUST import AND call `assertModuleEnabled(ctx, '<MODULE>')` from
 * `@/app-layer/usecases/modules` with the module key the curated
 * registry records for it. Skipping the call would let a tenant that
 * has switched the domain off ("simple mode") keep hitting the API —
 * defeating the gate.
 *
 * Unlike the HIBP guardrail there is no structural heuristic for
 * "which routes are gated" — module membership is a product decision,
 * not something inferable from the source. So this guardrail is a
 * curated registry only: a route is gated because we say it is, and
 * the test holds each registered route to the import+call contract.
 *
 * How to extend: when you gate a new domain behind a module,
 *   1. `import { assertModuleEnabled } from '@/app-layer/usecases/modules';`
 *      in the route file.
 *   2. `await assertModuleEnabled(ctx, '<MODULE>');` right after
 *      `getTenantCtx(...)` (before any data access).
 *   3. Add an entry to `MODULE_GATED_ROUTES` below with the file path
 *      and the module key so failures are self-documenting and the
 *      gate cannot be silently removed later.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const MODULE_GATED_ROUTES: ReadonlyArray<{
    /** Path relative to repo root. */
    file: string;
    /** The ModuleKey this route is gated behind. */
    module: string;
}> = [
    // Journal (Земеделски дневник) — a simple-mode core module, but a tenant
    // can still toggle it off. The auto-emission path in
    // `recordInputApplication` already honoured that toggle while every CRUD
    // route stayed open; these close the asymmetry.
    { file: 'src/app/api/t/[tenantSlug]/journal/route.ts', module: 'JOURNAL' },
    { file: 'src/app/api/t/[tenantSlug]/journal/[id]/route.ts', module: 'JOURNAL' },
    { file: 'src/app/api/t/[tenantSlug]/journal/[id]/files/route.ts', module: 'JOURNAL' },
    { file: 'src/app/api/t/[tenantSlug]/journal/[id]/restore/route.ts', module: 'JOURNAL' },
    { file: 'src/app/api/t/[tenantSlug]/journal/[id]/purge/route.ts', module: 'JOURNAL' },
    // Certification / compliance (GRC) domain — every list/create entry
    // point is gated behind CERTIFICATION. A simple-mode farm tenant (plan
    // below the CERTIFICATION tier, or the module toggled off) gets a 403
    // here, the API twin of the route-group `requireModule` page redirect.
    {
        file: 'src/app/api/t/[tenantSlug]/access-reviews/route.ts',
        module: 'CERTIFICATION',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/processes/route.ts',
        module: 'CERTIFICATION',
    },
    // Crop-planning domain — gated behind PLANNING. A tenant with the
    // PLANNING module toggled off gets a 403 here, the API twin of the
    // `/planning` route-group `requireModule` redirect.
    {
        file: 'src/app/api/t/[tenantSlug]/planning/seasons/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/seasons/[seasonId]/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/crop-types/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/crop-varieties/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/crop-plans/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/crop-plans/[cropPlanId]/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/crop-plans/[cropPlanId]/generate/route.ts',
        module: 'PLANNING',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/planning/plantings/route.ts',
        module: 'PLANNING',
    },
    {
        // Agro-intel — per-planting Growing Degree Days accumulator.
        file: 'src/app/api/t/[tenantSlug]/planning/plantings/[plantingId]/gdd/route.ts',
        module: 'PLANNING',
    },
    // Enterprise-grain domain — gated behind GRAIN (ENTERPRISE min-plan).
    // A tenant without the GRAIN module (below the tier, or toggled off)
    // gets a 403 here. Contracts + yield records + bins + blending +
    // activity costing — the large grain-producer surface.
    {
        file: 'src/app/api/t/[tenantSlug]/grain/contracts/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/contracts/[contractId]/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/yield-records/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/yield-records/[yieldRecordId]/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/bins/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/bins/[binId]/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/blend/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/grain/costs/route.ts',
        module: 'GRAIN',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/listings/route.ts',
        module: 'EXCHANGE',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/listings/[listingId]/route.ts',
        module: 'EXCHANGE',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/inquiries/route.ts',
        module: 'EXCHANGE',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/inquiries/[inquiryId]/route.ts',
        module: 'EXCHANGE',
    },
    // Future module-gated routes add themselves here.
];

/**
 * Routes in a gated domain that are DELIBERATELY not gated, each with the
 * reason. Recorded — and asserted — rather than simply omitted, so the
 * exemption is a decision a reader finds instead of an absence they have to
 * infer.
 *
 * The rule these share: the EXCHANGE module toggle governs PARTICIPATION in
 * the marketplace (browse, post, inquire, mark sold), not CUSTODY of rows the
 * tenant already posted. Gating custody is what made the module-opt-out defect
 * unrecoverable — a tenant that switched EXCHANGE off kept its listings public
 * (the browse query had no seller-side check) while losing every endpoint that
 * could take them down.
 */
const MODULE_GATE_EXEMPT_ROUTES: ReadonlyArray<{
    file: string;
    module: string;
    reason: string;
}> = [
    // ── Exchange MESSAGING (#1189) ────────────────────────────────────────
    //
    // Owner decision, 2026-10-01: messaging stays UNGATED. The alternative was
    // measured and rejected — gating it would cut a tenant that disables
    // EXCHANGE off from conversations it is already in, including ones where it
    // owes a counterparty a reply, which is the custody problem the rule above
    // already names one level along.
    //
    // Before this, these eight sat in NEITHER list: not gated, not exempt, and
    // invisible to this guardrail, which is a curated list and cannot report a
    // route it has never heard of. `docs/ios-messaging-brief.md` meanwhile told
    // the native client that "all require the EXCHANGE module". So the state
    // was not a decision, it was an absence that read like one.
    //
    // What a tenant with EXCHANGE off still gets, accepted deliberately: it can
    // read and send in existing threads, and it still receives bell rows and
    // notification emails for new messages. The toggle hides the marketplace,
    // not the inbox.
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/threads/route.ts',
        module: 'EXCHANGE',
        reason:
            'The inbox. Listing BOTH sides of every conversation this tenant is party to is ' +
            'custody of correspondence already begun, not participation in the marketplace. ' +
            'A tenant that cannot see its own threads cannot discover that someone is waiting ' +
            'on it.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/threads/[threadId]/route.ts',
        module: 'EXCHANGE',
        reason:
            'Reading one conversation, including its scrollback. Same custody argument as the ' +
            'inbox: the messages already exist and both parties already consented to the ' +
            'thread by opening it.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/threads/[threadId]/messages/route.ts',
        module: 'EXCHANGE',
        reason:
            'Sending a reply. The deliberate edge of this decision — a tenant with EXCHANGE ' +
            'off can still answer. Gating it would leave the counterparty waiting on someone ' +
            'the product has silently muted, which is worse than either answer. Rate-limited ' +
            'per sending tenant by EXCHANGE_MESSAGE_LIMIT, which is the control that bounds ' +
            'abuse here rather than the module toggle.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/threads/[threadId]/read/route.ts',
        module: 'EXCHANGE',
        reason:
            'Moving the read pointer. Gating it would leave a thread permanently unread for ' +
            'the tenant, so the badge it drives would be wrong forever rather than merely ' +
            'inaccessible.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/threads/[threadId]/close/route.ts',
        module: 'EXCHANGE',
        reason:
            'Closing a thread, either party. This is how a tenant winds DOWN its marketplace ' +
            'correspondence, so it is exactly the endpoint a tenant that just switched ' +
            'EXCHANGE off needs most.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/threads/[threadId]/block/route.ts',
        module: 'EXCHANGE',
        reason:
            'Blocking and unblocking a buyer, seller only. A protective control: gating it ' +
            'would mean a tenant could stop receiving the marketplace while losing the one ' +
            'lever that stops a specific counterparty contacting it.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/messages/[messageId]/route.ts',
        module: 'EXCHANGE',
        reason:
            'Retracting your OWN message. Custody in the strictest sense — the row belongs to ' +
            'this tenant, and the same reasoning that keeps my-listings reachable applies ' +
            'with more force to something already sent to a third party.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/listings/[listingId]/thread/route.ts',
        module: 'EXCHANGE',
        reason:
            'Opening a thread against a listing. The ONE entry here that is arguably ' +
            'participation rather than custody, and it is left ungated so the set is ' +
            'coherent: a buyer reaching a seller is the act the rest of this list exists to ' +
            'let both sides finish. Revisit this one first if the decision is ever reversed.',
    },
    {
        file: 'src/app/api/t/[tenantSlug]/exchange/my-listings/route.ts',
        module: 'EXCHANGE',
        reason:
            'Custody read: the seller\'s OWN listings, in their own tenant. Gating it ' +
            'left a tenant that disabled EXCHANGE unable to see the public listings it ' +
            'could no longer withdraw. The read-side seller-module exclusion hides those ' +
            'rows from everyone else; this surface is how the owner cleans them up.',
    },
];

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Import-presence regex. Matches a static ES import of
 * `assertModuleEnabled` from the canonical usecase module path. A bare
 * mention in a comment does NOT match (it won't begin with `import`).
 */
const IMPORT_RE =
    /^\s*import\s+\{[^}]*\bassertModuleEnabled\b[^}]*\}\s+from\s+['"]@\/app-layer\/usecases\/modules['"]/m;

/** Call-site regex for a specific module key: assertModuleEnabled(ctx, 'KEY'). */
function callReFor(moduleKey: string): RegExp {
    return new RegExp(`\\bassertModuleEnabled\\s*\\([^)]*['"]${moduleKey}['"]`);
}

function hasImport(src: string): boolean {
    return IMPORT_RE.test(src);
}

function hasCallFor(src: string, moduleKey: string): boolean {
    const importMatch = src.match(IMPORT_RE);
    const stripped = importMatch ? src.replace(importMatch[0], '') : src;
    return callReFor(moduleKey).test(stripped);
}

// ── Test 1 — curated registry integrity ───────────────────────────────────

describe('module-gate coverage guardrail — registry integrity', () => {
    it('MODULE_GATED_ROUTES is non-empty (sanity)', () => {
        expect(MODULE_GATED_ROUTES.length).toBeGreaterThan(0);
    });

    test.each(MODULE_GATED_ROUTES.map((r) => [r.file, r] as const))(
        '%s imports + calls assertModuleEnabled for its module',
        (relPath, entry) => {
            const abs = path.join(REPO_ROOT, relPath);
            expect(fs.existsSync(abs)).toBe(true);

            const src = fs.readFileSync(abs, 'utf8');

            if (!hasImport(src)) {
                throw new Error(
                    [
                        `Module-gated route missing assertModuleEnabled import.`,
                        ``,
                        `  File:   ${relPath}`,
                        `  Module: ${entry.module}`,
                        `  Add:    import { assertModuleEnabled } from '@/app-layer/usecases/modules';`,
                    ].join('\n'),
                );
            }

            if (!hasCallFor(src, entry.module)) {
                throw new Error(
                    [
                        `Module-gated route imports assertModuleEnabled but never calls it`,
                        `for module '${entry.module}'.`,
                        ``,
                        `  File:   ${relPath}`,
                        `  Module: ${entry.module}`,
                        ``,
                        `A dangling import is a silent bypass. Call`,
                        `  await assertModuleEnabled(ctx, '${entry.module}');`,
                        `right after getTenantCtx(...), then re-run this test.`,
                    ].join('\n'),
                );
            }
        },
    );
});

// ── Test 2 — every entry points at a real file ─────────────────────────────

describe('module-gate coverage guardrail — no stale entries', () => {
    it('every registered route file exists (catches renames/refactors)', () => {
        const missing = [...MODULE_GATED_ROUTES, ...MODULE_GATE_EXEMPT_ROUTES]
            .filter((r) => !fs.existsSync(path.join(REPO_ROOT, r.file)))
            .map((r) => r.file);
        expect(missing).toEqual([]);
    });
});

// ── Test 2b — exemptions are real, reasoned, and mutually exclusive ────────

describe('module-gate coverage guardrail — declared exemptions', () => {
    it('no route is both gated and exempt', () => {
        const gated = new Set(MODULE_GATED_ROUTES.map((r) => r.file));
        const overlap = MODULE_GATE_EXEMPT_ROUTES.filter((r) => gated.has(r.file)).map(
            (r) => r.file,
        );
        expect(overlap).toEqual([]);
    });

    it('every exemption carries a written reason', () => {
        for (const entry of MODULE_GATE_EXEMPT_ROUTES) {
            expect(entry.reason.trim().length).toBeGreaterThan(40);
        }
    });

    test.each(MODULE_GATE_EXEMPT_ROUTES.map((r) => [r.file, r] as const))(
        '%s really does NOT call the gate (a re-gate must update this list)',
        (relPath, entry) => {
            const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
            if (hasCallFor(src, entry.module)) {
                throw new Error(
                    [
                        `Route is registered as module-gate EXEMPT but now calls`,
                        `assertModuleEnabled(ctx, '${entry.module}').`,
                        ``,
                        `  File: ${relPath}`,
                        ``,
                        `If gating it is the intent, move the entry from`,
                        `MODULE_GATE_EXEMPT_ROUTES to MODULE_GATED_ROUTES in the same diff.`,
                    ].join('\n'),
                );
            }
        },
    );
});

// ── Test 3 — regression proof ──────────────────────────────────────────────

describe('module-gate coverage guardrail — regression proof', () => {
    it('detector catches a mutated route that drops the gate import/call', () => {
        const entry = MODULE_GATED_ROUTES[0];
        const abs = path.join(REPO_ROOT, entry.file);
        const realSrc = fs.readFileSync(abs, 'utf8');

        // The real file passes.
        expect(hasImport(realSrc)).toBe(true);
        expect(hasCallFor(realSrc, entry.module)).toBe(true);

        // Simulate a PR that strips both the import and the call.
        const importMatch = realSrc.match(IMPORT_RE);
        // Strip ALL gate calls (entry routes may export several handlers,
        // each with its own assertModuleEnabled) so the mutated source
        // models a fully gate-removed route.
        const callReGlobal = new RegExp(callReFor(entry.module).source, 'g');
        const mutated = (importMatch ? realSrc.replace(importMatch[0], '') : realSrc).replace(
            callReGlobal,
            '/* gate-removed */',
        );

        expect(hasImport(mutated)).toBe(false);
        expect(hasCallFor(mutated, entry.module)).toBe(false);
    });
});
