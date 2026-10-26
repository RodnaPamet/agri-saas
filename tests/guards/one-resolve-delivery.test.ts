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

import { blankNonCode } from '../helpers/blank-non-code';
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
 * Blanked source (#2403). This read used to be raw, deliberately.
 *
 * The docblock that stood here said `blankNonCode` was unreliable — "a regex
 * literal with an odd number of quotes opens a string that swallows every
 * comment after it, and any emoji shifts every offset (#2106)" — and keyed the
 * detector on the call PARENTHESIS so prose could still name a transport.
 *
 * **Both premises are now false**, and #2106 is closed. Re-tested against the
 * live helper rather than taken from its docblock:
 *
 *   - the odd-quote regex from `basemap-bundle-scan.ts` no longer swallows what
 *     follows it — the comment after it blanks, the regex survives;
 *   - an emoji preserves length and newlines, and `canvas-auto-layout.ts` reads
 *     10,316 -> 10,316 bytes and 290 -> 290 lines. 290 is the discriminator:
 *     the old bug turned that exact file's 290 lines into 210.
 *
 * `[[a-safety-argument-expires-silently]]` — the reasoning was right when
 * written, its premises went false, and nothing failed to say so.
 *
 * ## What the parenthesis alone could not do
 *
 * It let prose name a transport, which is most of the problem. It did not stop
 * a comment that includes the parenthesis, and that hole fails in the dangerous
 * direction for `MUST_RESOLVE`: a docblock reading "resolveDelivery(…) decides"
 * satisfies "this producer consults the resolver" with no call anywhere in the
 * file, which is the #1994 defect passing as compliant.
 *
 * **No verdict changes today** — measured across all 2,266 files under `src/`,
 * raw and blanked agree on every needle this guard uses, zero deltas. So this
 * is hardening against the next comment, not the repair of a live miss, and it
 * does not claim to be.
 *
 * `{ strings: true }` because every subject here is a CALL or a declaration,
 * never message text: a transport name inside a string literal is not a call.
 */
const blanked = (raw: string): string => blankNonCode(raw, { strings: true });

/** Blanked contents of a file on disk. */
const sourceOf = (abs: string): string => blanked(fs.readFileSync(abs, 'utf8'));

/**
 * Which transports this TEXT calls.
 *
 * Takes text, not a path, so the controls below drive the SAME predicate the
 * sweep does. A control that skips a step the subject performs is testing a
 * different function (`[[a-crosscheck-in-the-old-method]]`).
 */
const transportsCalledIn = (raw: string): string[] => {
    const code = blanked(raw);
    return TRANSPORTS.filter((t) => code.includes(`${t}(`));
};

/** Does this TEXT consult the resolver? */
const resolvesIn = (raw: string): boolean => blanked(raw).includes('resolveDelivery(');

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
            // The call, not the name: `sendApnsToUser(` rather than
            // `sendApnsToUser`. Comments are gone before the match, so prose
            // may refer to one WITH its parenthesis and still not be a call.
            for (const t of transportsCalledIn(fs.readFileSync(abs, 'utf8'))) {
                offenders.push(`${r} calls ${t}`);
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
            if (!resolvesIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))) missing.push(f);
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

        expect(transportsCalledIn(CALLS)).toEqual(['sendApnsToUser']);
        // Prose may name a transport. The parenthesis alone handled this case
        // before the blanking went in, and still does.
        expect(transportsCalledIn(MENTIONS)).toEqual([]);
        expect(resolvesIn(RESOLVES)).toBe(true);
        expect(resolvesIn(CALLS)).toBe(false);
    });

    it('a comment is not a call even WITH the parenthesis', () => {
        // The case the parenthesis could not reach, and the reason this guard
        // now blanks (#2403). Both of these pass raw and fail the thing they
        // are checking:
        //
        //   - the first would report an exempt-worthy module as an offender,
        //     for a docblock telling people not to do the thing;
        //   - the second is the direction that matters. A producer whose
        //     docblock merely NAMES the resolver would satisfy "consults the
        //     resolver" with no call in the file — #1994's defect, passing.
        const WARNS = `/** Never call sendApnsToUser(ctx, u, p) here — use the resolver. */`;
        const CLAIMS = `// resolveDelivery(…) decides this; see P7.5.\nawait sendApnsToUser(ctx, u, p);`;

        expect(transportsCalledIn(WARNS)).toEqual([]);
        expect(resolvesIn(CLAIMS)).toBe(false);
        // And the real call in the same text is still seen — a blanker that
        // ate everything would pass both assertions above for free.
        expect(transportsCalledIn(CLAIMS)).toEqual(['sendApnsToUser']);
    });

    it('a transport named inside a STRING is not a call', () => {
        // Why `{ strings: true }`. A metric label or a log key naming a
        // transport is not an invocation of it.
        const LABEL = `track('sendApnsToUser(ctx)', { count: 1 });`;
        expect(transportsCalledIn(LABEL)).toEqual([]);
    });
});
