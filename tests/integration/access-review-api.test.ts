/**
 * Epic G-4 — API contract tests for the access-review surface.
 *
 * Static / structural tests that prove:
 *   • Each route exists at the expected path
 *   • Each route delegates to the correct usecase
 *   • Each mutation route uses `withValidatedBody` with the right schema
 *   • Both UI pages exist + reach into their client islands
 *
 * Runtime + permission semantics are exercised by the usecase
 * integration tests; this file is the wiring ratchet.
 */
import * as fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('Epic G-4 — access-review API + UI wiring', () => {
    const listRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/route.ts',
    );
    const detailRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/route.ts',
    );
    const decisionRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/route.ts',
    );
    const closeRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/close/route.ts',
    );
    const evidenceRoute = read(
        'src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/evidence/route.ts',
    );
    const listPage = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/page.tsx',
    );
    const listClient = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx',
    );
    const detailPage = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/page.tsx',
    );
    const detailClient = read(
        'src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx',
    );

    // ── 1. Route surface exists + delegates ────────────────────────

    it('GET /access-reviews delegates to listAccessReviews', () => {
        expect(listRoute).toMatch(/export const GET/);
        expect(listRoute).toContain('listAccessReviews');
        // Backfill cap discipline like every other list route.
        expect(listRoute).toContain('LIST_BACKFILL_CAP');
        expect(listRoute).toContain('applyBackfillCap');
        expect(listRoute).toContain('recordListPageRowCount');
    });

    it('POST /access-reviews validates with CreateAccessReviewSchema and calls createAccessReview', () => {
        expect(listRoute).toMatch(/export const POST/);
        expect(listRoute).toContain('CreateAccessReviewSchema');
        expect(listRoute).toContain('withValidatedBody');
        expect(listRoute).toContain('createAccessReview');
    });

    it('GET /access-reviews/:reviewId delegates to getAccessReviewWithActivity', () => {
        expect(detailRoute).toMatch(/export const GET/);
        expect(detailRoute).toContain('getAccessReviewWithActivity');
    });

    it('PUT decisions route validates with SubmitDecisionSchema and calls submitDecision', () => {
        expect(decisionRoute).toMatch(/export const PUT/);
        expect(decisionRoute).toContain('SubmitDecisionSchema');
        expect(decisionRoute).toContain('withValidatedBody');
        expect(decisionRoute).toContain('submitDecision');
    });

    it('POST close route delegates to closeAccessReview', () => {
        expect(closeRoute).toMatch(/export const POST/);
        expect(closeRoute).toContain('closeAccessReview');
    });

    it('GET evidence route asserts read + uses storage provider stream', () => {
        expect(evidenceRoute).toMatch(/export const GET/);
        expect(evidenceRoute).toContain('assertCanRead');
        expect(evidenceRoute).toContain('readStream');
        expect(evidenceRoute).toContain('Content-Disposition');
        // Privacy: never cache the artifact in shared caches.
        expect(evidenceRoute).toContain("Cache-Control");
        expect(evidenceRoute).toContain('private, no-store');
    });

    // ── 2. Tenant scoping invariant ─────────────────────────────────

    it('every route uses getTenantCtx so the tenant gate runs', () => {
        for (const src of [
            listRoute,
            detailRoute,
            decisionRoute,
            closeRoute,
            evidenceRoute,
        ]) {
            expect(src).toContain('getTenantCtx');
        }
    });

    // ── 3. Pages exist + import their client islands ───────────────

    it('list page exists, force-dynamic, and mounts AccessReviewsClient', () => {
        expect(listPage).toContain("'force-dynamic'");
        expect(listPage).toContain('AccessReviewsClient');
        expect(listPage).toContain('listAccessReviews');
    });

    it('detail page exists, force-dynamic, and mounts AccessReviewDetailClient', () => {
        expect(detailPage).toContain("'force-dynamic'");
        expect(detailPage).toContain('AccessReviewDetailClient');
        expect(detailPage).toContain('getAccessReviewWithActivity');
    });

    // ── 4. List client surface — title + create button + table ─────

    it('list client surfaces the title, create-button, progress bar, and a row testid', () => {
        expect(listClient).toContain('access-reviews-title');
        expect(listClient).toContain('access-review-new-campaign-button');
        expect(listClient).toContain('ProgressBar');
        // Per-row testid uses the campaign id — the smoke test below
        // looks for the prefix.
        expect(listClient).toContain('access-review-row-');
    });

    // ── 5. Detail client — decision dropdown + close + download ────

    it('detail client has decision dropdown + close + download-evidence affordances', () => {
        expect(detailClient).toContain('decision-select-');
        expect(detailClient).toContain('decision-modal-submit');
        expect(detailClient).toContain('access-review-close-button');
        expect(detailClient).toContain('access-review-download-evidence');
        // Decision flow always goes through the API — never a direct
        // mutation against the row from the page.
        expect(detailClient).toContain("/decisions/");
        expect(detailClient).toContain("/close");
    });

    // ── 6. Permission gating in the detail client ──────────────────

    it('detail client gates Close on isAdmin and DecisionDialog on canDecide', () => {
        // canDecide gate (assigned reviewer OR admin), CLOSED rejects.
        expect(detailClient).toContain('isReviewer');
        expect(detailClient).toContain('canDecide');
        expect(detailClient).toContain('canClose');
        expect(detailClient).toMatch(/canClose\s*=\s*isAdmin/);
    });
});
