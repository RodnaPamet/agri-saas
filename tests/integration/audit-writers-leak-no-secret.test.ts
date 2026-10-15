/**
 * The REAL audit writers, driven with a secret in scope, and the stored row
 * scanned for it (#1882).
 *
 * ## The half #1784 could not cover
 *
 * `tests/guards/audit-details-carry-no-secrets.test.ts` scans all 220
 * `logEvent` call sites and fails on an identifier whose last path segment
 * names a secret. That is a NAME-level check on the call site, and its own
 * docblock says so: it cannot follow a value, so `details: summarise(x)` or a
 * spread hides whatever is inside.
 *
 * This is the other half. It calls `createApiKey` — which mints a plaintext
 * secret and writes its audit row in the SAME transaction — then reads the row
 * back out of Postgres and asserts the secret is not in it.
 *
 * ## Which writers, and the one that dropped off the list
 *
 * #1882 named three. Two are here:
 *
 *   • `createApiKey` — the plaintext is returned once at creation, hashed at
 *     rest, never re-shown. In the audit trail it would sit in a hash-chained,
 *     immutable table that deliberately resists deletion, which is the one
 *     place a leaked secret cannot be cleaned up.
 *   • `verifyMfaChallenge` — decrypts the shared TOTP secret into a local
 *     `secret` and calls `logEvent` twice in that same scope. The secret is
 *     worse than any single code: it generates every future one.
 *
 * The third, session revocation in
 * `src/app/api/t/[tenantSlug]/admin/sessions/route.ts`, is NOT covered and
 * should not be. `UserSession` holds no credential — only `sessionId`, and
 * `prisma/schema/auth.prisma` says why in terms this test would otherwise
 * have contradicted: "the token itself is signed by AUTH_SECRET so a guessed
 * sessionId on its own does nothing". `revokedReason` is likewise deliberate
 * — it exists to be read in the audit entry. A leak test there would be a
 * control that cannot express failure: nothing in scope to find, so green for
 * ever, and its NAME would tell the next reader the writer had been checked.
 * That is exactly the pair of tests #1784 deleted. Recorded on #1882 instead.
 *
 * ## Asserting the VALUE, not a pattern
 *
 * #1784's two deleted tests failed because they matched patterns against a
 * string the author typed. This takes the actual minted secret and looks for
 * THAT, so it cannot pass by the pattern being wrong — and it would catch a
 * leak of a secret whose shape nobody predicted.
 *
 * The positive control matters as much: the row must be FOUND and must carry
 * the key's NAME. Without that, a query returning nothing satisfies every
 * "secret is absent" assertion, which is the empty-population failure this
 * repo keeps meeting.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHmac, randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createApiKey } from '@/app-layer/usecases/api-keys';
import { encryptTotpSecret, generateTotpSecret, verifyTotpCode } from '@/lib/security/totp-crypto';
import { verifyMfaChallenge } from '@/app-layer/usecases/mfa-challenge';
import { prisma as appPrisma } from '@/lib/prisma';
import { runWithAuditContext } from '@/lib/audit-context';

/**
 * A valid TOTP code for `secret`, built here rather than taken from the module
 * under scan.
 *
 * `generateHotp` is private to `totp-crypto`, so this is a second RFC 6238
 * implementation — normally a smell, and deliberate here. It is FIXTURE
 * construction, not the subject: the subject is what the audit writer stores.
 * And it cannot pass silently if it is wrong, because the test asserts the
 * challenge SUCCEEDS; a disagreement with the production verifier fails loudly
 * on that line instead of quietly skipping the passed-challenge writer.
 */
function base32Decode(input: string): Buffer {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of input.replace(/=+$/, '').toUpperCase()) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function totpNow(secret: string): string {
    const counter = Math.floor(Date.now() / 1000 / 30);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter & 0xffffffff, 4);
    const hmac = createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff)
    ) % 1000000;
    return code.toString().padStart(6, '0');
}

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `auditsec-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';

function ctx() {
    return makeRequestContext(Role.ADMIN, { userId: USER_ID, tenantId: TENANT_ID, tenantSlug: TAG });
}

async function seed(): Promise<void> {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const user = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    USER_ID = user.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: USER_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
}

async function teardown(): Promise<void> {
    await globalPrisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.userMfaEnrollment.deleteMany({ where: { tenantId: TENANT_ID } });
    // `session_replication_role` because AuditLog is append-only by trigger:
    // the same escape the sibling integration suites use for their teardown.
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
    });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
    if (USER_ID) await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

describeFn('a real audit writer does not store the secret in scope (#1882)', () => {
    beforeAll(seed);
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    it('createApiKey: the minted plaintext is nowhere in its AuditLog row', async () => {
        const created = await createApiKey(ctx(), {
            name: `Key ${TAG}`,
            // A REAL scope — the usecase validates against the live list,
            // and 'read' is not one of them. Using the real validator rather
            // than a mock is what caught that.
            scopes: ['journal:read'],
        } as never);

        const plaintext = (created as { plaintext?: string }).plaintext ?? '';
        // The secret must actually exist, or the scan below is vacuous — the
        // control that separates "no leak" from "nothing was minted".
        expect(plaintext.length).toBeGreaterThan(16);

        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entity: 'TenantApiKey' },
            select: { action: true, details: true, detailsJson: true, diffJson: true, metadataJson: true },
        });

        // POSITIVE CONTROL, first. A query that found nothing would satisfy
        // every absence assertion below, which is the empty-population failure
        // this repo keeps meeting.
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.map((r) => r.action)).toContain('API_KEY_CREATED');
        // And the row is about the right thing: it carries the key's NAME. If
        // it did not, this might be scanning some unrelated row.
        expect(JSON.stringify(rows)).toContain(`Key ${TAG}`);

        // THE assertion: the actual minted value, not a pattern. #1784's two
        // deleted tests matched patterns against a string their author typed,
        // so they could not fail on a secret whose shape nobody predicted.
        const serialised = JSON.stringify(rows);
        expect(serialised).not.toContain(plaintext);

        // Nor any substantial prefix of it: a writer that logged a "redacted"
        // key by truncation would pass the exact-match check while leaking the
        // part that makes it guessable.
        expect(serialised).not.toContain(plaintext.slice(0, 20));
    });

    it('the key HASH is not stored in the audit row either', async () => {
        // Weaker than the plaintext and still worth refusing: the hash is the
        // verifier, so an attacker holding it can confirm a guess offline. It
        // belongs in `TenantApiKey.keyHash` and nowhere else.
        const row = await globalPrisma.tenantApiKey.findFirst({
            where: { tenantId: TENANT_ID },
            select: { keyHash: true, keyPrefix: true },
        });
        expect(row?.keyHash).toBeTruthy();

        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entity: 'TenantApiKey' },
            select: { details: true, detailsJson: true, diffJson: true, metadataJson: true },
        });
        expect(JSON.stringify(rows)).not.toContain(row!.keyHash);

        // The PREFIX is fine and is deliberately not asserted absent: it is
        // the non-secret handle an operator uses to recognise which key a row
        // is about, and refusing it would make the trail less useful for no
        // security gain.
        expect(row?.keyPrefix).toBeTruthy();
    });

    it('verifyMfaChallenge: neither the TOTP secret nor the submitted code reaches its rows', async () => {
        // THE reason this writer is on #1882's list. `verifyMfaChallenge`
        // decrypts the shared secret into a local `secret` and then calls
        // `logEvent` twice in the same scope — once per outcome. A TOTP secret
        // is worse than a leaked code: it generates every future code, so one
        // in an append-only table is a permanent second factor for anyone with
        // audit read.
        const secret = generateTotpSecret();
        // Non-vacuous fixture: a 20-byte base32 secret is 32 chars. If this
        // were empty, every `not.toContain` below would pass trivially — the
        // empty-needle failure, which is the same shape as the empty
        // population and just as silent.
        expect(secret.length).toBeGreaterThanOrEqual(16);

        const ciphertext = encryptTotpSecret(secret, process.env.AUTH_SECRET as string);
        await globalPrisma.userMfaEnrollment.create({
            data: {
                userId: USER_ID,
                tenantId: TENANT_ID,
                type: 'TOTP',
                secretEncrypted: ciphertext,
                isVerified: true,
                verifiedAt: new Date(),
            },
        });

        const valid = totpNow(secret);
        // A wrong code DERIVED from the right one, not a literal. '000000'
        // is a valid code three times in every million, which is a flake
        // nobody would reproduce; this one is wrong by construction, and the
        // production verifier is asked to confirm it.
        const wrong = String((Number(valid[0]) + 5) % 10) + valid.slice(1);
        expect(verifyTotpCode(secret, wrong)).toBe(false);

        const failed = await verifyMfaChallenge(USER_ID, TENANT_ID, wrong, 2);
        expect(failed.success).toBe(false);

        const passed = await verifyMfaChallenge(USER_ID, TENANT_ID, valid, 3);
        // Also the fixture's own control: a `totpNow` that disagreed with the
        // production verifier would land here, not in a silent skip of the
        // passed-challenge writer.
        expect(passed.success).toBe(true);

        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entity: 'User' },
            select: { action: true, details: true, detailsJson: true, diffJson: true, metadataJson: true },
        });

        // POSITIVE CONTROLS, before any absence claim: both writers ran, and
        // the rows are about this challenge rather than something unrelated.
        const actions = rows.map((r) => r.action);
        expect(actions).toContain('MFA_CHALLENGE_FAILED');
        expect(actions).toContain('MFA_CHALLENGE_PASSED');
        const serialised = JSON.stringify(rows);
        expect(serialised).toContain('2 attempts remaining');

        // And the channel is open: `detailsJson` is `.passthrough()`, so an
        // unknown key is STORED, not stripped. Worth stating, because a
        // schema that silently dropped it would make this scan look strong
        // while testing nothing.
        expect(serialised).toContain('MFA challenge failed');

        // The assertions. The decrypted secret first — the permanent one.
        expect(serialised).not.toContain(secret);
        // Then any 8-char run of it: a writer "redacting" by truncation would
        // pass the exact match while handing over most of the entropy.
        expect(serialised).not.toContain(secret.slice(0, 8));
        // The ciphertext too. Weaker — it needs AUTH_SECRET to open — but the
        // audit table is exactly where a value you cannot rotate should not be.
        expect(serialised).not.toContain(ciphertext);

        // Both submitted codes. A code is a live credential inside its ±1
        // step window, and the failed one is a guess worth knowing for an
        // attacker measuring how close they got. Six digits CAN collide with
        // a digit run inside a UUID; at (1/16)^6 per offset over two rows
        // that is ~1e-5, and the columns selected carry only writer-supplied
        // text plus the requestId.
        expect(serialised).not.toContain(valid);
        expect(serialised).not.toContain(wrong);
    });

    it('the prisma audit extension does not store the tenant wrapped DEK', async () => {
        // The writer #1882 did not name, and the biggest one. Every write to
        // every model except `AuditLog` is audited by the query extension in
        // `src/lib/prisma.ts` — an EXCLUSION list, not an inclusion list —
        // and `buildDiffJson` snapshots the CHANGED FIELD VALUES into
        // `diffJson.after`. There is no call site for a call-site guard to
        // read, so #1784's guard is blind to it by construction.
        //
        // Redaction there is by field NAME (`src/lib/audit-redact.ts`), which
        // is the same name-level weakness one layer down. It covered
        // `secretEncrypted`, `accessTokenEncrypted`, `refreshTokenEncrypted`
        // and `auditStreamSecretEncrypted` — but only because those names
        // contain `secret` or `token`. `Tenant.encryptedDek` contains
        // neither, and `/encryption/i` does not match `encrypted`.
        const SENTINEL = `v1:DEKSENTINEL-${TAG}-${'A'.repeat(64)}`;

        await runWithAuditContext(
            { tenantId: TENANT_ID, actorUserId: USER_ID, requestId: randomUUID(), source: 'api' } as never,
            async () => {
                await appPrisma.tenant.update({
                    where: { id: TENANT_ID },
                    data: { encryptedDek: SENTINEL },
                });
            },
        );

        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entity: 'Tenant', action: 'UPDATE' },
            select: { diffJson: true, detailsJson: true, details: true, metadataJson: true },
        });

        // POSITIVE CONTROLS. The extension only audits inside an audit
        // context — `if (!tenantId) return query(args)` — so a test that
        // failed to install one would write no row and satisfy every absence
        // assertion below.
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const serialisedDek = JSON.stringify(rows);
        // And the trail is still USEFUL: redaction must not cost the reader
        // the fact that the column changed. This is the half a blunt "strip
        // the whole diff" fix would have broken.
        expect(serialisedDek).toContain('encryptedDek');
        expect(serialisedDek).toContain('[REDACTED]');

        // THE assertion.
        expect(serialisedDek).not.toContain(SENTINEL);
        expect(serialisedDek).not.toContain('DEKSENTINEL');

        // Why it matters that this is the audit table specifically:
        // `AuditLogRepository.list` runs `findMany` with no `select`, so
        // `GET /api/t/{slug}/audit-log` returns every column of every row to
        // any caller past `assertCanAudit` — AUDITOR as well as ADMIN, and an
        // AUDITOR is a read-only role that is not a key holder. That is the
        // path by which a row like this one leaves the server.
        //
        // And the second number, so this test is not read as an incident
        // report: **0 of 1045** production audit rows carried any of the
        // three columns when counted on 2026-10-15. The reason is structural
        // — `DIFF_ACTIONS` is `['update', 'upsert']`, and both real DEK
        // writers in `tenant-key-manager.ts` use `updateMany`, which never
        // builds an `after` snapshot. This test uses a plain `update`
        // deliberately: it is the shape a future refactor introduces, and
        // the one `updateMany` is all that stands between the two.
    });
});
