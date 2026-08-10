#!/usr/bin/env tsx
/**
 * Knowledge-base seeding — single operator-facing entrypoint.
 *
 * The production runtime image ships only `scripts/entrypoint.sh` — no
 * `tsx`, no source `scripts/` tree (devDependencies are pruned before
 * the runtime image is built; see the Dockerfile). Before this file
 * existed, `npm run rag:ingest`, `npm run import:knowledge`, and
 * `npm run rag:ingest:satellite` — all `tsx scripts/*.ts` — could NOT
 * run in production at all. This file is bundled by esbuild (see
 * `scripts/build-seed.mjs`, `npm run build:seed`) into a self-contained
 * `dist/seed.mjs`, the same mechanism `scripts/build-worker.mjs`
 * already uses for the BullMQ worker + scheduler — and the Dockerfile
 * ships `dist/` in the runtime image already, so this rides that
 * existing pipe.
 *
 * Deliberately ONE entrypoint with subcommands rather than three
 * separate bundles — an operator running this under pressure (a new
 * tenant, a content refresh) should not have to remember three
 * filenames.
 *
 * Usage:
 *   node dist/seed.mjs knowledge [--tenant <slug>]
 *   node dist/seed.mjs satellite
 *   node dist/seed.mjs corpus
 *   node dist/seed.mjs all [--tenant <slug>]
 *
 * Local dev (equivalent, via tsx — unchanged, still the fastest loop):
 *   npm run import:knowledge -- --tenant <slug>
 *   npm run rag:ingest:satellite
 *   npm run rag:ingest
 *
 * All three underlying steps are idempotent (skip-if-exists — see each
 * module's own doc comment), so re-running any subcommand, including
 * `all`, is always a safe no-op that reports skips instead of creating
 * duplicates.
 *
 * `corpus` additionally requires a configured embeddings backend
 * (`AI_EMBED_BASE_URL` + `AI_EMBED_API_KEY`, or `AI_BASE_URL` as a
 * fallback — see `assertEmbeddingBackendConfigured` in
 * `scripts/rag/corpus.ts`) and FAILS LOUDLY, naming the missing env
 * var, when it is not configured — it never silently writes a chunk
 * with no usable embedding.
 *
 * See docs/implementation-notes/2026-08-10-production-seed-path.md and
 * the "Knowledge-base seeding" section of docs/deployment.md for the
 * operator runbook.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { importKnowledge } from './import-knowledge';
import { ingestSatelliteGuide } from './rag/ingest-satellite-guide';
import { ingestGlobalCorpus, GLOBAL_CORPUS } from './rag/corpus';

const SUBCOMMANDS = ['knowledge', 'satellite', 'corpus', 'all'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(v: string | undefined): v is Subcommand {
    return (SUBCOMMANDS as readonly string[]).includes(v ?? '');
}

function printUsage(): void {
    console.log(
        [
            'Usage: node dist/seed.mjs <subcommand> [options]',
            '',
            'Subcommands:',
            '  knowledge   Seed per-tenant growing-guide articles. Idempotent per (tenantId, slug).',
            '              Options: --tenant <slug>  (defaults to the oldest active tenant)',
            '  satellite   Seed the GLOBAL satellite-imagery guide. Idempotent (tenantId NULL, slug).',
            '  corpus      Seed the GLOBAL RAG corpus WITH embeddings. Idempotent on (source, sourceRef).',
            '              Requires AI_EMBED_BASE_URL + AI_EMBED_API_KEY (or AI_BASE_URL) — see',
            '              deploy/env.prod.example. Fails loudly, naming the missing var, if unset.',
            '  all         Run knowledge, then satellite, then corpus. Each step is attempted and',
            "              reported independently — one step's failure does not skip the others.",
            '              Exits non-zero if any step failed.',
            '',
            'Examples:',
            '  node dist/seed.mjs knowledge --tenant acme-farms',
            '  node dist/seed.mjs all',
        ].join('\n'),
    );
}

interface StepResult {
    name: Exclude<Subcommand, 'all'>;
    ok: boolean;
    detail: string;
}

function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function readTenantSlugArg(): string | undefined {
    const idx = process.argv.indexOf('--tenant');
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function runKnowledge(prisma: PrismaClient): Promise<StepResult> {
    try {
        const res = await importKnowledge(prisma, { tenantSlug: readTenantSlugArg() });
        return {
            name: 'knowledge',
            ok: true,
            detail: `tenant ${res.tenantId}: ${res.created} created, ${res.skipped} already present.`,
        };
    } catch (err) {
        return { name: 'knowledge', ok: false, detail: describeError(err) };
    }
}

async function runSatellite(prisma: PrismaClient): Promise<StepResult> {
    try {
        const res = await ingestSatelliteGuide(prisma);
        return {
            name: 'satellite',
            ok: true,
            detail: `GLOBAL: ${res.created} created, ${res.skipped} already present.`,
        };
    } catch (err) {
        return { name: 'satellite', ok: false, detail: describeError(err) };
    }
}

async function runCorpus(prisma: PrismaClient): Promise<StepResult> {
    try {
        const res = await ingestGlobalCorpus(prisma, GLOBAL_CORPUS);
        return {
            name: 'corpus',
            ok: true,
            detail: `GLOBAL: ${res.created} created, ${res.skipped} already present.`,
        };
    } catch (err) {
        return { name: 'corpus', ok: false, detail: describeError(err) };
    }
}

function printResult(res: StepResult): void {
    if (res.ok) {
        console.log(`[${res.name}] OK — ${res.detail}`);
    } else {
        console.error(`[${res.name}] FAILED — ${res.detail}`);
    }
}

async function main(): Promise<number> {
    const cmd = process.argv[2];

    if (cmd === '--help' || cmd === '-h') {
        printUsage();
        return 0;
    }
    if (!isSubcommand(cmd)) {
        printUsage();
        return 1;
    }

    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    try {
        const results: StepResult[] =
            cmd === 'knowledge'
                ? [await runKnowledge(prisma)]
                : cmd === 'satellite'
                  ? [await runSatellite(prisma)]
                  : cmd === 'corpus'
                    ? [await runCorpus(prisma)]
                    : [await runKnowledge(prisma), await runSatellite(prisma), await runCorpus(prisma)];

        results.forEach(printResult);

        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
            console.error(`\n${failed.length}/${results.length} step(s) failed.`);
            return 1;
        }
        console.log(`\n${results.length}/${results.length} step(s) OK.`);
        return 0;
    } finally {
        await prisma.$disconnect();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('Seed failed:', describeError(err));
        process.exit(1);
    });
