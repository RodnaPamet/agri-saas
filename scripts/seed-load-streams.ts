/**
 * Accounts for the 1,000-stream load run — P7.10 (#1999).
 *
 * ## Why a whole seeder, when every other k6 scenario logs in as one user
 *
 * Because `/api/me/stream` caps streams PER PERSON at three, and that cap is
 * the point of the route rather than an incidental limit — `acquireStreamSlot`
 * keys on the user with no tenant term so that "3 streams per user" is true for
 * somebody in three farms. So the obvious shape of this test (1,000 VUs sharing
 * `admin@acme.com`) would have measured three streams and 997 refusals, and
 * every one of those refusals is a 204 the script would have had to be told not
 * to count as an error. A green run proving nothing.
 *
 * 1,000 concurrent streams therefore needs at least 334 distinct people. This
 * creates 1,000, one per VU, so the arithmetic needs no explaining at the far
 * end and a VU never contends with itself.
 *
 * ## Not production, and the guard is not a hostname check
 *
 * #1999 says the throwaway VM explicitly. A hostname allowlist would be the
 * wrong guard: the throwaway VM is restored FROM a production dump, so its
 * database is byte-identical to the one that must not be touched and no
 * property of the connection string separates them. What this does instead:
 *
 *   - `LOAD_SEED_CONFIRM` must be set to the exact phrase below, so the command
 *     cannot be arrived at by tab-completion or a copied history line.
 *   - Every row it creates is addressable: a dedicated tenant, and emails under
 *     `@load.invalid` — reserved by RFC 2606, so these accounts can never
 *     receive mail even if a bounce feed or an invite ever points at them.
 *   - `--teardown` deletes exactly what the state file records, so an
 *     accidental run against the wrong database is fully reversible.
 *
 * ## The feature flag is the dangerous half
 *
 * `notifications.sse` is default-OFF and, with an empty `cohorts` array,
 * `enabled: true` means enabled for EVERYONE on that database — not just the
 * accounts created here. That is one upsert away from switching realtime on for
 * every real user, which is why it needs its own opt-in (`--enable-flag`), why
 * the prior state is recorded before the write, and why `--teardown` puts it
 * back. Enabling it per-cohort instead would need 1,000 cohort rows and change
 * what the run measures (cohort lookup per connection), so the global switch is
 * the honest choice for a throwaway database.
 *
 * ## Usage
 *
 *   LOAD_SEED_CONFIRM='yes-this-is-a-throwaway-vm' \
 *   LOAD_TEST_PASSWORD='<pick one>' \
 *     npx tsx scripts/seed-load-streams.ts --users 1000 --enable-flag
 *
 *   LOAD_SEED_CONFIRM='yes-this-is-a-throwaway-vm' \
 *     npx tsx scripts/seed-load-streams.ts --teardown
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import { hashForLookup } from '@/lib/security/encryption';
import { TERMS_VERSION } from '@/lib/legal/terms';

const CONFIRM_PHRASE = 'yes-this-is-a-throwaway-vm';
const FLAG_KEY = 'notifications.sse';
const TENANT_SLUG = process.env.LOAD_SEED_TENANT || 'load-streams';
/** RFC 2606 reserved TLD: nothing here can ever receive mail. */
const EMAIL_DOMAIN = 'load.invalid';

/**
 * What the seeder did, so teardown is exact rather than pattern-matched.
 * Beside the repo root and gitignored — it names a tenant id and a user count,
 * not a credential.
 */
const STATE_FILE = path.resolve(__dirname, '../.load-streams-seed.json');

interface SeedState {
    tenantId: string;
    tenantSlug: string;
    users: number;
    /** The flag's state BEFORE this run, so teardown restores it. */
    flagBefore: { present: boolean; enabled: boolean; cohorts: string[] } | null;
}

// Prisma 7 — the adapter is required, and a bare `new PrismaClient()` throws
// at construction. `scripts/add-test-user.ts` still has the Prisma 6 shape and
// no longer runs; this follows `prisma/seed.ts`, which CI executes.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

function emailFor(i: number): string {
    return `loadstream+${i}@${EMAIL_DOMAIN}`;
}

function arg(name: string): string | null {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function requireConfirmation(): void {
    if (process.env.LOAD_SEED_CONFIRM !== CONFIRM_PHRASE) {
        throw new Error(
            `Refusing to run. Set LOAD_SEED_CONFIRM='${CONFIRM_PHRASE}'.\n` +
                `This writes 1,000 accounts and (with --enable-flag) switches realtime on ` +
                `for every user on this database. #1999 says a throwaway VM, and a VM ` +
                `restored from a production dump is indistinguishable from production by ` +
                `its connection string — so the confirmation is the only guard there is.`,
        );
    }
}

async function seed(): Promise<void> {
    const count = Number(arg('users') || '1000');
    if (!Number.isInteger(count) || count < 1 || count > 5000) {
        throw new Error(`--users must be an integer in 1..5000, got ${arg('users')}`);
    }
    const password = process.env.LOAD_TEST_PASSWORD;
    if (!password || password.length < 8) {
        // No default on purpose. A thousand accounts sharing a password baked
        // into a public repository is a worse outcome than a failed command,
        // and this database is a copy of the real one.
        throw new Error('LOAD_TEST_PASSWORD must be set (>= 8 chars). There is no default.');
    }

    const tenant = await prisma.tenant.upsert({
        where: { slug: TENANT_SLUG },
        update: {},
        create: { slug: TENANT_SLUG, name: 'Load test — streams (#1999)' },
    });

    // Record the flag's prior state BEFORE touching it. Read unconditionally:
    // teardown has to know "absent" from "present and off", and a run without
    // --enable-flag still wants the state file for its user rows.
    const existingFlag = await prisma.featureFlag.findUnique({ where: { key: FLAG_KEY } });
    const flagBefore = existingFlag
        ? { present: true, enabled: existingFlag.enabled, cohorts: existingFlag.cohorts }
        : { present: false, enabled: false, cohorts: [] as string[] };

    // ONE hash for every account. bcrypt at the production cost is ~300ms, so
    // hashing per user would spend five minutes computing the same digest —
    // and `prisma/seed.ts` already shares one hash for the same reason.
    const passwordHash = await bcrypt.hash(password, 12);
    const consent = { acceptedTermsAt: new Date(), acceptedTermsVersion: TERMS_VERSION };

    let created = 0;
    for (let i = 1; i <= count; i++) {
        const email = emailFor(i);
        // guardrail-allow: n+1 — a seeder, and `createMany` cannot upsert on
        // `emailHash` nor return the ids the memberships need.
        const user = await prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            // Re-seeding REPAIRS: an account seeded before a terms bump would
            // otherwise sit at /accept-terms and never reach the stream.
            update: { passwordHash, ...consent },
            create: {
                email,
                emailHash: hashForLookup(email),
                passwordHash,
                name: `Load Stream ${i}`,
                uiLanguage: 'bg',
                ...consent,
            },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
            update: {},
            // READER is enough: the stream route needs a membership that grants
            // access, not a role that can change anything.
            create: { tenantId: tenant.id, userId: user.id, role: 'READER' },
        });
        created++;
        if (created % 100 === 0) console.log(`  … ${created}/${count}`);
    }

    if (has('enable-flag')) {
        await prisma.featureFlag.upsert({
            where: { key: FLAG_KEY },
            update: { enabled: true, cohorts: [] },
            create: {
                key: FLAG_KEY,
                enabled: true,
                cohorts: [],
                description: 'Enabled by scripts/seed-load-streams.ts for the #1999 load run.',
            },
        });
        console.log(
            `⚠ ${FLAG_KEY} is now enabled with NO cohorts — realtime is on for every ` +
                `user on this database. Previous state: ` +
                (flagBefore.present
                    ? `enabled=${flagBefore.enabled} cohorts=[${flagBefore.cohorts.join(',')}]`
                    : 'absent') +
                `. \`--teardown\` restores it.`,
        );
    } else {
        console.log(
            `ℹ ${FLAG_KEY} untouched (${flagBefore.present ? `enabled=${flagBefore.enabled}` : 'absent'}). ` +
                `Without it every stream answers 204 and the k6 run measures nothing — ` +
                `pass --enable-flag when you mean it.`,
        );
    }

    const state: SeedState = {
        tenantId: tenant.id,
        tenantSlug: TENANT_SLUG,
        users: count,
        flagBefore,
    };
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`✅ ${count} accounts in tenant ${TENANT_SLUG}. State → ${STATE_FILE}`);
    console.log(`   Next: BASE_URL=… LOAD_TEST_PASSWORD=… npm run load:streams`);
}

async function teardown(): Promise<void> {
    if (!fs.existsSync(STATE_FILE)) {
        throw new Error(
            `No state file at ${STATE_FILE}. Teardown deletes only what a seed run ` +
                `recorded — it will not pattern-match its way through a database.`,
        );
    }
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SeedState;

    const emails = Array.from({ length: state.users }, (_, i) => emailFor(i + 1));
    // NOT `emails.map(hashForLookup)`. `map` passes (element, index, array),
    // and `hashForLookup`'s second parameter then receives the index — which
    // threw `Received undefined` on the first teardown run and deleted nothing.
    const hashes = emails.map((e) => hashForLookup(e));
    const users = await prisma.user.findMany({
        where: { emailHash: { in: hashes } },
        select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    // Memberships first: `TenantMembership.user` has no cascade, so deleting
    // the users while a membership points at them fails on the foreign key.
    const memberships = await prisma.tenantMembership.deleteMany({
        where: { userId: { in: userIds } },
    });
    const deleted = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    const tenants = await prisma.tenant.deleteMany({ where: { slug: state.tenantSlug } });

    if (state.flagBefore === null || !state.flagBefore.present) {
        await prisma.featureFlag.deleteMany({ where: { key: FLAG_KEY } });
        console.log(`↩ ${FLAG_KEY} deleted (it did not exist before the seed).`);
    } else {
        await prisma.featureFlag.update({
            where: { key: FLAG_KEY },
            data: { enabled: state.flagBefore.enabled, cohorts: state.flagBefore.cohorts },
        });
        console.log(
            `↩ ${FLAG_KEY} restored to enabled=${state.flagBefore.enabled} ` +
                `cohorts=[${state.flagBefore.cohorts.join(',')}].`,
        );
    }

    fs.rmSync(STATE_FILE);
    console.log(
        `✅ removed ${deleted.count} users, ${memberships.count} memberships, ` +
            `${tenants.count} tenant(s).`,
    );
}

async function main(): Promise<void> {
    requireConfirmation();
    if (has('teardown')) await teardown();
    else await seed();
}

main()
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
