#!/usr/bin/env tsx
/**
 * Ingest the GLOBAL RAG catalog (feat/ai-rag; content replaced in PR 4/5
 * with a Bulgarian-first agronomy corpus — see scripts/rag/corpus.ts).
 *
 * Writes the licensed/original GLOBAL_CORPUS (Bulgarian agronomy for
 * wheat/barley/maize/sunflower, "Agri-SaaS agronomy desk (original)") as
 * GLOBAL KnowledgeChunks (tenantId NULL) WITH embeddings. GLOBAL rows are
 * readable by every tenant via the asymmetric RLS policy; they can only
 * be WRITTEN off the app_user path, so this script uses the default
 * (superuser-bypassed) Prisma client.
 *
 * LICENCE + DOSE/PHI/REI GATING is enforced in scripts/rag/corpus.ts —
 * `assertLicensedSource()` refuses any non-allowlisted source and
 * hard-refuses the Tier-4 list (GlobalG.A.P. and the rest); every entry
 * also runs through `assertNoUnregisteredRegulatedContent()`
 * (scripts/rag/dose-phi-guard.ts). See THIRD_PARTY_NOTICES.md.
 *
 * Idempotent on (source, sourceRef). Mirrors scripts/import-knowledge.ts
 * (PrismaPg adapter + force-exit main()).
 *
 * Usage:
 *   tsx scripts/rag/ingest-corpus.ts        # ingest the GLOBAL corpus
 *   npm run rag:ingest
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ingestGlobalCorpus, GLOBAL_CORPUS } from './corpus';

async function main(): Promise<number> {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    try {
        const res = await ingestGlobalCorpus(prisma, GLOBAL_CORPUS);
        console.log(
            `RAG GLOBAL corpus: ${res.created} chunk(s) created, ` +
                `${res.skipped} already present.`,
        );
        return 0;
    } finally {
        await prisma.$disconnect();
    }
}

// `typeof module !== 'undefined'` guards this CJS entry-point check for
// callers that import this file's named exports from a real ESM
// context (scripts/seed.ts, bundled by esbuild into dist/seed.mjs —
// `module` is not a defined identifier there, and a bare
// `require.main === module` throws `ReferenceError: module is not
// defined in ES module scope`). Under tsx and ts-jest (both of which
// shim `require`/`module` as CJS-interop globals) this behaves exactly
// as before.
if (typeof module !== 'undefined' && require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error('RAG corpus ingestion failed:', err);
        process.exit(1);
    });
}
