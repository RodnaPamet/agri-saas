/**
 * Every push producer goes through `resolveDelivery` — P7.5 (#1994).
 *
 * ## "One" is the requirement, not a tidiness preference
 *
 * #1994 opens with it: a delivery decision made wherever a notification is
 * created means three channels decided independently by three producers, and
 * that is how somebody gets woken at 03:00 on one device having muted another.
 * A second producer that calls a transport directly is not a style problem —
 * it is the defect the function exists to remove, reintroduced.
 *
 * It is also the easy mistake to make, because calling `sendApnsToUser` works.
 * It sends. Nothing fails, no test goes red, and the preference the person set
 * is simply not consulted on that one path.
 *
 * ## Why source and not behaviour
 *
 * A behavioural test can only check the producers that exist. This has to fail
 * on the NEXT one — a notification type added in P8 or P9 whose author reaches
 * for the sender they can see rather than the decision they cannot. That is a
 * question about the call graph, so it is asked of the source.
 *
 * The exemption list is the honest part: two modules legitimately call the
 * transports, and both are named with a reason rather than matched by a
 * pattern that would quietly admit a third.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

/** The two transports a producer must not reach for directly. */
const TRANSPORTS = ['sendWebPushToUser', 'sendApnsToUser'] as const;

/**
 * Modules allowed to call a transport, each for a stated reason.
 *
 * `push-send` is the immediate path and `push-summary` is the deferred one.
 * Both consult `resolveDelivery` first — which is asserted separately below,
 * because being on this list is permission to call a transport, not permission
 * to skip the decision.
 *
 * The transports' own module is here because that is where they are DEFINED.
 */
const MAY_CALL_TRANSPORTS = [
    'src/app-layer/jobs/push-send.ts',
    'src/app-layer/jobs/push-summary.ts',
    'src/lib/notifications/web-push.ts',
    'src/lib/notifications/apns.ts',
] as const;

/** The modules that must consult the resolver, i.e. the producers. */
const MUST_RESOLVE = [
    'src/app-layer/jobs/push-send.ts',
    'src/app-layer/jobs/push-summary.ts',
] as const;

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

/**
 * Raw source, deliberately.
 *
 * `blankNonCode` is the repo's tool for source questions and it is currently
 * unreliable — a regex literal with an odd number of quotes opens a string
 * that swallows every comment after it, and any emoji shifts every offset
 * (#2106, 13 files under `src/`). The cost of reading raw is that a docblock
 * naming a transport counts as a call; the benefit is that this guard does not
 * inherit a known defect. Where a comment needs to name one, it is written
 * without the call parenthesis, which is what the detector keys on.
 */
const sourceOf = (abs: string): string => fs.readFileSync(abs, 'utf8');

describe('one resolveDelivery', () => {
    const files = collectSourceFiles({ roots: ['src'], floor: 50 });

    it('reports the population, so a zero would be visible', () => {
        console.log(
            `[one-resolve-delivery] swept ${files.length} files; ` +
                `${MAY_CALL_TRANSPORTS.length} may call a transport, ` +
                `${MUST_RESOLVE.length} must resolve first`,
        );
        expect(files.length).toBeGreaterThan(50);
    });

    it('the exemption list is not stale — every entry exists', () => {
        // An exemption naming a deleted file is an exemption that covers
        // nothing while looking like it covers something.
        for (const f of [...MAY_CALL_TRANSPORTS, ...MUST_RESOLVE]) {
            expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
        }
    });

    it('no unexempted module CALLS a push transport', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            const r = rel(abs);
            if ((MAY_CALL_TRANSPORTS as readonly string[]).includes(r)) continue;
            const src = sourceOf(abs);
            for (const t of TRANSPORTS) {
                // The call, not the name: `sendApnsToUser(` rather than
                // `sendApnsToUser`, so prose may refer to it.
                if (src.includes(`${t}(`)) offenders.push(`${r} calls ${t}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every exempted PRODUCER consults resolveDelivery', () => {
        // The other half. Without it, being on the exemption list would be
        // permission to decide for yourself — which is the defect with extra
        // steps.
        const missing: string[] = [];
        for (const f of MUST_RESOLVE) {
            const src = sourceOf(path.join(ROOT, f));
            if (!src.includes('resolveDelivery(')) missing.push(f);
        }
        expect(missing).toEqual([]);
    });

    it('resolveDelivery is defined exactly once', () => {
        const defs: string[] = [];
        for (const abs of files) {
            if (/export function resolveDelivery\b/.test(sourceOf(abs))) defs.push(rel(abs));
        }
        expect(defs).toEqual(['src/app-layer/notifications/resolve-delivery.ts']);
    });

    it('the in-app row is unconditional in the resolver', () => {
        // Quiet hours must never suppress the bell — it is how somebody finds
        // out about anything they were not interrupted for, so a resolver able
        // to refuse it could lose a notification entirely. Asserted on the
        // TYPE, which is the strongest available statement: `inApp: true` as a
        // literal type cannot be false without a compile error at every
        // construction site.
        const src = sourceOf(
            path.join(ROOT, 'src/app-layer/notifications/resolve-delivery.ts'),
        );
        expect(src).toMatch(/inApp:\s*true;/);
    });

    it('the detector has teeth, on synthetic sources', () => {
        const CALLS = `await sendApnsToUser(ctx, u, p);`;
        const MENTIONS = `// see sendApnsToUser for the fan-out`;
        const RESOLVES = `const d = resolveDelivery({ preference, now, devices });`;

        const calls = (s: string) => TRANSPORTS.some((t) => s.includes(`${t}(`));
        const resolves = (s: string) => s.includes('resolveDelivery(');

        expect(calls(CALLS)).toBe(true);
        // Prose may name a transport, which is why the parenthesis is part of
        // the pattern — the alternative is depending on comment blanking.
        expect(calls(MENTIONS)).toBe(false);
        expect(resolves(RESOLVES)).toBe(true);
        expect(resolves(CALLS)).toBe(false);
    });
});
