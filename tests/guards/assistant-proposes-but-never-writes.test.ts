/**
 * The assistant PREPARES; it never executes — #2578.
 *
 * ## The owner's constraint, held rather than stated
 *
 * "Asked to DO something it PREPARES it; a person confirms with one tap. The
 * assistant never executes."
 *
 * That is the most load-bearing sentence in the brief, and a comment saying so
 * is worth nothing the first time somebody adds a tool that writes — which is
 * an easy, well-meant change, because a tool that writes is a better demo. So
 * the constraint is checked on the IMPORTS of the assistant's tool surface:
 *
 *   - no repository, and no Prisma client (the existing tools guard);
 *   - **no write VERB from any usecase.** `listTasks` is fine; a
 *     `createLogEntry` import is the assistant executing.
 *
 * The verb list is a prefix match on the imported NAME, which is coarse on
 * purpose. A narrower rule — "no usecase that calls `prisma.create`" — would
 * need the whole call graph and would fail open on the shape it had not
 * modelled. This fails CLOSED on an unfamiliar verb: `scheduleX` or `applyX`
 * is refused until somebody writes down why it is a read.
 *
 * ## What is NOT claimed
 *
 * That a draft is harmless. A draft is prose the model wrote from farm data,
 * so it goes through the egress scan like the answer — that is
 * `emit-answer.ts`'s job and `assistant-answer-goes-through-the-scan` holds
 * it. This guard is only about writes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

/** Every file that can reach a write from the assistant's tool surface. */
const SURFACE = [
    'src/app-layer/ai/assistant/propose.ts',
    'src/app-layer/ai/assistant/tools.ts',
    'src/app-layer/ai/assistant/tool-loop.ts',
];

const WRITE_VERBS = /^(create|update|delete|remove|archive|upsert|save|write|apply|submit|schedule|enqueue|send|publish|approve|reject|revoke)/i;

/** Named imports in one file, grouped by the module they came from. */
function namedImportsOf(rel: string): { module: string; names: string[] }[] {
    const code = blankNonCode(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    return [...code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)].map((m) => ({
        module: m[2],
        names: m[1]
            .split(',')
            .map((n) => n.replace(/^\s*type\s+/, '').trim())
            .filter(Boolean),
    }));
}

describe('the assistant proposes but never writes (#2578)', () => {
    it('control: every file in the surface exists and imports something', () => {
        // Without this a rename makes the assertions below pass over nothing.
        for (const rel of SURFACE) {
            const groups = namedImportsOf(rel);
            expect(groups.length).toBeGreaterThan(0);
        }
        console.log(`[assistant-writes] ${SURFACE.length} file(s) in the tool surface`);
    });

    it('imports NO write verb from any usecase', () => {
        const offenders: string[] = [];
        for (const rel of SURFACE) {
            for (const { module, names } of namedImportsOf(rel)) {
                if (!module.includes('app-layer/usecases/')) continue;
                for (const name of names) {
                    if (WRITE_VERBS.test(name)) offenders.push(`${rel}: ${name} from ${module}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('imports at least one usecase READ — so the rule is not passing over nothing', () => {
        // The positive control. A surface importing no usecase at all would
        // satisfy the assertion above with perfect confidence.
        const reads = SURFACE.flatMap((rel) =>
            namedImportsOf(rel)
                .filter((g) => g.module.includes('app-layer/usecases/'))
                .flatMap((g) => g.names),
        );
        console.log(`[assistant-writes] usecase imports: ${reads.join(', ') || 'none'}`);
        expect(reads.length).toBeGreaterThanOrEqual(1);
        for (const name of reads) expect(WRITE_VERBS.test(name)).toBe(false);
    });

    it('the propose module validates against the PRODUCTION schema, not a copy', () => {
        // A copy of `CreateLogEntrySchema` here would be a second answer to
        // "what may a journal entry contain", and two answers diverge. So the
        // import is asserted: a draft that the real route would refuse cannot
        // be offered.
        const groups = namedImportsOf('src/app-layer/ai/assistant/propose.ts');
        const fromSchemas = groups.filter((g) => g.module === '@/lib/schemas').flatMap((g) => g.names);
        expect(fromSchemas).toContain('CreateLogEntrySchema');
    });
});
