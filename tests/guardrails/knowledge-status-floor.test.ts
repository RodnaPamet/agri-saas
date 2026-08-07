/**
 * Guardrail: Knowledge Base — reader status floor + no-draft-as-current.
 *
 * `/knowledge` is where a farm's SOPs live. Two invariants keep a reader
 * (no write permission) from ever being shown an unreviewed procedure as
 * if it were the approved one:
 *
 *   (a) STATUS FLOOR — `listArticles` in `src/app-layer/usecases/knowledge.ts`
 *       MUST force `status: ['PUBLISHED']` when `ctx.permissions.canWrite`
 *       is false, overriding whatever the caller asked for. A caller
 *       without write permission can never receive a DRAFT or ARCHIVED
 *       article from the list endpoint.
 *
 *   (b) NO-DRAFT-AS-CURRENT — the article detail page
 *       (`src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx`) MUST NOT
 *       fall back from `article.currentVersion` to the newest DRAFT
 *       (`article.versions?.[0]`) when no version is published. That
 *       fallback would present an unapproved draft as "Current" — the
 *       exact defect this guardrail exists to catch a regression of.
 *
 * Structural-scan style (mirrors `hibp-coverage.test.ts` /
 * `api-permission-coverage.test.ts`): regex over the real source, plus a
 * mutation regression proof so the detector itself is proven to fire
 * before it's trusted to gate CI.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const USECASE_FILE = 'src/app-layer/usecases/knowledge.ts';
const DETAIL_PAGE_FILE = 'src/app/t/[tenantSlug]/(app)/knowledge/[id]/page.tsx';

function read(relPath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ── (a) status floor ────────────────────────────────────────────────

/** Isolate the `listArticles` function body so the floor check can't be
 *  satisfied by a canWrite/PUBLISHED reference living somewhere ELSE in
 *  the file (e.g. inside `publishArticle`). */
function extractListArticlesBody(src: string): string {
    const match = src.match(/export async function listArticles\([^)]*\)\s*\{([\s\S]*?)\n\}\n/);
    if (!match) return '';
    return match[1];
}

const CANWRITE_CHECK_RE = /ctx\.permissions\.canWrite/;
const PUBLISHED_ONLY_RE = /status:\s*\[\s*['"]PUBLISHED['"]\s*\]/;

/**
 * True when `listArticles` both branches on `ctx.permissions.canWrite`
 * AND forces `status: ['PUBLISHED']` on the non-write path. Either
 * condition alone is insufficient — a `canWrite` check that does nothing,
 * or a `['PUBLISHED']` literal used for an unrelated purpose, would both
 * be false positives for "the floor exists".
 */
function hasStatusFloor(src: string): boolean {
    const body = extractListArticlesBody(src);
    if (!body) return false;
    return CANWRITE_CHECK_RE.test(body) && PUBLISHED_ONLY_RE.test(body);
}

// ── (b) no-draft-as-current ─────────────────────────────────────────

/** The exact defect shape: falling back from the published version to
 *  the newest version in the array (index 0 is newest — versions are
 *  created append-only and the list isn't re-sorted). */
const DANGEROUS_FALLBACK_RE = /currentVersion\s*=\s*article\.currentVersion\s*(?:\|\||\?\?)\s*article\.versions/;

function hasDangerousFallback(src: string): boolean {
    return DANGEROUS_FALLBACK_RE.test(src);
}

// ── Tests: real source ──────────────────────────────────────────────

describe('Knowledge guardrail — reader status floor', () => {
    it('listArticles forces PUBLISHED-only when the caller cannot write', () => {
        const src = read(USECASE_FILE);
        if (!hasStatusFloor(src)) {
            throw new Error(
                [
                    `listArticles is missing the reader status floor.`,
                    ``,
                    `  File: ${USECASE_FILE}`,
                    ``,
                    `A caller without write permission MUST only ever receive`,
                    `PUBLISHED articles. Branch on \`ctx.permissions.canWrite\` and`,
                    `force \`status: ['PUBLISHED']\` (overriding, not merging with,`,
                    `any caller-requested status filter) on the non-write path.`,
                ].join('\n'),
            );
        }
    });
});

describe('Knowledge guardrail — no draft presented as Current', () => {
    it('the detail page never falls back from currentVersion to the newest draft', () => {
        const src = read(DETAIL_PAGE_FILE);
        if (hasDangerousFallback(src)) {
            throw new Error(
                [
                    `The knowledge article detail page falls back from`,
                    `\`article.currentVersion\` to \`article.versions?.[0]\` (the`,
                    `newest version, published or not).`,
                    ``,
                    `  File: ${DETAIL_PAGE_FILE}`,
                    ``,
                    `With no PUBLISHED version, the Current tab MUST show the`,
                    `"not yet published" empty state — never the newest DRAFT. A`,
                    `farmer following a draft spray procedure is a real-world harm.`,
                    `Remove the fallback: \`const currentVersion = article.currentVersion;\``,
                ].join('\n'),
            );
        }
    });
});

// ── Regression proof: the detectors actually fire ───────────────────

describe('Knowledge guardrail — regression proof', () => {
    it('flags a mutated listArticles that drops the canWrite branch', () => {
        const real = read(USECASE_FILE);
        expect(hasStatusFloor(real)).toBe(true); // self-check: real file passes

        // Simulate a PR that reverts the floor to a plain pass-through —
        // the pre-fix shape (`return runInTenantContext(ctx, (db) =>
        // KnowledgeRepository.list(db, ctx, filters));`).
        const mutated = real.replace(
            /const effectiveFilters: KnowledgeFilters = ctx\.permissions\.canWrite[\s\S]*?: \{ \.\.\.filters, status: \['PUBLISHED'\] \};\n\s*return runInTenantContext\(ctx, \(db\) => KnowledgeRepository\.list\(db, ctx, effectiveFilters\)\);/,
            'return runInTenantContext(ctx, (db) => KnowledgeRepository.list(db, ctx, filters));',
        );
        expect(mutated).not.toBe(real); // the replace actually matched something
        expect(hasStatusFloor(mutated)).toBe(false);
    });

    it('flags a mutated detail page that reintroduces the versions[0] fallback', () => {
        const real = read(DETAIL_PAGE_FILE);
        expect(hasDangerousFallback(real)).toBe(false); // self-check: real file passes

        const mutated = real.replace(
            'const currentVersion = article.currentVersion;',
            'const currentVersion = article.currentVersion || article.versions?.[0];',
        );
        expect(mutated).not.toBe(real); // the replace actually matched something
        expect(hasDangerousFallback(mutated)).toBe(true);
    });
});
