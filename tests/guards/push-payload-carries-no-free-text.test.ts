/**
 * A push payload names the entity, never the farmer's prose — #1999 (P7.10).
 *
 * P7.10's phase rule is "payloads carry ids only and clients fetch bodies over
 * REST with ETag". What shipped was softer and the gap was real: a task
 * assignment put `TASK-123 "Пръскане на блок 3 срещу мана" вече е Ваша.` into
 * `aps.alert.body`, and the spray alert named the block.
 *
 * **APNs payloads are not end-to-end encrypted**, so Apple reads that body.
 * Web Push is encrypted to the subscription's own `p256dh`/`auth` keys, so the
 * push service cannot — the exposure was Apple's side only, which is why this
 * is about farm operational prose rather than a decrypted secret. Task titles
 * are not in `ENCRYPTED_FIELDS`; `description` and `resolution` are.
 *
 * Owner ruling 2026-11-01: keep the KEY, drop the free text. Strict ids-only
 * was offered and declined — it shows «Възложена Ви е задача» with no key and
 * forces the app open to learn which task — and so was keeping the prose.
 *
 * ## Why the population is derived
 *
 * There are four producers today and nothing stops a fifth. A hand-listed set
 * would grade the four that were already right, which is
 * `count-the-routes-a-gate-covers` one level down, so §1 reads every
 * `enqueue('push-send'` site off the filesystem.
 */
import { readFileSync } from 'node:fs';

import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { createAgroSignalNotification } from '@/app-layer/notifications/agro';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** A label no copy string could contain by accident. */
const PLANTED = 'Пръскане на блок 3 срещу мана ZZQX';

describe('push payloads carry no farmer-written text (#1999)', () => {
    it('§1 every enqueue("push-send") site feeds `body` from a pushBody', () => {
        // `skipDirs` is passed explicitly: the default excludes `dist` and
        // `coverage` BY NAME, which would hide a real source directory called
        // either — the trap `collect-files` documents at the option.
        const files = collectSourceFiles({
            roots: ['src'],
            extensions: ['.ts'],
            skipDirs: ['node_modules', '.next', '.git'],
            floor: 500,
        });
        const sites: Array<{ file: string; body: string }> = [];

        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            if (!src.includes("enqueue('push-send'")) continue;
            // The object literal of each call, up to its closing brace.
            const re = /enqueue\(\s*'push-send'\s*,\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(src)) !== null) {
                const bodyLine = m[1]
                    .split('\n')
                    .map((l) => l.replace(/\/\/.*$/, '').trim())
                    .find((l) => l.startsWith('body:'));
                sites.push({
                    file: file.slice(REPO_ROOT.length + 1),
                    body: bodyLine ?? '<no body: key>',
                });
            }
        }

        console.log(`[push-payload] ${sites.length} enqueue('push-send') site(s) across src/`);
        for (const s of sites) console.log(`[push-payload]   ${s.file} → ${s.body}`);

        // A floor, so an extraction that stops matching fails instead of
        // passing over nothing. THREE, measured 2026-11-01 — two in `task.ts`
        // (assignment, bulk summary) and one in `weather-pull.ts` (spray).
        // I first wrote 4 from memory of "four producers" and this floor
        // failed, which is the floor working: there are three producers and
        // three sites, and the number belongs to a measurement rather than to
        // a recollection.
        expect(sites.length).toBeGreaterThanOrEqual(3);

        const offenders = sites.filter((s) => !/\bpushBody\b/.test(s.body));
        expect(offenders).toEqual([]);
    });

    it('§2 the assignment producer keeps the KEY and drops the title', async () => {
        const createMany = jest.fn().mockResolvedValue({ count: 1 });
        const db = { notification: { createMany, findMany: jest.fn().mockResolvedValue([]) } };

        const out = await createAssignmentNotification(db as never, 'TASK_ASSIGNED', {
            tenantId: 't1',
            assigneeUserId: 'u1',
            entityId: 'task-1',
            entityLabel: PLANTED,
            entityKey: 'T-123',
            tenantSlug: 'acme',
            locale: 'bg',
        });

        expect(out.status).toBe('created');
        const n = out.notification!;
        // The POSITIVE CONTROL: the bell copy must still carry the label, or
        // the assertion below is passing over a producer that renders nothing.
        expect(n.message).toContain(PLANTED);
        // And the push body must not — while still naming which task.
        expect(n.pushBody).not.toContain(PLANTED);
        expect(n.pushBody).toContain('T-123');
        // `{key}` must be SUBSTITUTED, not left as a literal — see §3.
        expect(n.pushBody).not.toMatch(/[{}]/);
    });

    it('§2b no key means a title-only push, never a fallback to the label', async () => {
        // A fallback to `label` here is exactly how the defect returns.
        const createMany = jest.fn().mockResolvedValue({ count: 1 });
        const db = { notification: { createMany, findMany: jest.fn().mockResolvedValue([]) } };

        const out = await createAssignmentNotification(db as never, 'ASSET_ASSIGNED', {
            tenantId: 't1',
            assigneeUserId: 'u1',
            entityId: 'asset-1',
            entityLabel: PLANTED,
            entityKey: null,
            tenantSlug: 'acme',
            locale: 'bg',
        });

        expect(out.notification!.message).toContain(PLANTED);
        expect(out.notification!.pushBody).toBe('');
    });

    it('§3 the agro producer names no block, with or without a detail', async () => {
        const createMany = jest.fn().mockResolvedValue({ count: 1 });
        const db = { notification: { createMany, findMany: jest.fn().mockResolvedValue([]) } };

        for (const detail of [undefined, 'вятър 9 m/s']) {
            createMany.mockResolvedValue({ count: 1 });
            const out = await createAgroSignalNotification(db as never, 'SPRAY_WINDOW_WARNING', {
                tenantId: 't1',
                recipientUserId: 'u1',
                locationId: 'loc-1',
                locationLabel: PLANTED,
                tenantSlug: 'acme',
                locale: 'bg',
                ...(detail ? { detail } : {}),
            } as never);

            const n = out.notification!;
            expect(n.message).toContain(PLANTED);     // control
            expect(n.pushBody).not.toContain(PLANTED);
            expect(n.pushBody.length).toBeGreaterThan(0);
            // An UNRENDERED placeholder, which `not.toContain(PLANTED)` is
            // blind to. Found by mutation: pointing `pushBodyKey` at the
            // label-bearing `body` key passed this test, because `translateFor`
            // is a plain interpolate and the push body is resolved with NO
            // params — so `{label}` survives verbatim and contains no planted
            // text. The absence assertion was aimed one level off the defect.
            //
            // It is also a defect in its own right: CLAUDE.md's own rule is
            // that a brace reaching a person is the `translateFor` trap.
            expect(n.pushBody).not.toMatch(/[{}]/);
        }
    });
});
