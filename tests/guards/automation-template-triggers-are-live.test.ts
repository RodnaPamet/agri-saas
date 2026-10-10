/**
 * Guard: every automation template triggers on a LIVE catalogue event (#1525).
 *
 * ## What this closes, and why it was not closed before
 *
 * `RULE_SUGGESTION_CANDIDATES` used to hold one hand-written candidate on
 * `ISSUE_CREATED`. That event lost its only producer when the `/issues/**`
 * surface was retired, so the suggestion would have led a tenant to build a
 * rule that could never fire — the defect CLAUDE.md records against
 * `TEST_PLAN_*`, where the rule builder went on offering triggers for deleted
 * models.
 *
 * The old docblock asked for the property to be checked BY HAND:
 *
 *   > A new entry must trigger on an event in `AUTOMATION_EVENTS` that has a
 *   > live PRODUCER. `automation-catalog-emitter-coverage` holds that property
 *   > for the catalogue; it cannot see a suggestion naming a dead one, so
 *   > check it here by hand.
 *
 * Now that the rail derives from `AUTOMATION_TEMPLATES`, the gap moves to the
 * templates — and `automation-epic8-templates.test.ts` does not check it
 * either. So a template naming a dead event would reach the rail by exactly
 * the route the old candidate did.
 *
 * ## The property is TRANSITIVE, which is the point
 *
 * This suite asserts one link: every template's `trigger` is in
 * `AUTOMATION_EVENTS`. `automation-catalog-emitter-coverage` already asserts
 * the other: every catalogue event has an in-repo emitter, and its
 * `EXTERNALLY_EMITTED` exemption list is EMPTY, so there is no event in the
 * catalogue without a producer.
 *
 * Chained, those give "every template — and therefore every rail suggestion —
 * triggers on something this codebase can actually emit", without this file
 * re-deriving emitter coverage. The second assertion below pins that the other
 * guard's exemption list is still empty, because the chain breaks silently if
 * somebody adds an entry to it: the link would still hold and the conclusion
 * would not.
 */
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';
import { AUTOMATION_TEMPLATES } from '@/data/automation-templates';
import { RULE_SUGGESTION_CANDIDATES } from '@/app-layer/usecases/automation-suggestions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../helpers/collect-files';

describe('automation templates trigger on live events (#1525)', () => {
    it('there ARE templates to check — the denominator', () => {
        // With none, every assertion below is vacuous, and an empty catalogue
        // must not read the same as a verified one. This is also the state
        // #1479 left the rail in, which is what #1525 is about.
        expect(AUTOMATION_TEMPLATES.length).toBeGreaterThan(0);
        expect(AUTOMATION_EVENT_NAMES.length).toBeGreaterThanOrEqual(10);
    });

    it('every template trigger is a known catalogue event', () => {
        const known = new Set<string>(AUTOMATION_EVENT_NAMES);
        const dead = AUTOMATION_TEMPLATES.filter((t) => !known.has(t.trigger));
        if (dead.length) {
            throw new Error(
                `${dead.length} template(s) trigger on an event that is not in the catalogue:\n\n` +
                    dead.map((t) => `    ${t.id}  trigger=${t.trigger}`).join('\n') +
                    `\n\nA template is importable as a DRAFT rule and is now also the source ` +
                    `of the suggestions rail (#1525), so a dead trigger becomes a rule that ` +
                    `can never fire — the ISSUE_CREATED defect #1479 removed.\n\n` +
                    `Add the event to src/app-layer/automation/events.ts with a producer, or ` +
                    `retire the template.`,
            );
        }
    });

    it('the emitter guard it chains to still exempts NOTHING', () => {
        // The link above only yields "has a producer" because
        // `automation-catalog-emitter-coverage` exempts no event. If that list
        // gains an entry, this file's conclusion quietly stops following from
        // its assertion — the premise expires with nothing failing.
        const other = readFileSync(
            join(REPO_ROOT, 'tests/guards/automation-catalog-emitter-coverage.test.ts'),
            'utf8',
        );
        expect(other).toContain('EXTERNALLY_EMITTED');
        expect(other).toMatch(/EXTERNALLY_EMITTED[^=]*=\s*\[\]/);
    });

    describe('the derived rail candidates', () => {
        it('are non-empty, and every one came from a template', () => {
            // The rail was empty before this change; that is the whole of
            // #1525. Asserting non-empty here means a regression to an empty
            // catalogue fails loudly instead of rendering a blank rail.
            expect(RULE_SUGGESTION_CANDIDATES.length).toBeGreaterThan(0);
            const templateIds = new Set(AUTOMATION_TEMPLATES.map((t) => t.id));
            for (const c of RULE_SUGGESTION_CANDIDATES) {
                expect(templateIds.has(c.id)).toBe(true);
            }
        });

        it('carry DISTINCT confidence scores — the sort needs a total order', () => {
            // Equal scores leave `rankRuleSuggestions`'s strict comparison to
            // break ties arbitrarily, so two tenants could see different
            // orders from identical data.
            const scores = RULE_SUGGESTION_CANDIDATES.map((c) => c.confidenceScore);
            expect(new Set(scores).size).toBe(scores.length);
        });

        it('never claim certainty, and stay inside 0–1', () => {
            // The score is a proxy for catalogue position, not a measurement.
            for (const c of RULE_SUGGESTION_CANDIDATES) {
                expect(c.confidenceScore).toBeGreaterThan(0);
                expect(c.confidenceScore).toBeLessThan(1);
            }
        });

        it('only offer actions the rail can actually render', () => {
            for (const c of RULE_SUGGESTION_CANDIDATES) {
                expect(['NOTIFY_USER', 'CREATE_TASK']).toContain(c.actionType);
            }
        });
    });
});
