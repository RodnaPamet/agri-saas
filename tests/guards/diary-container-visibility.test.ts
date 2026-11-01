/**
 * Every task LIST either excludes a diary record's containers or says why not.
 *
 * #2696, owner 2026-11-01: a cultivation recorded through «Нов запис» showed
 * up in Задачи as three «Очаква преглед» rows — one per block — for work the
 * farmer had already done. `EXCLUDE_DIARY_CONTAINERS` is the fix; this is what
 * stops the sixth list surface re-creating the defect.
 *
 * ## It derives, it does not list
 *
 * The population is every `task.findMany` under `src/`, read from the
 * filesystem. A guard holding a hand-written list of five surfaces would have
 * been green on the day the defect shipped, because the defect was a surface
 * nobody had thought to list. There are **zero exemptions** today, which is
 * what gives the four passes below teeth: a new enumerating read matches none
 * of them and fails.
 *
 * ## What each pass means, and what the third one does NOT cover
 *
 *   1. **excluded** — spreads the constant.
 *   2. **via `_buildWhere`** — passes the shared builder's result, which
 *      spreads it. Two reads, and they are the reason this guard cannot simply
 *      text-match the constant at every call site.
 *   3. **bounded by the caller** — `id: { in: … }`. The read enumerates
 *      nothing; whoever chose the ids made the decision.
 *   4. **group-scoped** — the `where` names `treatmentGroupId`, so it is
 *      asking about one record ON PURPOSE. The register gatherer, the
 *      correction trail and the withdrawal path are all this.
 *
 * Pass 3 is the loose one and is stated rather than hidden: `listRowsByIds`
 * is an `id: { in: … }` read that IS a list surface (a parcel's task history)
 * and does need the filter — it has it, by its caller's decision, not because
 * this guard demanded it. So pass 3 asserts "the decision was made upstream",
 * which is weaker than the other three. A reviewer adding an `id: { in: … }`
 * read that enumerates a person's work still has to think.
 *
 * Comments are STRIPPED before matching. Three of the five filtered sites
 * explain themselves in prose that names `treatmentGroupId` and `dueAt`, and
 * an unstripped scan would classify a read by its own apology.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** Reads that deliberately ENUMERATE containers. Empty, and meant to stay so. */
const DECLARED_CONTAINER_READS: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
    }
    return out;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

type Verdict = 'excluded' | 'via-buildWhere' | 'bounded-by-caller' | 'group-scoped' | 'UNCLASSIFIED';

interface Site {
    readonly file: string;
    readonly line: number;
    readonly verdict: Verdict;
}

/** Classify every `task.findMany` in one file. */
export function classifyFile(relPath: string, source: string): Site[] {
    const code = stripComments(source);
    const lines = code.split('\n');
    const sites: Site[] = [];

    lines.forEach((line, i) => {
        if (!/\btask\.findMany\(/.test(line)) return;
        // The call's own text: from here to the end of the argument object. A
        // fixed window rather than a brace matcher — every one of these reads
        // declares its `where` within a few lines, and a matcher that drifted
        // would swallow the NEXT read's where and classify this one by it.
        const window = lines.slice(i, i + 22).join('\n');
        const before = lines.slice(Math.max(0, i - 22), i).join('\n');

        // A read may pass a bare `where,` built ABOVE the call — both jobs do,
        // and a forward-only window scored them UNCLASSIFIED while the clause
        // sat eight lines up. So the preceding window is read too, but ONLY
        // for a call that actually passes `where` by reference; scanning
        // backwards unconditionally would let one covered read vouch for its
        // uncovered neighbour.
        const byReference = /where,|where: where/.test(window);
        let verdict: Verdict = 'UNCLASSIFIED';
        if (window.includes('EXCLUDE_DIARY_CONTAINERS')) verdict = 'excluded';
        else if (byReference && before.includes('EXCLUDE_DIARY_CONTAINERS')) verdict = 'excluded';
        else if (byReference && /_buildWhere\(/.test(before)) verdict = 'via-buildWhere';
        else if (/id:\s*\{\s*in:/.test(window)) verdict = 'bounded-by-caller';
        else if (/treatmentGroupId/.test(window)) verdict = 'group-scoped';

        sites.push({ file: relPath, line: i + 1, verdict });
    });

    return sites;
}

describe('#2696 — a diary record\'s container tasks stay out of the task lists', () => {
    const sites = walk(SRC)
        .flatMap((abs) => classifyFile(path.relative(ROOT, abs), fs.readFileSync(abs, 'utf-8')));

    it('classifies every `task.findMany`, with nothing unaccounted for', () => {
        const counts = sites.reduce<Record<string, number>>((acc, s) => {
            acc[s.verdict] = (acc[s.verdict] ?? 0) + 1;
            return acc;
        }, {});

        // eslint-disable-next-line no-console
        console.log(
            `[diary-container-visibility] ${sites.length} task.findMany reads: `
                + `${counts.excluded ?? 0} exclude containers, `
                + `${counts['via-buildWhere'] ?? 0} via _buildWhere, `
                + `${counts['bounded-by-caller'] ?? 0} bounded by the caller's ids, `
                + `${counts['group-scoped'] ?? 0} group-scoped on purpose, `
                + `${Object.keys(DECLARED_CONTAINER_READS).length} declared exemptions`,
        );

        // A floor, so an extraction that stopped matching fails instead of
        // passing over an empty population.
        expect(sites.length).toBeGreaterThanOrEqual(20);

        const unclassified = sites
            .filter((s) => s.verdict === 'UNCLASSIFIED')
            .filter((s) => !(`${s.file}` in DECLARED_CONTAINER_READS));

        expect(unclassified).toEqual([]);
    });

    it('the five person-facing lists are the EXCLUDED ones, by name', () => {
        // Named deliberately: the count above would be satisfied by five
        // exclusions landing on the wrong five reads.
        const excluded = new Set(sites.filter((s) => s.verdict === 'excluded').map((s) => s.file));
        for (const f of [
            'src/app-layer/repositories/WorkItemRepository.ts', // trend + parcel list
            'src/app-layer/usecases/calendar.ts',
            'src/app-layer/usecases/search.ts',
            'src/app-layer/jobs/task-due-notification.ts',
            'src/app-layer/jobs/deadline-monitor.ts',
        ]) {
            expect([...excluded]).toContain(f);
        }
    });

    it('the shared rule is one constant, not a repeated literal', () => {
        // `treatmentGroupId: null` spelled at a call site would drift from the
        // module that explains it, and is how the sixth surface gets a filter
        // with no reasoning attached.
        const strays = walk(SRC)
            .filter((p) => !p.endsWith('diary-container.ts'))
            .flatMap((abs) => {
                const code = stripComments(fs.readFileSync(abs, 'utf-8'));
                return /treatmentGroupId:\s*null/.test(code) ? [path.relative(ROOT, abs)] : [];
            });
        expect(strays).toEqual([]);
    });

    describe('the detector has teeth', () => {
        it('fails an enumerating read that excludes nothing', () => {
            const bad = `
                const rows = await db.task.findMany({
                    where: { tenantId: ctx.tenantId, status: 'OPEN' },
                    select: { id: true },
                });`;
            expect(classifyFile('synthetic.ts', bad)[0].verdict).toBe('UNCLASSIFIED');
        });

        it('is not fooled by a comment that merely NAMES the constant', () => {
            const bad = `
                // Deliberately does not use EXCLUDE_DIARY_CONTAINERS.
                const rows = await db.task.findMany({
                    where: { tenantId: ctx.tenantId },
                });`;
            expect(classifyFile('synthetic.ts', bad)[0].verdict).toBe('UNCLASSIFIED');
        });

        it('one covered read does not vouch for its uncovered neighbour', () => {
            // The backward scan's own failure mode: a `where` literal carrying
            // the constant, then an unrelated read below it that builds its
            // own inline where.
            const src = `
                const where = { tenantId, ...EXCLUDE_DIARY_CONTAINERS };
                await db.task.findMany({ where, select: { id: true } });
                await db.task.findMany({ where: { tenantId, status: 'OPEN' } });`;
            const verdicts = classifyFile('s.ts', src).map((s) => s.verdict);
            expect(verdicts).toEqual(['excluded', 'UNCLASSIFIED']);
        });

        it('accepts each of the four passes', () => {
            const ok = (src: string) => classifyFile('s.ts', src)[0].verdict;
            expect(ok(`db.task.findMany({ where: { t, ...EXCLUDE_DIARY_CONTAINERS } })`)).toBe('excluded');
            expect(ok(`const where = WorkItemRepository._buildWhere(ctx, f);\ndb.task.findMany({\n where,\n})`))
                .toBe('via-buildWhere');
            expect(ok(`db.task.findMany({ where: { id: { in: ids } } })`)).toBe('bounded-by-caller');
            expect(ok(`db.task.findMany({ where: { treatmentGroupId: handle } })`)).toBe('group-scoped');
        });
    });
});
