/**
 * An SSE frame's id is a `Notification.id`, never a dedupeKey — #2142.
 *
 * ## Why this is a rule and not a preference
 *
 * P7.2 made the frame's id a CURSOR. `serialiseFrame` puts a notification
 * frame's id on the SSE `id:` line, `EventSource` populates `Last-Event-ID`
 * from it, and `replayNotificationIdsAfter` resolves that value by looking it
 * up as a `Notification.id`.
 *
 * A dedupeKey — `{tenantId}:{TYPE}:{entityId}:{userId}:{YYYY-MM-DD}` — matches
 * no row, so it lands on replay's documented silent arm: "a cursor naming a
 * row this person cannot see resolves to nothing and replays nothing". Right
 * for a deleted notification; wrong here, because the row exists and the
 * client merely holds an identifier that cannot name it. A client whose newest
 * frame came from such a path replays NOTHING on its next reconnect, no matter
 * what arrived while it was away.
 *
 * ## Seven sites, and the one that mattered most
 *
 * The mistake was in seven of the nine publish sites, and the enumeration is
 * the lesson: a first grep piped through `head -10` showed four, and four is
 * what the issue was filed with. Counting before listing found the rest —
 * including `low-stock-monitor`, which produced 8,778 of 8,815 production
 * notification rows. The most common notification in the product was the one
 * handing out an unresolvable cursor.
 *
 * ## What this checks
 *
 * That no call passes a dedupeKey. It deliberately does NOT require every
 * caller to use `publishFreshNotifications`: `exchange-messaging` uses
 * `create` rather than `createMany`, so it already holds `row.id` and needs no
 * read-back, and `probe-event` writes no row at all by design. The rule is
 * about the VALUE, so the check is too.
 */
import * as fs from 'node:fs';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

interface Call {
    file: string;
    args: string;
}

/**
 * Every `publishNotificationEvent(...)` call and its argument list.
 *
 * Blanked source, because a docblock explaining the dedupeKey mistake — this
 * file's own subject — would otherwise read as a call that makes it. That is
 * `guards-blank-comments-before-matching` case 4, "a scar is not a wound", and
 * the modules fixed in #2142 all carry exactly such a comment now.
 */
function publishCalls(): Call[] {
    const out: Call[] = [];
    for (const full of collectSourceFiles({ roots: ['src'], extensions: ['.ts'], floor: 400 })) {
        if (full.endsWith('notification-bus.ts')) continue; // the definition
        const src = blankNonCode(fs.readFileSync(full, 'utf8'));
        const needle = 'publishNotificationEvent(';
        let i = src.indexOf(needle);
        while (i >= 0) {
            // Balance parentheses from the opening one so a nested call or an
            // object literal cannot truncate the argument list.
            let depth = 0;
            let j = i + needle.length - 1;
            for (; j < src.length; j++) {
                if (src[j] === '(') depth++;
                else if (src[j] === ')') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            out.push({ file: full, args: src.slice(i, j + 1) });
            i = src.indexOf(needle, j);
        }
        void 0;
    }
    return out;
}

describe('an SSE frame id is a row id', () => {
    const CALLS = publishCalls();

    it('finds a real population of publish sites', () => {
        // Nine at the time of writing, across jobs, usecases and the
        // notification modules. An empty selection would pass the assertion
        // below for ever, and the import-only lines must not count.
        expect(CALLS.length).toBeGreaterThanOrEqual(4);
    });

    it('no call passes a dedupeKey as the frame id', () => {
        const offenders = CALLS.filter((c) => /dedupeKey/.test(c.args));
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} publish site(s) send a dedupeKey as the frame id:\n` +
                    offenders.map((c) => `  ${c.file}`).join('\n') +
                    `\n\nThe frame's id becomes the client's \`Last-Event-ID\`, and ` +
                    `\`replayNotificationIdsAfter\` resolves it as a \`Notification.id\` — ` +
                    `so a dedupeKey means the next reconnect replays NOTHING.\n\n` +
                    `\`createMany\` returns no ids, which is why this is tempting. Use ` +
                    `\`publishFreshNotifications\` (src/app-layer/notifications/publish-fresh.ts), ` +
                    `which reads the row back by its dedupeKey inside the transaction and ` +
                    `publishes the real id after the commit.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the shared helper exists and reads the row back', () => {
        // The rule above is satisfiable by deleting the publish entirely,
        // which would be silent in a different way. This asserts the
        // alternative it points at is actually there.
        const helper = fs.readFileSync(
            'src/app-layer/notifications/publish-fresh.ts',
            'utf8',
        );
        expect(helper).toMatch(/findMany\(\{[\s\S]{0,200}dedupeKey: \{ in:/);
        expect(helper).toMatch(/select: \{ id: true, dedupeKey: true \}/);
        // And publishes the id it read, not the key it looked up by.
        expect(helper).toMatch(/\{ id: r\.id \}/);
    });

    it('CONTROL: the detector would catch the bug it was written for', () => {
        // The exact line that was in seven files.
        const bug = "publishNotificationEvent(row.tenantId, row.userId, { id: row.dedupeKey })";
        expect(/dedupeKey/.test(bug)).toBe(true);
        // And does not flag the fixed form.
        const fixed = "publishNotificationEvent(r.tenantId, r.userId, { id: r.id })";
        expect(/dedupeKey/.test(fixed)).toBe(false);
    });
});
