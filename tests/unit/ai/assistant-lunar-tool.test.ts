/**
 * `lunar_calendar` — the assistant's lunar half, EXECUTED — #3098.
 *
 * ## What was wrong, and why nothing failed
 *
 * agrent-ios#634 asked for two things: the «Вие» register, and lunar answers
 * from the app's own calendar. The register shipped in #3092. The second did
 * not, and it was wired SHUT: the system prompt said, in terms, "if asked,
 * point the person at «Лунен календар» rather than answering from memory".
 *
 * That was the only safe answer while no tool existed — #3090 is the owner
 * being handed an invented lunar tradition — but it is a refusal, not an
 * answer, and it is invisible to every check: no missing key, no 404, no red
 * test. The assistant simply declined and the farmer went and looked.
 *
 * ## The two properties this file exists for
 *
 * **ONE authority.** The tool calls `lunarRange`, the same function
 * `/api/lunar` calls. A second walk of the ephemeris — however carefully
 * written — is how the screen and the assistant come to disagree about today
 * with nothing failing, which is #3090's shape exactly.
 *
 * **Tradition, not agronomy.** `lunar.traditionNotice` reads «Не е агрономски
 * съвет», and the screen shows it beside every one of these recommendations.
 * The system prompt separately forbids stating a sowing window without a tool,
 * so a tool that handed over recommendations with no caveat would be the route
 * by which that rule is evaded — by the product's own data.
 */
import { makeRequestContext } from '../../helpers/make-context';

const assertFeatureEnabled = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/lib/feature-flags', () => ({
    assertFeatureEnabled: (...a: unknown[]) => assertFeatureEnabled(...a),
}));

import { runTool, TOOL_RESULT_MAX_CHARS } from '@/app-layer/ai/assistant/tools';
import { LUNAR_TIME_ZONE, lunarRange } from '@/lib/lunar/lunar-day';
import { CROP_GROUPS, RECOMMENDATIONS, recommendationKey } from '@/lib/lunar/rules';
import { farmToday } from '@/lib/calendar-day-key';
import bg from '../../../messages/bg/app.json';

const ctx = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });
const LUNAR = (bg as { lunar: Record<string, string> }).lunar;

interface LunarResult {
    timeZone: string;
    traditionNotice: string;
    daysReturned: number;
    truncated: boolean;
    maxDays: number;
    days: Array<{
        date: string;
        dayType: string;
        phaseName: string;
        sign: string;
        element: string;
        illuminationPercent: number;
        recommendations: Record<string, string[]>;
    }>;
}

async function call(args: string): Promise<{ ok: boolean; content: string }> {
    const out = await runTool(ctx, 'lunar_calendar', args);
    return { ok: out.ok, content: out.content };
}

const parse = (content: string): LunarResult => JSON.parse(content) as LunarResult;

beforeEach(() => {
    jest.clearAllMocks();
    assertFeatureEnabled.mockResolvedValue(undefined);
});

describe('lunar_calendar (#3098)', () => {
    it('is gated on lunar.enabled, with the flag key as a LITERAL', async () => {
        await call('{}');
        expect(assertFeatureEnabled).toHaveBeenCalledWith('lunar.enabled', 'u1');
    });

    it('refuses rather than throwing when the flag is off', async () => {
        // A throw ends a stream that has already sent a 200, and the model
        // cannot learn from a dead socket. The tool must come back `ok: false`.
        assertFeatureEnabled.mockRejectedValue(new Error('feature disabled'));
        const out = await call('{}');
        expect(out.ok).toBe(false);
        // Control: the SAME call with the flag on succeeds, so the refusal is
        // the flag and not a broken tool.
        assertFeatureEnabled.mockResolvedValue(undefined);
        expect((await call('{}')).ok).toBe(true);
    });

    it('answers from the SAME engine the route serves — one lunar authority', async () => {
        const out = await call('{"from":"2026-03-10","to":"2026-03-14"}');
        expect(out.ok).toBe(true);
        const res = parse(out.content);
        // Computed INDEPENDENTLY here and compared, which is what makes this a
        // cross-check rather than a restatement of the tool's own output.
        const engine = lunarRange('2026-03-10', '2026-03-14', 14);
        expect(res.days.map((d) => d.date)).toEqual(engine.map((d) => d.date));
        expect(res.timeZone).toBe(LUNAR_TIME_ZONE);
        // Each label is the CATALOGUE's value for the engine's own enum member.
        for (const [i, day] of res.days.entries()) {
            expect(day.dayType).toBe(LUNAR[`dayType${cap(engine[i].dayType)}`]);
            expect(day.sign).toBe(LUNAR[`sign${cap(engine[i].sign)}`]);
            expect(day.element).toBe(LUNAR[`element${cap(engine[i].element)}`]);
        }
    });

    it('carries the tradition notice — the screen shows it beside every recommendation', async () => {
        const res = parse((await call('{}')).content);
        expect(res.traditionNotice).toBe(LUNAR.traditionNotice);
        // The load-bearing half of that string, pinned so a rewrite that drops
        // the disclaimer is visible here and not only on the screen.
        expect(res.traditionNotice).toContain('Не е агрономски съвет');
    });

    it('gives the catalogue SENTENCES, never the enum member', async () => {
        const res = parse((await call('{"from":"2026-03-10","to":"2026-03-16"}')).content);
        const texts = res.days.flatMap((d) => Object.values(d.recommendations).flat());
        // Control: this window must actually recommend something, or every
        // assertion below passes over an empty list.
        expect(texts.length).toBeGreaterThan(0);
        const catalogue = new Set(RECOMMENDATIONS.map((r) => LUNAR[recommendationKey(r)]));
        for (const t of texts) expect(catalogue.has(t)).toBe(true);
        // And not the raw member — `soilWork` reaching a model is how the
        // assistant comes to word a recommendation the screen words already.
        for (const r of RECOMMENDATIONS) expect(texts).not.toContain(r);
    });

    it('keys recommendations by the group LABEL, not the enum', async () => {
        const res = parse((await call('{}')).content);
        const labels = new Set(CROP_GROUPS.map((g) => LUNAR[`group${cap(g)}`]));
        for (const day of res.days) {
            for (const key of Object.keys(day.recommendations)) expect(labels.has(key)).toBe(true);
            for (const g of CROP_GROUPS) expect(Object.keys(day.recommendations)).not.toContain(g);
        }
    });

    it('defaults to the week ahead, starting from the FARM\'s today', async () => {
        const res = parse((await call('{}')).content);
        expect(res.daysReturned).toBe(7);
        expect(res.truncated).toBe(false);
        expect(res.days[0].date).toBe(farmToday());
    });

    it('caps the window and SAYS that it did', async () => {
        // 60 days is inside the route's 62 and well past the tool's cap. A cap
        // that silently returns fewer days lets the model describe nine days as
        // two months.
        const res = parse((await call('{"from":"2026-03-01","to":"2026-04-29"}')).content);
        expect(res.daysReturned).toBe(9);
        expect(res.maxDays).toBe(9);
        expect(res.truncated).toBe(true);
    });

    it('a FULL window fits TOOL_RESULT_MAX_CHARS, on every start day of a year', async () => {
        /*
         * THE REASON THIS TEST EXISTS, because it is not obvious and it cost a
         * green suite to find.
         *
         * `runTool` truncates any result over `TOOL_RESULT_MAX_CHARS`. For a
         * LIST tool that is a feature — a partial list is useful and the
         * `truncated` flag makes the shortfall reportable. For this tool it cuts
         * the serialised JSON mid-string, so the model receives a payload it
         * cannot parse at all. The first draft capped at 14 days and did
         * exactly that; nothing in the source said so, and only running it did.
         *
         * So the cap is a function of the payload, and the payload grows with
         * any field added here. Stepping by three over a year samples every
         * phase of the 29.5-day synodic month many times, so the worst case is
         * derived rather than sampled on one convenient date.
         */
        let worst = 0;
        let worstAt = '';
        for (let i = 0; i < 365; i += 3) {
            const from = addDays('2026-01-01', i);
            const out = await call(JSON.stringify({ from, to: addDays(from, 40) }));
            if (out.content.length > worst) {
                worst = out.content.length;
                worstAt = from;
            }
        }
        console.log(
            `[lunar-tool] worst full-window payload ${worst}/${TOOL_RESULT_MAX_CHARS} chars `
                + `(${Math.round(((TOOL_RESULT_MAX_CHARS - worst) / TOOL_RESULT_MAX_CHARS) * 100)}% `
                + `headroom), at ${worstAt}`,
        );
        // Control: the windows must be full ones, or this measures nothing.
        expect(worst).toBeGreaterThan(2000);
        expect(worst).toBeLessThan(TOOL_RESULT_MAX_CHARS);
    }, 120_000);

    it('resolves every label — no [object Promise] reaches the model', async () => {
        // #2691 behaviourally. A dropped await on `translateFor` puts
        // `[object Promise]` in the payload once per day, and the model then
        // summarises it with complete confidence.
        const out = await call('{"from":"2026-03-10","to":"2026-03-16"}');
        expect(out.content).not.toContain('[object Promise]');
        expect(out.content).not.toContain('undefined');
    });
});

function cap(v: string): string {
    return `${v[0].toUpperCase()}${v.slice(1)}`;
}

/** UTC arithmetic on a date-only value — no DST transitions in UTC. */
function addDays(key: string, days: number): string {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    return `${t.getUTCFullYear()}-${mm}-${dd}`;
}
