/**
 * The incident docs must describe the alerting that is DEPLOYED, not the one
 * that was designed.
 *
 * ## What this protects
 *
 * `infra/alerts/external-uptime.yml` ends with a direct instruction:
 *
 * > Do not write an acknowledge or response time anywhere on the strength of
 * > this channel.
 *
 * It was written because the deployment has detection and no routing. A GCP
 * uptime check emails one address about two minutes after the service stops
 * answering; nothing pages, escalates or re-notifies. Both halves are load
 * bearing and they fail in opposite directions:
 *
 *   - Understate it ("nothing detects an outage") and a responder does not
 *     know an email is already waiting. That sentence was true until
 *     2026-09-17 and false afterwards, and it survived in four places.
 *   - Overstate it ("acknowledge within 15 minutes") and a reader believes a
 *     clock is being watched. `docs/incident-response.md` carried a PagerDuty
 *     rota and a 15-minute acknowledge budget for five months after it was
 *     known that no such service existed — including as step 1 of "Common
 *     first steps", an instruction to perform an impossible action during an
 *     outage.
 *
 * #981 decided to ACCEPT one inbox as the posture rather than build a rota,
 * which makes these documents the deliverable: the gap is no longer tracked
 * anywhere else.
 *
 * ## Why this parses instead of grepping
 *
 * The existing assertions in `oi-3-runbook-and-slos.test.ts` match
 * `/unbounded/` and `/someone notices/` against SLO 7. The honest text and
 * the dishonest text BOTH contain those words — the old version said
 * detection was unbounded, the new one says acknowledgement is. A guard that
 * cannot tell them apart passes on either, which is the same green-over-
 * nothing this repo keeps paying for.
 *
 * So the severity table is parsed into cells and the ACKNOWLEDGE column is
 * read on its own. `4 hours` in the resolution column is a real budget and
 * must keep passing; `15 minutes` in the acknowledge column must not. Prose
 * about the removal ("a 15-minute acknowledge was written here") is not a
 * prescription and is invisible to a cell read, where a whole-file grep would
 * be unable to tell it from the thing it describes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RUNBOOK = 'docs/incident-response.md';
const SLOS = 'docs/slos.md';

/** The markdown table rows under a `## heading`, as trimmed cell arrays. */
function tableUnder(src: string, heading: string): string[][] {
    const start = src.indexOf(heading);
    if (start === -1) return [];
    const body = src.slice(start + heading.length);
    const rows: string[][] = [];
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('|')) {
            if (rows.length > 0) break; // the table ended
            continue;
        }
        const cells = t.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
        rows.push(cells);
    }
    return rows;
}

/** One row of a parsed table, as a header→cell record. */
function rowsAsRecords(rows: string[][]): Record<string, string>[] {
    if (rows.length < 2) return [];
    const header = rows[0];
    return rows.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

const severityRows = rowsAsRecords(tableUnder(read(RUNBOOK), '## Severity definitions'));
const columnMatching = (re: RegExp): string | undefined =>
    Object.keys(severityRows[0] ?? {}).find((h) => re.test(h));

describe('the incident docs state the posture that is deployed', () => {
    describe('the guard is reading real tables', () => {
        it('the severity table parsed into rows', () => {
            // Every assertion below reads a cell. A renamed heading yields []
            // and each `.filter()` on it is vacuously satisfied — the empty
            // selection that this file exists to stop being a pass.
            expect(severityRows.length).toBeGreaterThanOrEqual(2);
        });

        it('it has an acknowledge column and a severity column', () => {
            expect(columnMatching(/acknowledge/i)).toBeDefined();
            expect(columnMatching(/severity/i)).toBeDefined();
        });

        it('a CRITICAL row exists', () => {
            const sev = columnMatching(/severity/i)!;
            expect(severityRows.some((r) => /critical/i.test(r[sev]))).toBe(true);
        });
    });

    it('no severity carries an acknowledge time', () => {
        // The column is read alone deliberately: the resolution column's
        // "4 hours" is a real budget that runs once a human starts, and a
        // whole-row check would have to permit durations and so permit this.
        const ack = columnMatching(/acknowledge/i)!;
        const sev = columnMatching(/severity/i)!;
        const offenders = severityRows
            .filter((r) => /\d+\s*(minute|min\b|hour|hr\b|second)/i.test(r[ack]))
            .map((r) => `  ${r[sev]} → acknowledge "${r[ack]}"`);
        if (offenders.length > 0) {
            throw new Error(
                `docs/incident-response.md promises an acknowledge time:\n${offenders.join('\n')}\n\n` +
                    `Nothing pages, escalates or re-notifies — one email to one address. An ` +
                    `acknowledge budget nothing enforces reads as a commitment to whoever opens ` +
                    `this runbook mid-incident. See infra/alerts/external-uptime.yml, which says ` +
                    `not to write one anywhere, and #981, which accepted the inbox as the posture.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('no severity routes to a service that is not deployed', () => {
        const routing = columnMatching(/routing/i);
        expect(routing).toBeDefined();
        const sev = columnMatching(/severity/i)!;
        // A mention is fine anywhere else in the document — saying PagerDuty
        // is absent requires naming it. A ROUTING CELL is not a mention: it
        // tells the reader where this alert goes.
        const offenders = severityRows
            .filter((r) => /pagerduty|opsgenie|alertmanager|`?#[a-z-]*alert/i.test(r[routing!]))
            .map((r) => `  ${r[sev]} → routes to "${r[routing!]}"`);
        expect(offenders).toEqual([]);
    });

    it('no numbered step instructs the responder to acknowledge', () => {
        // "1. **Acknowledge in PagerDuty** within 15 minutes" stood as step 1
        // of Common first steps. A step is an instruction, and this one could
        // not be carried out.
        const steps = read(RUNBOOK)
            .split('\n')
            .filter((l) => /^\s*\d+\.\s*\*{0,2}acknowledge\b/i.test(l));
        expect(steps).toEqual([]);
    });

    it('the runbook names the channel that actually fires', () => {
        // The negatives above are all satisfied by deleting the section. This
        // is the positive half: the document must still tell a responder where
        // the alert came from.
        const src = read(RUNBOOK);
        expect(src).toMatch(/agrent on-call/);
        expect(src).toMatch(/agrent production is not ready/);
        expect(src).toMatch(/readyz/);
    });

    it('SLO 7 does not claim detection is uninstrumented', () => {
        // True until 2026-09-17, false after, and it outlived the fact in the
        // summary table, the risk paragraph, the App Down opener and
        // docs/backup-restore.md. The uptime check is what makes it false.
        const src = read(SLOS);
        const rtoRow = src
            .split('\n')
            .find((l) => l.trim().startsWith('| RTO (Recovery Time)'));
        expect(rtoRow).toBeDefined();
        expect(rtoRow).not.toMatch(/detection is not instrumented|detection is uninstrumented/i);
        expect(src).toMatch(/agrent-readyz-oKY0R5q09QU/);
    });

    it('SLO 7 still names acknowledgement as the part with no bound', () => {
        // The other direction. Removing the caveat entirely would satisfy
        // every negative above and leave the 4-hour RTO reading as end to end.
        const src = read(SLOS);
        const rto = src.slice(src.indexOf('## SLO 7: RTO'), src.indexOf('## SLO Summary Table'));
        expect(rto.length).toBeGreaterThan(1500);
        expect(rto).toMatch(/no rota/i);
        expect(rto).toMatch(/#981/);
    });
});
