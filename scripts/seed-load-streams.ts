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
/**
 * The DM flag, read but never WRITTEN by this seeder — see the pair loop.
 * `social.direct-messages`, spelled as a literal because
 * `social-routes-flag-gated` extracts literals and an operator holding the
 * console has to be able to find the key by reading the code that needs it.
 */
const DM_FLAG_KEY = 'social.direct-messages';
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
    /**
     * Accepted DM conversations between adjacent accounts, for the delivery
     * scenario (#2881). `[]` for a streams-only seed.
     *
     * Recorded in the state file so `--teardown` deletes exactly what a run
     * created — the same contract the user rows have, and it matters more here
     * because a `Conversation` is TENANTLESS: deleting the load tenant does
     * not cascade to it, so an unrecorded conversation would outlive the
     * teardown with no row pointing at it.
     */
    conversations: { id: string; aEmail: string; bEmail: string }[];
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
    /** Email → id, so the pair loop below needs no second lookup per account. */
    const userIds: { email: string; id: string }[] = [];
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
        userIds.push({ email, id: user.id });
        if (created % 100 === 0) console.log(`  … ${created}/${count}`);
    }

    /*
     * ── DM pairs, for the delivery measurement (#2881) ──
     *
     * `--pairs N` makes N ACCEPTED conversations between accounts (2i-1, 2i),
     * so one VU can hold a stream as A and write as B. That is the shape
     * #2881 names, and it needs both halves:
     *
     *   - ACCEPTED rather than REQUEST, because a REQUEST admits exactly one
     *     message until the other party accepts (P8.1's rule, enforced by
     *     `direct_message_insert`'s WITH CHECK via `lastMessageAt`). A load
     *     run sending many messages would get `DM_REQUEST_AWAITING_REPLY` on
     *     the second iteration of every VU and measure a refusal.
     *   - `lastMessageAt` set, for the same reason: the request rule reads
     *     that column, and leaving it NULL on an ACCEPTED row is a state the
     *     product never writes.
     *
     * Each pair consumes TWO accounts, so `--pairs` is capped at
     * `floor(users / 2)` rather than silently reusing one side — a VU writing
     * to itself would measure a self-delivery the product refuses (`DM_SELF`).
     */
    const pairCount = Number(arg('pairs') || '0');
    if (!Number.isInteger(pairCount) || pairCount < 0) {
        throw new Error(`--pairs must be a non-negative integer, got ${arg('pairs')}`);
    }
    if (pairCount * 2 > count) {
        throw new Error(
            `--pairs ${pairCount} needs ${pairCount * 2} accounts but --users is ${count}. ` +
                `Each pair is two DISTINCT people: a conversation with itself is refused ` +
                `(DM_SELF), so the shortfall cannot be papered over by reusing one side.`,
        );
    }

    const conversations: SeedState['conversations'] = [];
    for (let p = 0; p < pairCount; p++) {
        const a = userIds[p * 2];
        const b = userIds[p * 2 + 1];
        // guardrail-allow: n+1 — a seeder, and the participant rows need the
        // conversation id that `createMany` does not return.
        const existing = await prisma.conversation.findFirst({
            where: {
                participants: { some: { userId: a.id } },
                AND: [{ participants: { some: { userId: b.id } } }],
            },
            select: { id: true },
        });
        const conversation = existing
            ? await prisma.conversation.update({
                  where: { id: existing.id },
                  data: { state: 'ACCEPTED', lastMessageAt: new Date() },
                  select: { id: true },
              })
            : await prisma.conversation.create({
                  data: {
                      state: 'ACCEPTED',
                      initiatedByUserId: a.id,
                      lastMessageAt: new Date(),
                      participants: { create: [{ userId: a.id }, { userId: b.id }] },
                  },
                  select: { id: true },
              });
        conversations.push({ id: conversation.id, aEmail: a.email, bEmail: b.email });
        if ((p + 1) % 50 === 0) console.log(`  … ${p + 1}/${pairCount} conversations`);
    }
    if (pairCount > 0) {
        console.log(`✅ ${pairCount} ACCEPTED conversation(s) for the delivery scenario.`);
        const dmFlag = await prisma.featureFlag.findUnique({ where: { key: DM_FLAG_KEY } });
        if (!dmFlag?.enabled || (dmFlag.cohorts?.length ?? 0) > 0) {
            // STATED rather than fixed. `--enable-flag` already switches ONE
            // flag on for every user on the database and says so loudly; a
            // seeder that quietly switched on a second would be worse. The
            // delivery run fails fast on a 403 instead, which is a legible
            // failure rather than a measurement of nothing.
            console.log(
                `⚠ ${DM_FLAG_KEY} is ${dmFlag ? `enabled=${dmFlag.enabled} cohorts=[${dmFlag.cohorts.join(',')}]` : 'absent'}. ` +
                    `The delivery scenario needs it enabled with NO cohorts, and this seeder ` +
                    `deliberately does not set it — enabling a second global flag is an ` +
                    `operator decision, not a side effect of seeding.`,
            );
        }
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
        conversations,
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
    /*
     * The conversations go FIRST and BY ID, and both halves matter.
     *
     * `Conversation` is TENANTLESS (P8.1 — two people in one may share no
     * farm), so deleting the load tenant cascades to nothing here: an
     * unrecorded conversation would survive the teardown with no row pointing
     * at it, which is the opposite of the "fully reversible" property this
     * script's docblock claims. By id rather than by participant, because a
     * participant query would also match a conversation a REAL user happens
     * to share with a seeded account — on a VM restored from a production
     * dump, that is not hypothetical.
     *
     * `DirectMessage` and `ConversationParticipant` cascade from
     * `Conversation` (both declare `onDelete: Cascade`), so the messages the
     * delivery run sent go with it.
     */
    const conversationIds = (state.conversations ?? []).map((c) => c.id);
    if (conversationIds.length > 0) {
        const convs = await prisma.conversation.deleteMany({
            where: { id: { in: conversationIds } },
        });
        console.log(`🗑 ${convs.count} conversation(s) (messages and participants cascade).`);
    }

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
