/**
 * Every automation catalogue event MUST have at least one emitter.
 *
 * Written during GRC teardown phase 2 (plan §8k) after nine events —
 * TEST_PLAN_CREATED/UPDATED/PAUSED/RESUMED, TEST_RUN_CREATED/COMPLETED/
 * FAILED, TEST_EVIDENCE_LINKED/UNLINKED — were found in the catalogue
 * long after their subject models (`PracticeTestPlan`, `PracticeTestRun`)
 * had been dropped from the Prisma schema.
 *
 * Nothing was red for the entire period they were orphaned, and it is
 * worth being precise about WHY, because it is the reason this file scans
 * for emitters rather than for models:
 *
 *   - `tsc` cannot help. The catalogue is a `const` object of string
 *     literals, so there is no type relationship to the schema to break.
 *   - The schema guardrails cannot help. They check that models are
 *     indexed / RLS-covered / rollback-scripted; a model that is *absent*
 *     is invisible to all of them.
 *   - `automation-templates.test.ts` cannot help, and this is the
 *     instructive one. It asserts `isKnownAutomationEvent(t.trigger)` for
 *     every shipped template — i.e. it validates the templates against
 *     the CATALOGUE. When the catalogue is itself the thing that is
 *     wrong, that assertion passes with full confidence. The catalogue,
 *     the label registry and the templates all agreed with each other;
 *     only the database disagreed, and nothing compared those two.
 *
 * The user-visible cost was not dead code: the rule builder OFFERED the
 * orphans as triggers and the suggestions rail RECOMMENDED one of them at
 * 0.82 confidence, so a tenant could build a rule that could never fire.
 *
 * WHY EMITTERS AND NOT MODELS. A model-existence check does not work —
 * SCHEDULE is synthesised by a sweep, the ONBOARDING_* family tracks
 * progress rather than a row, and a future event may be emitted by an
 * inbound webhook. "Something in this repo can emit it" is the property
 * that actually distinguishes a live trigger from a stranded one, and it
 * held for all fourteen surviving events at the time of writing.
 *
 * This is a source-text scan and contributes no runtime coverage (see
 * "Green is not the same as executed" in CLAUDE.md) — which is the right
 * tool here, because the defect it catches is precisely an absence of
 * code rather than a misbehaviour of code.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';

const ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = [join(ROOT, 'src', 'app-layer'), join(ROOT, 'src', 'lib')];

/**
 * Files that DEFINE the catalogue rather than emit from it. A name
 * appearing only in these is exactly the orphan condition.
 */
const CATALOGUE_FILES = [
    join('src', 'app-layer', 'automation', 'events.ts'),
    join('src', 'app-layer', 'automation', 'event-contracts.ts'),
    join('src', 'lib', 'automation', 'event-labels.ts'),
];

/**
 * Events with no in-repo emitter that are nonetheless legitimate.
 * Empty today. Adding one requires a written reason — an event that
 * only an external system can raise is plausible, an event whose
 * subject was deleted is not.
 */
const EXTERNALLY_EMITTED: ReadonlyArray<{ event: string; reason: string }> = [];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
}

/**
 * Exported for the mutation proof below: given the source corpus, return
 * the catalogue entries no file emits.
 */
export function findOrphanEvents(
    events: readonly string[],
    sources: ReadonlyArray<{ rel: string; text: string }>,
): string[] {
    const emitters = sources.filter(
        (s) => !CATALOGUE_FILES.some((c) => s.rel.endsWith(c)),
    );
    const exempt = new Set(EXTERNALLY_EMITTED.map((e) => e.event));
    return events.filter((name) => {
        if (exempt.has(name)) return false;
        // The emit shape is `event: 'NAME'` — the discriminant the bus
        // narrows on, and the only way a domain event is constructed.
        const needle = `event: '${name}'`;
        return !emitters.some((s) => s.text.includes(needle));
    });
}

function loadSources(): Array<{ rel: string; text: string }> {
    return SCAN_ROOTS.flatMap(walk).map((full) => ({
        rel: full.replace(ROOT + '/', ''),
        text: readFileSync(full, 'utf8'),
    }));
}

describe('automation catalogue — every event has an emitter', () => {
    it('no catalogue entry is stranded without a producer', () => {
        const orphans = findOrphanEvents(AUTOMATION_EVENT_NAMES, loadSources());
        expect({ orphans }).toEqual({ orphans: [] });
    });

    it('the exemption list carries a reason for every entry', () => {
        for (const e of EXTERNALLY_EMITTED) {
            expect(e.reason.trim().length).toBeGreaterThan(10);
        }
    });

    // ── Mutation proof ────────────────────────────────────────────────
    // A guard that cannot fail is decoration. These drive the detector
    // with a corpus that is wrong in the exact way the real one was.
    describe('the detector actually detects', () => {
        it('flags an event that no file emits', () => {
            const sources = [{ rel: 'src/app-layer/usecases/x.ts', text: "event: 'REAL_EVENT'" }];
            expect(findOrphanEvents(['REAL_EVENT', 'ORPHAN_EVENT'], sources)).toEqual([
                'ORPHAN_EVENT',
            ]);
        });

        it('does NOT count the catalogue files themselves as emitters', () => {
            // The precise historical shape: the name was present in
            // events.ts, event-contracts.ts and event-labels.ts, and
            // nowhere else. All three must be excluded or the guard
            // would have passed on the nine real orphans.
            const sources = CATALOGUE_FILES.map((c) => ({
                rel: c,
                text: "event: 'TEST_RUN_FAILED'",
            }));
            expect(findOrphanEvents(['TEST_RUN_FAILED'], sources)).toEqual(['TEST_RUN_FAILED']);
        });

        it('accepts an event emitted from anywhere outside the catalogue', () => {
            const sources = [
                ...CATALOGUE_FILES.map((c) => ({ rel: c, text: "event: 'X'" })),
                { rel: 'src/app-layer/jobs/some-job.ts', text: "  event: 'X',\n" },
            ];
            expect(findOrphanEvents(['X'], sources)).toEqual([]);
        });
    });
});
