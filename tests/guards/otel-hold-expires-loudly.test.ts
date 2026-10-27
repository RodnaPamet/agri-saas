/**
 * The OpenTelemetry hold must expire LOUDLY when upstream unblocks it — #2383.
 *
 * ## What is held, and why it is not a choice
 *
 * `.github/dependabot.yml` ignores six `@opentelemetry/*` bumps. The set ships
 * as a coupled whole and its halves are currently mutually unreachable:
 * `resources@3`, `sdk-metrics@3` and `sdk-node@0.300` all peer on
 * `@opentelemetry/api >=1.10.0 <1.11.0`, while `sdk-trace-node`'s latest
 * release peers on `>=1.0.0 <1.10.0` and EXCLUDES it. There is no 3.x of
 * `sdk-trace-node`, and it cannot be dropped — `instrumentation.ts` imports
 * `NodeTracerProvider` and `BatchSpanProcessor` from it.
 *
 * So the hold is an upstream fact, not a deferral. Nothing in `package.json`
 * can make the newer generation install.
 *
 * ## Why a test and not a review date
 *
 * An ignore entry is a safety argument, and a safety argument expires
 * SILENTLY: the day `sdk-trace-node` ships for api 1.10, these six entries stop
 * protecting anything and start holding the stack back for a reason that is no
 * longer true. Nothing would say so.
 *
 * `dependabot.yml` already demonstrates the failure mode it is trying to avoid.
 * Its own 2026-12-11 entries carry this note:
 *
 *   "A date that arrives before its question can be answered is a date that
 *    gets bumped, and a bumped date teaches the list is soft."
 *
 * So the condition is checked rather than diarised, and it is checked against
 * the LOCKFILE — offline, deterministic, no registry call in CI. When npm
 * resolves a `sdk-trace-node` whose peer range admits 1.10, this test fails and
 * names what to delete.
 *
 * It is therefore a test designed to go red on good news, which is unusual and
 * deliberate: the alternative is a hold nobody revisits.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import * as yaml from 'js-yaml';

import { admitsVersion } from '../helpers/overrides-analysis';

const ROOT = process.cwd();
const BLOCKER = '@opentelemetry/sdk-trace-node';
const API = '@opentelemetry/api';

/** The api version the newer generation requires, and `sdk-trace-node` forbids. */
const CONTESTED = '1.10.0';

/** The six entries this guard justifies. Kept in sync by the test below. */
const HELD = [
    '@opentelemetry/api',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-http',
];

interface LockEntry {
    version?: string;
    peerDependencies?: Record<string, string>;
}

function blockerPeerRange(): { version: string; range: string } {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
        packages: Record<string, LockEntry>;
    };
    const keys = Object.keys(lock.packages).filter((k) => k.endsWith(BLOCKER));
    // An ABSENT blocker is not a pass. If `sdk-trace-node` leaves the tree the
    // hold has no justification left and these entries must be reconsidered —
    // reading that silence as "still blocked" is how a stale exemption survives.
    expect(keys.length).toBeGreaterThan(0);
    const entry = lock.packages[keys[0]];
    const range = entry.peerDependencies?.[API];
    expect(typeof range).toBe('string');
    return { version: entry.version ?? '(unknown)', range: range as string };
}

describe('the OpenTelemetry hold is still justified by upstream (#2383)', () => {
    it('[otel-hold] sdk-trace-node still EXCLUDES the api the newer set requires', () => {
        const { version, range } = blockerPeerRange();
        const admits = admitsVersion(range, CONTESTED);
        // `null` means the range could not be parsed. Treating that as "still
        // blocked" would hold six packages back on an unanswerable question, so
        // it fails loudly instead.
        if (admits === null) {
            throw new Error(
                `could not parse ${BLOCKER}'s peer range on ${API}: "${range}". `
                    + 'The hold cannot be justified by a range nothing can read.',
            );
        }
        console.log(
            `[otel-hold] ${BLOCKER}@${version} peers on ${API} "${range}"; `
                + `admits ${CONTESTED}: ${admits}`,
        );

        if (admits) {
            throw new Error(
                `${BLOCKER}@${version} now accepts ${API}@${CONTESTED} (peer range "${range}").\n\n`
                    + 'The upstream conflict that justified holding the OpenTelemetry set is GONE,\n'
                    + 'so the six ignore entries in .github/dependabot.yml are now holding the\n'
                    + 'stack back for a reason that is no longer true.\n\n'
                    + 'Delete them, in this order:\n'
                    + HELD.map((h) => `  - dependency-name: "${h}"`).join('\n')
                    + '\n\nThen let the group bump the set as one. This test is SUPPOSED to fail\n'
                    + 'here — it exists so the hold cannot outlive its cause.',
            );
        }
        expect(admits).toBe(false);
    });

    it('[otel-hold] the six held entries are all actually in dependabot.yml', () => {
        // The other direction. Without this, someone could delete the ignore
        // entries and leave this guard asserting a hold that no longer exists —
        // a justification for nothing, reading as coverage.
        const cfg = yaml.load(readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8')) as {
            updates: { ignore?: { 'dependency-name': string }[] }[];
        };
        const ignored = new Set(
            cfg.updates.flatMap((u) => (u.ignore ?? []).map((e) => e['dependency-name'])),
        );
        expect(HELD.filter((h) => !ignored.has(h))).toEqual([]);
    });

    it('[otel-hold] the blocker is still imported, so dropping it is not the easy way out', () => {
        // If `sdk-trace-node` were unused, the fix would be to remove it rather
        // than hold six packages back. Asserting the import keeps that option
        // from being overlooked when somebody revisits this.
        const src = readFileSync(join(ROOT, 'src/lib/observability/instrumentation.ts'), 'utf8');
        expect(src).toContain(BLOCKER);
    });
});

describe('the check can tell the two worlds apart', () => {
    it('the real range excludes 1.10.0, and the newer generation requires it', () => {
        // Both halves of the conflict, as literals. If semver's behaviour or
        // this guard's reading of it ever changed, these pin which way round the
        // conflict actually is.
        expect(admitsVersion('>=1.0.0 <1.10.0', '1.10.0')).toBe(false);
        expect(admitsVersion('>=1.10.0 <1.11.0', '1.10.0')).toBe(true);
        // And the version in the tree today is admitted by the blocker, which is
        // why the install works at all.
        expect(admitsVersion('>=1.0.0 <1.10.0', '1.9.1')).toBe(true);
    });

    it('a hypothetical unblocked range WOULD trip the failure path', () => {
        // The positive control for the test above. Without it, "admits === false"
        // could be true because the comparison is broken rather than because
        // upstream still conflicts.
        expect(admitsVersion('>=1.0.0 <1.11.0', CONTESTED)).toBe(true);
        expect(admitsVersion('^1.10.0', CONTESTED)).toBe(true);
        // And an unparseable range is distinguishable from a "no".
        expect(admitsVersion('not a range at all', CONTESTED)).toBeNull();
    });
});
