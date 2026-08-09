/**
 * Roadmap-3 PR-6 — empty-state copy tone discipline.
 *
 * Empty states are where the product talks to the user the
 * most directly. The voice was inconsistent: "No assets yet.
 * Add your first asset above." vs "No risks. Create one above."
 * vs "No findings yet." Three voices, three punctuations, two
 * references to "above" (which is wrong inside Modals/Sheets).
 *
 * Locked voice for `noX` titles
 *
 *   • Single declarative phrase: "No X yet"
 *   • No trailing period
 *   • No "above" / "below" directional language
 *   • No imperative tail ("Add your first…", "Create one…")
 *
 * The "what to do next" guidance moves to a separate
 * `descriptionX` / `actionX` field on the EmptyState component
 * — addressed in a future polish PR. This PR locks the title
 * voice.
 *
 * What this ratchet bans (English locale)
 *
 *   • A `noX` title ending in a period.
 *   • A `noX` title containing "above" or "below".
 *   • A `noX` title containing "Add your first" or "Create one".
 *   • A `noX` title with the redundant "available yet" pattern.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface Hit {
    key: string;
    value: string;
    reason: string;
}

function flatten(
    obj: Record<string, unknown>,
    prefix: string[] = [],
): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
            out.push({ key: [...prefix, k].join('.'), value: v });
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out.push(...flatten(v as Record<string, unknown>, [...prefix, k]));
        }
    }
    return out;
}

describe('Empty-state copy tone (Roadmap-3 PR-6)', () => {
    it('every noX-style title in messages/en.json follows the canonical voice', () => {
        const messages = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf-8'),
        );
        const offenders: Hit[] = [];
        for (const { key, value } of flatten(messages)) {
            // Only police keys whose terminal segment is `noX` or
            // `noXAvailable` / `noXYet` (the empty-state shape).
            const last = key.split('.').pop() ?? '';
            if (!/^no[A-Z][A-Za-z]*$/.test(last)) continue;

            // Sanctioned exceptions — keys whose `noX` shape is
            // coincidental (they're not empty-state titles).
            const SANCTIONED = new Set([
                'common.noData',         // "No data available" — table empty fallback
                'login.noAccount',       // "No account?" — sign-in prompt question
                'common.none',           // "None" — generic UI label
                'common.no',             // "No" — Yes/No primitive
                'dashboard.noAlerts',    // emoji prefix + sentence — different shape
                'dashboard.noRecentActivity',  // "No recent activity" — already canonical
                'admin.noNotifications', // already canonical, no period
                'clauses.notStarted',    // not an empty-state — passes the regex but isn't one
                'clauses.notApplicable', // not an empty-state
                'practices.notApplicable',
                'tests.notTested',
                // T04 i18n migration — pre-existing inline empty-state
                // MESSAGES (full sentences with legitimate terminal
                // punctuation), not EmptyState-primitive titles. Migrated
                // verbatim from the components' hardcoded JSX; the copy
                // predates the terse-title convention. Same rationale as
                // the riskManager.* namespace exemption below.
                'treatmentPlan.noMilestones',
                'testDashboard.noCompletedRuns',
                'testDashboard.noScheduledPlans',
                'testDashboard.noRunsToChart',
                'testSchedule.noPermission',
                'testPlans.noPlans',
                'automationSuggestions.noSuggestions',
                'commandPalette.noMatchesInCategories',
                'commandPalette.noResults',
                'frameworkExplorer.noMappedPractices',
                'switcher.noWorkspaces',
                'switcher.noOrganizations',
                'onboarding.noFrameworksSelected',
                'orgSwitcher.noTenants',
                // T05 i18n migration (admin.* namespace) — pre-existing
                // inline empty-state MESSAGES + descriptions migrated
                // verbatim from the admin pages' hardcoded JSX (DataTable
                // `emptyState` props, inline `<p>` fallbacks, EmptyState
                // description/help fields). Full sentences with legitimate
                // terminal punctuation, not terse EmptyState titles — same
                // rationale as the T04 exemptions above.
                'admin.apiKeys.noActiveKeys',
                'admin.apiKeys.noRevokedExpired',
                'admin.integrations.noIntegrations',
                'admin.integrations.noSpActivity',
                'admin.ledgerIntegrity.noRuns',
                'admin.riskAppetite.noBreaches',
                'admin.roles.noRoles',
                'admin.scim.noPermission',
                'admin.scim.noActiveTokensHelp',
                'admin.vendorTemplates.noTemplatesDesc',
                'admin.vendorTemplateBuilder.noQuestions',
                'admin.members.noMembers',
                'admin.members.noPendingInvites',
                'admin.members.noActiveSessionsShort',
                'admin.members.noActiveSessionsDesc',
                // T06 i18n migration (risks batch) — pre-existing inline
                // empty-state MESSAGES / conversational fallbacks migrated
                // verbatim from the risk pages' hardcoded JSX. Full
                // sentences with legitimate terminal punctuation, not terse
                // EmptyState titles — same rationale as the T04/T05
                // exemptions above.
                'newRisk.noPracticesToLink',
                'riskAssessment.noPracticesLinked',
                'riskAssessment.noDerivableResidual',
                'riskAi.noAssetsFound',
                'riskCorrelations.noRisks',
                'riskHierarchy.noNodes',
                'riskKri.noKris',
                'riskLossEvents.noActuals',
                'riskLossEvents.noLossEvents',
                'riskReports.noReports',
                'riskScenarios.noScenarios',
                'riskDashboard.noSimulation',
                // T07 i18n migration (practices batch) — pre-existing inline
                // empty-state text migrated verbatim from the practices
                // pages' hardcoded JSX. These render as inline `<p>` subtle
                // text / EmptyState description fields (NOT terse EmptyState
                // titles), so their terminal punctuation is legitimate and
                // matches origin/main — same rationale as the T04/T05/T06
                // exemptions above.
                'practices.list.noCategorised',
                'practices.detail.noDescription',
                'practices.detail.noActivityDesc',
                'practices.testPlan.noRuns',
                // T09 i18n migration (policies/vendors batch) — pre-existing
                // inline empty-state MESSAGES migrated verbatim from the
                // policy detail page's hardcoded JSX (inline `<p>` / `<Card>`
                // / activity-feed fallbacks). Full sentences with legitimate
                // terminal punctuation, not terse EmptyState titles — same
                // rationale as the T04–T07 exemptions above.
                'policies.detail.noVersionPublished',
                'policies.detail.noVersions',
                'policies.detail.noActivity',
                // T10 i18n migration (tasks/issues/journal/findings/calendar/
                // farm-tasks batch) — inline empty-state MESSAGES migrated
                // verbatim from the hardcoded JSX: standalone `<p>` fallbacks
                // ("No description.", "No events on this day.") and
                // EmptyState / InlineEmptyState DESCRIPTIONS (paired with a
                // separate terse `noXTitle`). Full sentences with legitimate
                // terminal punctuation, not terse EmptyState titles — same
                // rationale as the T04–T09 exemptions above.
                'calendar.noEventsDay',
                'findings.createModal.noRisksToLink',
                'tasks.detail.noDescription',
                'tasks.detail.noCommentsDescription',
                'tasks.detail.noActivityDescription',
                'tasks.detail.links.noLinksDescription',
                // T11 i18n migration (frameworks/clauses/schemes/coverage/
                // access-reviews/assets batch) — EmptyState no-results
                // DESCRIPTIONS (paired with a separate terse `noResultsTitle`).
                // Full sentences with legitimate terminal punctuation, not
                // terse EmptyState titles — same rationale as the T04–T10
                // exemptions above. The `noResultsTitle` siblings ARE terse
                // and pass the ratchet unaided.
                'assets.noResultsDescription',
                'schemes.noResultsDescription',
                // W4/#92 (KB wire-up PR) — the knowledge-base ask box's
                // honest "nothing found" state. Same shape as the T11
                // exemptions above: `knowledge.ask.noResultsTitle` is the
                // terse title and passes unaided; this is its paired
                // full-sentence description explaining WHY (an honest
                // negative result, not a failure — see KnowledgeAskModal.tsx).
                'knowledge.ask.noResultsDescription',
                // T13 i18n migration (knowledge/locations batch) —
                // pre-existing inline empty-state MESSAGES migrated verbatim
                // from the hardcoded JSX: knowledge-detail version fallbacks
                // ("No version published yet.", "No versions yet.") and the
                // location-detail inline `<p>` fallbacks ("No parcels yet —
                // use …", "No spray jobs yet. …", spray-wizard "This location
                // has no parcels yet."). Full sentences with legitimate
                // terminal punctuation, not terse EmptyState titles — same
                // rationale as the T04–T11 exemptions above.
                'knowledge.detail.noVersionPublished',
                'knowledge.detail.noVersionsYet',
                'locations.detail.noParcelsHint',
                'locations.detail.noSprayJobs',
                'locations.spray.noParcels',
            ]);
            if (SANCTIONED.has(key)) continue;
            // Sanctioned namespace: `riskManager.*` keys are the
            // risk-import wizard's conversational error/info
            // messages — they're full sentences with punctuation
            // that legitimately end in periods. They are not
            // empty-state titles.
            if (key.startsWith('riskManager.')) continue;

            // Skip keys that don't START with `no` (the noX regex
            // already filters but be explicit).
            if (!last.startsWith('no')) continue;

            // Now apply the four bans.
            if (value.endsWith('.')) {
                offenders.push({
                    key,
                    value,
                    reason: 'trailing period',
                });
                continue;
            }
            if (/\babove\b|\bbelow\b/i.test(value)) {
                offenders.push({
                    key,
                    value,
                    reason: 'directional language',
                });
                continue;
            }
            if (/Add your first|Create one|Create your first/i.test(value)) {
                offenders.push({
                    key,
                    value,
                    reason: 'imperative tail',
                });
                continue;
            }
            if (/\bavailable yet\b/i.test(value)) {
                offenders.push({
                    key,
                    value,
                    reason: 'redundant "available yet"',
                });
                continue;
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.key} [${o.reason}]: ${o.value}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} empty-state title(s) off-canon.\n\nThe locked voice is "No X yet" — no period, no "above"/"below", no imperative tail, no redundant "available yet". Move "what to do next" guidance to a separate descriptionX/actionX field.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
