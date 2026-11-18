/**
 * #3199 part 2 — a native bearer session is held per FARM, from the database.
 *
 * `mfaPendingTenantIds` was produced only by the cookie `jwt` callback, so a
 * bearer never carried it and every farm read as "nothing owed" for the life
 * of the session: a member of a second farm whose policy is REQUIRED reached
 * it on the phone without that farm's factor, and a farm that turned MFA on
 * after the session was minted stayed open to it for as long as the app kept
 * refreshing.
 *
 * `resolveBearerSession` now resolves the list per request, anchored on the
 * SESSION's sign-in (`UserSession.createdAt`, less the Apple ticket's
 * lifetime) rather than on the access token's `iat`, which is new every 15
 * minutes. These cases run that against real rows: the request headers, the
 * token decoder and the session shaper are the only doubles.
 */
import { randomUUID } from 'crypto';

import { DB_AVAILABLE } from './db-helper';

const mockHeaders = new Map<string, string>([['authorization', 'Bearer test-token']]);
jest.mock('next/headers', () => ({
    headers: async () => ({
        get: (k: string) => mockHeaders.get(k.toLowerCase()) ?? null,
        entries: () => mockHeaders.entries(),
        [Symbol.iterator]: () => mockHeaders.entries(),
    }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

// The shaper copies the claims through, as the real session callback does for
// the field under test; the assertion is on what reached it.
jest.mock('@/auth', () => ({
    authOptions: {
        callbacks: {
            session: async ({ session, token }: { session: Record<string, unknown>; token: Record<string, unknown> }) => ({
                ...session,
                mfaPendingTenantIds: token.mfaPendingTenantIds,
            }),
        },
    },
}));

import { prisma } from '@/lib/prisma';
import { resolveBearerSession } from '@/lib/auth/native/bearer-principal';
import { MFA_TICKET_TTL_SECONDS } from '@/lib/auth/native/auth-codes';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `bpfm-${randomUUID().slice(0, 8)}`;
const OPEN_FARM = `${TAG}-open`; // MFA off — the primary farm
const STRICT_FARM = `${TAG}-strict`; // MFA REQUIRED
let userId = '';

async function sessionSignedInAt(at: Date): Promise<string> {
    const sessionId = `${TAG}-${randomUUID()}`;
    await prisma.userSession.create({
        data: {
            sessionId,
            userId,
            tenantId: OPEN_FARM,
            createdAt: at,
            lastActiveAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
        },
    });
    return sessionId;
}

function presentBearer(sessionId: string): void {
    getToken.mockResolvedValue({
        sub: userId,
        userId,
        userSessionId: sessionId,
        mfaPending: false,
        memberships: [
            { slug: OPEN_FARM, role: 'OWNER', tenantId: OPEN_FARM },
            { slug: STRICT_FARM, role: 'EDITOR', tenantId: STRICT_FARM },
        ],
    });
}

async function challengeStrictFarmAt(at: Date | null): Promise<void> {
    await prisma.userMfaEnrollment.updateMany({
        where: { userId, tenantId: STRICT_FARM },
        data: { lastChallengeAt: at },
    });
}

async function pendingFor(sessionId: string): Promise<string[] | undefined | null> {
    presentBearer(sessionId);
    const session = (await resolveBearerSession()) as { mfaPendingTenantIds?: string[] } | null;
    return session === null ? null : session.mfaPendingTenantIds;
}

describeFn('a bearer session is held per farm, from the database (#3199)', () => {
    beforeAll(async () => {
        for (const id of [OPEN_FARM, STRICT_FARM]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        const email = `${TAG}@example.test`;
        userId = (await prisma.user.create({ data: { email, name: 'Bearer MFA' }, select: { id: true } })).id;
        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: STRICT_FARM },
            update: { mfaPolicy: 'REQUIRED' },
            create: { tenantId: STRICT_FARM, mfaPolicy: 'REQUIRED' },
        });
        await prisma.userMfaEnrollment.create({
            data: {
                userId,
                tenantId: STRICT_FARM,
                type: 'TOTP',
                secretEncrypted: 'synthetic-not-a-secret',
                isVerified: true,
                verifiedAt: new Date(),
            },
        });
    }, 60_000);

    afterAll(async () => {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.userMfaEnrollment.deleteMany({ where: { userId } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: STRICT_FARM } });
    });

    it('holds the REQUIRED farm when its factor was never presented — and only that farm', async () => {
        await challengeStrictFarmAt(null);
        const sessionId = await sessionSignedInAt(new Date(Date.now() - 60_000));
        // Before #3199 this was `undefined`: the bearer carried no list, and
        // getTenantCtx read an absent list as "nothing owed".
        expect(await pendingFor(sessionId)).toEqual([STRICT_FARM]);
    });

    it('releases the farm once its code is presented after sign-in', async () => {
        const signedIn = new Date(Date.now() - 60_000);
        const sessionId = await sessionSignedInAt(signedIn);
        await challengeStrictFarmAt(new Date(signedIn.getTime() + 10_000));
        expect(await pendingFor(sessionId)).toEqual([]);
    });

    it('counts the Apple ticket challenge, which precedes the session row by seconds', async () => {
        // native/mfa verifies the code, then creates the session. Anchoring on
        // `createdAt` exactly would lock every Apple user out of their own farm.
        const signedIn = new Date(Date.now() - 60_000);
        const sessionId = await sessionSignedInAt(signedIn);
        await challengeStrictFarmAt(new Date(signedIn.getTime() - 2_000));
        expect(await pendingFor(sessionId)).toEqual([]);
    });

    it('does NOT count a challenge older than the sign-in window', async () => {
        const signedIn = new Date(Date.now() - 60_000);
        const sessionId = await sessionSignedInAt(signedIn);
        await challengeStrictFarmAt(new Date(signedIn.getTime() - (MFA_TICKET_TTL_SECONDS + 60) * 1000));
        expect(await pendingFor(sessionId)).toEqual([STRICT_FARM]);
    });

    it('anchors on the SESSION, not the token: a fresh access token does not re-challenge', async () => {
        // The access token is re-minted on every refresh, so a rule relative to
        // its `iat` would hold this person again every 15 minutes.
        const signedIn = new Date(Date.now() - 3 * 3600_000);
        const sessionId = await sessionSignedInAt(signedIn);
        await challengeStrictFarmAt(new Date(signedIn.getTime() + 5_000));
        expect(await pendingFor(sessionId)).toEqual([]);
    });

    it('a farm that turns MFA on after sign-in holds the bearer from the next request', async () => {
        await challengeStrictFarmAt(null);
        await prisma.tenantSecuritySettings.update({ where: { tenantId: STRICT_FARM }, data: { mfaPolicy: 'DISABLED' } });
        const sessionId = await sessionSignedInAt(new Date(Date.now() - 60_000));
        expect(await pendingFor(sessionId)).toEqual([]); // control: policy off, nothing owed

        await prisma.tenantSecuritySettings.update({ where: { tenantId: STRICT_FARM }, data: { mfaPolicy: 'REQUIRED' } });
        expect(await pendingFor(sessionId)).toEqual([STRICT_FARM]);
    });

    it('still refuses a revoked session outright', async () => {
        const sessionId = await sessionSignedInAt(new Date(Date.now() - 60_000));
        await prisma.userSession.update({ where: { sessionId }, data: { revokedAt: new Date() } });
        expect(await pendingFor(sessionId)).toBeNull();
    });
});
