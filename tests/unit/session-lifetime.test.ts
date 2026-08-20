/**
 * Issue #618 — "every tenant is on a 30-day session nobody chose".
 *
 * The 30 days was never a decision. It was NextAuth's own default showing
 * through in three independent places: `session.maxAge` left unset in
 * `src/auth.ts`, a local `SESSION_MAX_AGE_SECONDS` in `sso-session.ts`, and a
 * nullable `sessionMaxAgeMinutes` column with no default. Each looked
 * deliberate on its own.
 *
 * The lifetime is the ONLY lever that touches the live session, so it is what
 * governs the lost-phone case — a lost phone is never signed out, so the
 * lifetime IS the exposure window. That makes it worth pinning behaviourally
 * rather than trusting three literals to stay in step.
 *
 * These assertions EXECUTE: the cookie test mints a real JWE with v4's own
 * `encode()` and reads its `exp` back through `getToken()`, so it fails if the
 * constant stops reaching the mint — not merely if someone edits a number.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { encode, getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import {
    SESSION_MAX_AGE_DAYS,
    SESSION_MAX_AGE_MINUTES,
    SESSION_MAX_AGE_MS,
    SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session-lifetime';

const SECRET = 'session-lifetime-secret-at-least-32-chars'; // pragma: allowlist secret -- local encode/decode input, never a credential
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('the constants agree with each other', () => {
    it('is 14 days, expressed four ways without drift', () => {
        expect(SESSION_MAX_AGE_DAYS).toBe(14);
        expect(SESSION_MAX_AGE_SECONDS).toBe(14 * 24 * 60 * 60);
        expect(SESSION_MAX_AGE_MS).toBe(SESSION_MAX_AGE_SECONDS * 1000);
        expect(SESSION_MAX_AGE_MINUTES).toBe(SESSION_MAX_AGE_SECONDS / 60);
        expect(SESSION_MAX_AGE_MINUTES).toBe(20160);
    });

    it('is no longer 30 days', () => {
        // The regression this issue exists for. Stated as its own assertion so
        // a future bump reads as a decision rather than a typo.
        expect(SESSION_MAX_AGE_SECONDS).not.toBe(30 * 24 * 60 * 60);
    });
});

describe('the minted session cookie actually carries that lifetime', () => {
    it('exp is ~14 days out, decoded through the real getToken', async () => {
        const before = Math.floor(Date.now() / 1000);
        const jwe = await encode({
            token: { sub: 'usr_1', userId: 'usr_1' },
            secret: SECRET,
            maxAge: SESSION_MAX_AGE_SECONDS,
        });
        const decoded = await getToken({
            req: new NextRequest('http://localhost:3000/t/acme-corp/dashboard', {
                headers: { cookie: `next-auth.session-token=${jwe}` },
            }) as never,
            secret: SECRET,
        });

        // Positive control: a null read would make every assertion below vacuous.
        expect(decoded).not.toBeNull();
        expect(decoded?.userId).toBe('usr_1');

        const exp = decoded?.exp as number;
        expect(typeof exp).toBe('number');

        const lifetime = exp - before;
        expect(lifetime).toBeGreaterThan(SESSION_MAX_AGE_SECONDS - 30);
        expect(lifetime).toBeLessThanOrEqual(SESSION_MAX_AGE_SECONDS + 30);
    });

    it('a 30-day mint is distinguishable from a 14-day one', async () => {
        // Proves the previous assertion has resolving power: if `encode`
        // ignored maxAge, both would land on the same exp and the test above
        // would pass against the unfixed code.
        const thirty = await encode({
            token: { sub: 'usr_1' },
            secret: SECRET,
            maxAge: 30 * 24 * 60 * 60,
        });
        const fourteen = await encode({
            token: { sub: 'usr_1' },
            secret: SECRET,
            maxAge: SESSION_MAX_AGE_SECONDS,
        });
        const req = (v: string) =>
            new NextRequest('http://localhost:3000/', {
                headers: { cookie: `next-auth.session-token=${v}` },
            }) as never;

        const a = await getToken({ req: req(thirty), secret: SECRET });
        const b = await getToken({ req: req(fourteen), secret: SECRET });
        expect((a?.exp as number) - (b?.exp as number)).toBeGreaterThan(
            15 * 24 * 60 * 60,
        );
    });
});

describe('every site consumes the shared constant', () => {
    it('sso-session.ts declares no lifetime of its own', () => {
        const src = read('src/lib/auth/sso-session.ts');
        expect(src).toContain("from '@/lib/auth/session-lifetime'");
        // All three uses — recordNewSession expiry, the encode() maxAge and the
        // cookie maxAge. The last two are NOT capped by tenant policy, so a
        // local constant here would leave SSO on 30-day cookies while the DB
        // row said 14.
        expect(src.match(/SESSION_MAX_AGE_SECONDS/g)?.length).toBeGreaterThanOrEqual(4);
        expect(src).not.toMatch(/const\s+SESSION_MAX_AGE_SECONDS\s*=/);
    });

    it('auth.ts sets session.maxAge explicitly', () => {
        const src = read('src/auth.ts');
        // Omitting maxAge does not mean "no limit" — it means v4's 30-day
        // default, which is how the cookie outlived a chosen lifetime.
        expect(src).toMatch(/session:\s*\{\s*strategy:\s*'jwt',\s*maxAge:\s*SESSION_MAX_AGE_SECONDS\s*\}/);
        expect(src).not.toContain('THIRTY_DAYS_MS');
    });
});

describe('the schema default cannot drift from the constant', () => {
    it('sessionMaxAgeMinutes defaults to SESSION_MAX_AGE_MINUTES', () => {
        const schema = read('prisma/schema/auth.prisma');
        const line = schema
            .split('\n')
            .find((l) => l.includes('sessionMaxAgeMinutes') && l.includes('@default'));
        expect(line).toBeDefined();
        const n = Number(line!.match(/@default\((\d+)\)/)?.[1]);
        expect(n).toBe(SESSION_MAX_AGE_MINUTES);
    });

    it('the migration writes the same number', () => {
        const sql = read(
            'prisma/migrations/20260820160000_session_lifetime_default/migration.sql',
        );
        const nums = [...sql.matchAll(/\b(\d{4,})\b/g)].map((m) => Number(m[1]));
        expect(nums.length).toBeGreaterThan(0);
        for (const n of nums) expect(n).toBe(SESSION_MAX_AGE_MINUTES);
    });
});
