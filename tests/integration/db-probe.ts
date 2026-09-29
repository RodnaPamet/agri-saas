/**
 * Classifying a database probe — kept in its OWN module, deliberately.
 *
 * `db-helper.ts` runs the probe at import time, so anything importing it
 * pays up to two `spawnSync` calls before the first assertion. A test of the
 * CLASSIFICATION must not pay that: the bug being fixed only appears when
 * the machine is too busy to answer in time, so a test that spawned would be
 * subject to the same load it is testing for — flaky exactly when it matters
 * and green when it does not.
 */

/**
 * What the probe learned. THREE outcomes, not two.
 *
 *   'ok'       — connected and ran `SELECT 1`
 *   'refused'  — the probe FINISHED and could not connect (no database)
 *   'unknown'  — the probe did not finish: timed out, signalled, or unspawnable
 */
export type DbProbeOutcome = 'ok' | 'refused' | 'unknown';

/**
 * Map one `spawnSync` result onto an outcome.
 *
 * The old code was `return result.status === 0`, and `spawnSync` sets
 * `status: null` on timeout — so a slow probe reported "no database" and
 * every integration suite became `describe.skip`. The run then got GREENER
 * by running less, which CLAUDE.md names first under "a skipped suite is
 * indistinguishable from a passing one".
 *
 * Only exit 1 is an ANSWER about the database: that is the probe script's own
 * `.catch`. Every other non-zero exit is the probe itself breaking, and must
 * not be read as evidence of absence.
 */
export function classifyProbe(result: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
}): DbProbeOutcome {
    if (result.status === 0) return 'ok';
    if (result.status === 1) return 'refused';
    return 'unknown';
}

/**
 * The probe body, run by `node -e`. Prisma 7 dropped the `datasources`
 * constructor option, so the URL flows in through a driver adapter
 * (`@prisma/adapter-pg`), mirroring the singleton wiring in
 * `src/lib/prisma.ts`. The URL is passed via the environment rather than
 * interpolated, so no shell quoting is involved.
 *
 * Exit 0 = connected. Exit 1 = the `.catch` below fired, i.e. a real refusal.
 * Those are the ONLY two exits this script produces, which is what lets
 * `classifyProbe` treat every other status as 'unknown' rather than as an
 * answer about the database.
 */
export const PROBE_SCRIPT = [
    "const{PrismaClient}=require('@prisma/client');",
    "const{PrismaPg}=require('@prisma/adapter-pg');",
    'const u=process.env.__DB_CHECK_URL;',
    'const adapter=new PrismaPg({connectionString:u});',
    'const p=new PrismaClient({adapter});',
    'p.$connect()',
    '.then(()=>p.$queryRawUnsafe("SELECT 1"))',
    '.then(()=>{p.$disconnect();process.exit(0)})',
    '.catch(()=>{p.$disconnect().catch(()=>{});process.exit(1)})',
].join('');
