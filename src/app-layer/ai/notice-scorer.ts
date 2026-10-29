/**
 * Shadow scoring of DSA notices (P5.5b, #1596).
 *
 * ## Shadow mode is the constraint, not the feature
 *
 * The score is written and read by NOTHING that decides anything. Not the
 * triage queue's order, not a threshold, not a filter. That is the whole
 * specification, and it is easy to violate later in a way that looks like an
 * improvement — "sort the queue by score" is a decision path wearing a sort,
 * and it would mean an unevaluated model deciding which Art 16 notices a human
 * sees first.
 *
 * So the durable artefact of this phase is arguably
 * `tests/guards/notice-score-is-shadow-only.test.ts` rather than this file.
 * The database half is in the migration: no policy arm grants `app_user` any
 * access to `NoticeScore`, so a request-path read would see zero rows even if
 * the source were changed.
 *
 * ## Why it bypasses `ai/routing.ts`
 *
 * `completeWithRouting` needs a tenant `RequestContext` at five points — the
 * rate limit, the tier gate, `assertAiBudget`, the response-cache key and
 * `recordAiUsage` — and a notice has no tenant. The signed-in path is
 * person-scoped (`/api/social/reports` runs `runInUserContext`, which sets
 * `app.user_id` and deliberately no tenant), and the anonymous Art 16 path has
 * no user at all. Inventing a tenant would charge an arbitrary farm for
 * platform work.
 *
 * This is the documented pattern, not a new one: `field-briefing.ts` is the
 * template, copied by `news-event-extractor` and `support-scheme-extractor`,
 * and all four are recorded in `ai-spend-gate-covers-embeddings`'s
 * `DELIBERATELY_UNGATED` map with that reasoning.
 *
 * ## The ceiling is load-bearing here in a way it is not for the other three
 *
 * Those three are scheduled against data we already hold, so their volume is
 * ours to set. A notice arrives because somebody filed one, on an endpoint that
 * needs no credential — `PUBLIC_NOTICE_LIMIT` makes a flood slow at 10/min per
 * IP, but slow is not bounded. `isPlatformAiSpendAllowed` (#1423) is what turns
 * an unauthenticated write into a bounded cost, and the two are not
 * substitutes.
 *
 * ## Never throws
 *
 * Returns `null` on anything — no key, no budget, a provider error, output that
 * fails validation. A shadow score that does not exist is read by nobody, so
 * there is nothing to degrade; and the caller is a scheduled job whose job is
 * to move on to the next notice.
 */
import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { isPlatformAiSpendAllowed, recordPlatformAiUsage } from './platform-budget';

/**
 * Pinned, like `BRIEFING_MODEL` in `field-briefing.ts`: the stored
 * `NoticeScore.model` is only meaningful if the model is a decision rather than
 * whatever the SDK defaulted to.
 */
export const NOTICE_SCORE_MODEL = 'claude-haiku-4-5';

/** Small — the output is a number and a sentence. */
const MAX_TOKENS = 512;

/**
 * The system prompt.
 *
 * Two things it deliberately does NOT ask for: a recommendation, and a
 * decision. Asking a model "should this be removed" during a shadow period
 * produces an artefact somebody will be tempted to act on, and the point of
 * the period is to find out whether the scoring is any good BEFORE anything
 * depends on it.
 */
const SYSTEM_PROMPT = [
    'You are assessing a content report ("notice") filed on an agricultural marketplace.',
    '',
    'Rate how likely this notice is to be ABUSIVE OR VEXATIOUS — filed to harass a',
    'competitor, in bad faith, or as spam — rather than a genuine complaint about',
    'content. 0 means clearly genuine; 100 means clearly abusive.',
    '',
    'Be conservative. A terse, badly written or angry notice is NOT abusive: a',
    'farmer reporting a real problem may be rushed, may be writing in a second',
    'language, and may be upset. Score high only on positive signs of bad faith —',
    'a reason that contradicts the stated detail, commercial content, or a',
    'complaint about a competitor that names no actual problem with the content.',
    '',
    'You are NOT deciding anything. Do not recommend an action. Nothing is removed',
    'or kept on the basis of your answer; a human moderator decides on the content',
    'itself.',
].join('\n');

const TOOL_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        score: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: 'How likely the notice is abusive or vexatious. 0 = clearly genuine.',
        },
        rationale: {
            type: 'string',
            description:
                'One or two sentences saying why, in the language of the notice. A human '
                + 'evaluating whether this scoring is trustworthy reads this, so name the '
                + 'signal you used rather than restating the score.',
        },
    },
    required: ['score', 'rationale'],
} as const;

export interface NoticeToScore {
    readonly reasonCode: string;
    readonly subjectKind: string;
    /** The notifier's own words. May be null — they wrote nothing, or only markup. */
    readonly detail: string | null;
    /** Whether the notice was filed anonymously. NEVER who filed it. */
    readonly anonymous: boolean;
}

export interface NoticeScoreResult {
    readonly score: number;
    readonly rationale: string;
    readonly model: string;
}

/**
 * `anonymous` is passed and the reporter's id is NOT, which mirrors the triage
 * queue's own rule: a moderator decides on the CONTENT, and knowing who
 * reported it invites deciding on the reporter. The same applies to a model,
 * with the extra point that an id is a token it could key on for no good
 * reason.
 */
function buildUserContent(notice: NoticeToScore): string {
    return [
        `Reason given: ${notice.reasonCode}`,
        `Kind of content reported: ${notice.subjectKind}`,
        `Filed anonymously: ${notice.anonymous ? 'yes' : 'no'}`,
        '',
        'The notifier wrote:',
        notice.detail && notice.detail.trim().length > 0
            ? notice.detail
            : '(nothing — they filed the notice without a description)',
    ].join('\n');
}

/** Clamp into the range the schema promises, so a stray value cannot be stored. */
function clampScore(raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    const rounded = Math.round(raw);
    if (rounded < 0 || rounded > 100) return null;
    return rounded;
}

export function isNoticeScoringConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Score one notice, or return `null`.
 *
 * `null` means "no score for this notice", which is a normal outcome and not an
 * error: shadow mode gives nothing downstream a reason to need one.
 */
export async function scoreNotice(notice: NoticeToScore): Promise<NoticeScoreResult | null> {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    // The PLATFORM budget (#1423). A boolean rather than a throw, for the
    // reason that function's docblock gives: the `catch` below would otherwise
    // swallow a refusal and report it as a failed call, making the cap
    // invisible in the logs of the thing it refused.
    if (!(await isPlatformAiSpendAllowed('notice-score'))) {
        logger.warn('notice-score skipped: the platform AI budget is exhausted', {
            component: 'ai',
            model: NOTICE_SCORE_MODEL,
        });
        return null;
    }

    try {
        const client = new Anthropic({
            apiKey,
            ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
        });

        const response = await client.messages.create({
            model: NOTICE_SCORE_MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: buildUserContent(notice) }],
            tools: [
                {
                    name: 'notice_score',
                    description: 'Return the abuse-likelihood assessment as structured data.',
                    input_schema: TOOL_INPUT_SCHEMA as unknown as Anthropic.Messages.Tool.InputSchema,
                },
            ],
            tool_choice: { type: 'tool', name: 'notice_score' },
        });

        // Recorded BEFORE the output is parsed, and unconditionally — the
        // `field-briefing` rule. The tokens were spent whether or not the tool
        // block validates, and charging only successful parses would
        // under-count exactly the calls worth noticing.
        await recordPlatformAiUsage({
            job: 'notice-score',
            model: NOTICE_SCORE_MODEL,
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
        });

        for (const block of response.content) {
            if (block.type === 'tool_use' && block.name === 'notice_score') {
                const raw = block.input as { score?: unknown; rationale?: unknown };
                const score = clampScore(raw.score);
                const rationale =
                    typeof raw.rationale === 'string' ? raw.rationale.trim() : '';

                if (score === null || rationale.length === 0) {
                    // A score with no stated reason is useless for the one
                    // thing a shadow period is for — a human judging whether
                    // the scoring can be trusted — so it is not stored.
                    logger.warn('notice-score output failed validation', {
                        component: 'ai',
                        model: NOTICE_SCORE_MODEL,
                        hasScore: score !== null,
                        hasRationale: rationale.length > 0,
                    });
                    return null;
                }

                return { score, rationale, model: NOTICE_SCORE_MODEL };
            }
        }

        logger.warn('notice-score returned no tool_use block', {
            component: 'ai',
            model: NOTICE_SCORE_MODEL,
        });
        return null;
    } catch (err) {
        logger.warn('notice-score call failed', {
            component: 'ai',
            model: NOTICE_SCORE_MODEL,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
