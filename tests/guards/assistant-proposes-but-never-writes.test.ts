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
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** Every file that can reach a write from the assistant's tool surface. */
const PROPOSE = 'src/app-layer/ai/assistant/propose.ts';

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

    it('the propose module DERIVES its draft fields from production schemas', () => {
        // Rewritten by #2632. It asserted the import of `CreateLogEntrySchema`
        // by name, which was right about the principle and wrong about the
        // schema: no mounted create form posts that body on either client, and
        // a treatment draft cannot satisfy the whole production schema anyway
        // (`parcelIds`, `doseValue` and `doseUnitId` are required and all three
        // are the person's to supply).
        //
        // So the assertion is now about the DERIVATION rather than one name: a
        // production schema per kind, and the draft fields lifted off its
        // `.shape`. A hand-written copy of the field types would be a second
        // answer to "what may this body contain", and two answers diverge.
        // Comments blanked, strings INTACT: the subject here is the string
        // VALUES in `PROPOSAL_KINDS`, and `{ strings: true }` blanks exactly
        // what this reads — it reported "0 kind(s)" on the first run. The
        // helper's rule is `strings: true` when the subject is a call or a
        // structure, and plain when the subject is the text itself.
        const code = blankNonCode(readFileSync(path.join(REPO_ROOT, PROPOSE), 'utf8'));
        const fromSchemas = namedImportsOf(PROPOSE)
            .filter((g) => g.module === '@/lib/schemas')
            .flatMap((g) => g.names);
        const kinds = (code.match(/PROPOSAL_KINDS = \[([^\]]*)\]/)?.[1] ?? '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);

        console.log(
            `[assistant-propose] ${kinds.length} kind(s), ${fromSchemas.length} production ` +
                `schema(s): ${fromSchemas.join(', ') || 'none'}`,
        );
        // One production schema per kind, at least.
        expect(kinds.length).toBeGreaterThanOrEqual(1);
        expect(fromSchemas.length).toBeGreaterThanOrEqual(kinds.length);
        for (const name of fromSchemas) expect(name).toMatch(/Schema$/);
        // The derivation itself: fields come off a schema's shape.
        expect(code).toMatch(/\.shape\b/);
    });

    it('every proposal KIND names a body some MOUNTED create form posts (#2632)', () => {
        // The assertion that would have caught #2632, and the reason this file
        // exists in its new shape.
        //
        // A proposal kind is a CLAIM that a form will open filled. It was only
        // ever checked that the schema was real and that the server writes
        // nothing — never that a form consumes the draft. `journal-entry` was
        // validated against `POST /journal`'s body, and the only component
        // that posts that body is mounted exclusively for EDITING
        // (`journal/[id]/page.tsx`, always with an `initial.id`), because the
        // owner replaced the free-form create form on #1740.
        //
        // So: for each kind, the route it drafts for must be posted by a
        // component that some PAGE mounts. `existing-is-not-mounted`, applied
        // to a form rather than a route.
        const KIND_ROUTE: Record<string, string> = {
            treatment: 'journal/treatments',
            activity: 'journal/activities',
        };
        /**
         * Kinds with NO web form, each with the reason — this repo can only
         * see the web, and the phone is a different repository.
         *
         * Recorded rather than exempted-by-weakening: the rule stays "a kind
         * must name a form that exists", and an entry here is a statement that
         * the form exists on the OTHER client. When the web grows the form,
         * this test fails as a stale entry and the line is deleted — which is
         * the direction that keeps the list honest.
         */
        const NO_WEB_FORM: Record<string, string> = {
            activity: 'Phone-only. No web component posts /journal/activities — measured 2026-11-01. agrent-ios has the form (its ActivityKind is PRUNE/CULTIVATE/HARVEST); the web shows such a proposal as text until it grows one.',
        };
        // Strings intact, for the reason the sibling test records.
        const code = blankNonCode(readFileSync(path.join(REPO_ROOT, PROPOSE), 'utf8'));
        const kinds = (code.match(/PROPOSAL_KINDS = \[([^\]]*)\]/)?.[1] ?? '')
            .split(',')
            .map((k) => k.trim().replace(/^'|'$/g, ''))
            .filter(Boolean);
        expect(kinds.length).toBeGreaterThanOrEqual(1);

        const clients = collectSourceFiles({ roots: ['src/app', 'src/components'], floor: 200 });
        const readings: string[] = [];
        for (const kind of kinds) {
            const route = KIND_ROUTE[kind];
            // A kind with no recorded route is itself the failure: somebody
            // added one without saying which form opens it.
            expect({ kind, hasRoute: Boolean(route) }).toEqual({ kind, hasRoute: true });

            // Components that POST that route.
            const posters = clients.filter((f) => {
                if (!/\.tsx$/.test(f)) return false;
                const c = blankNonCode(readFileSync(f, 'utf8'), { strings: false });
                return c.includes(route);
            });
            // …and of those, the ones some page MOUNTS, or that are a page.
            const mounted = posters.filter((f) => {
                const base = path.basename(f).replace(/\.tsx$/, '');
                if (/^page$/.test(base)) return true;
                return clients.some((other) => {
                    if (other === f) return false;
                    const c = blankNonCode(readFileSync(other, 'utf8'), { strings: true });
                    return new RegExp(`<${base}[\\s/>]`).test(c);
                });
            });
            const hasWebForm = mounted.length > 0;
            const declaredPhoneOnly = kind in NO_WEB_FORM;
            readings.push(
                `${kind} -> ${route}: ${posters.length} poster(s), ${mounted.length} mounted`
                    + (declaredPhoneOnly ? ' [declared phone-only]' : ''),
            );
            // A kind needs a form on SOME client: a mounted web one, or a
            // written statement that the phone has it.
            expect({ kind, servedByAForm: hasWebForm || declaredPhoneOnly }).toEqual({
                kind,
                servedByAForm: true,
            });
            // And no stale entry: a kind declared phone-only that the web now
            // serves should lose its line, or the asymmetry outlives the fact.
            expect({ kind, declaredPhoneOnlyButWebHasOne: declaredPhoneOnly && hasWebForm }).toEqual(
                { kind, declaredPhoneOnlyButWebHasOne: false },
            );
            // The reason has to be a real one.
            if (declaredPhoneOnly) expect(NO_WEB_FORM[kind].length).toBeGreaterThan(60);
        }
        console.log(`[assistant-propose] ${readings.join('\n  ')}`);
    });
});
