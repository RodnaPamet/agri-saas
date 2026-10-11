/**
 * No tenant route may answer a bare string where the spec promises the
 * `ErrorResponse` envelope (#1447).
 *
 * `ErrorResponse` is `{ error: { code, message, requestId?, details?, params? } }`
 * and its own description tells clients to switch on `error.code`. A route
 * answering `{ error: '<sentence>' }` on a status documented as that envelope
 * hands a client `undefined` where it looks for the cause.
 *
 * ## The asymmetry that makes it worth a guard
 *
 * `tests/unit/farm-creation-error-codes.test.ts` exists for a near-identical
 * defect, and its docblock is the argument: the web renders `t('failed')` for
 * any non-OK response and never notices, while the native client has to say
 * something specific in Bulgarian and notices immediately. This case is one
 * level worse — there is no `code` field at all, so there is nothing to key a
 * message off.
 *
 * ## DERIVED, and it currently finds ZERO
 *
 * #1447 reported "9 live contract violations" on documented paths. Measured
 * 2026-10-11: **zero**. Not because the routes changed, but because #1478
 * declared the bare shape HONESTLY — `RawErrorResponse`, which named the
 * spatial-import and cadastre-import routes as users of it. The spec and the
 * code agreed, which is the opposite of a lie.
 *
 * ## Then five of them were migrated anyway (#1630)
 *
 * Honest is not the same as good. agrent-ios confirmed that of the 36 bare
 * refusals here, the phone builds exactly TWO — the spatial-import upload and
 * its job poll — and that with no `error.code` to translate by it passes the
 * server's English sentence through to a Bulgarian screen. A farmer was reading
 * «File exceeds the 5 MB limit».
 *
 * So the owner authorised moving those five to the envelope. That left 2 honest
 * (the cadastre-import job poll, which the phone does not reach) and 29
 * undocumented. Cadastre was deliberately excluded: an approval for one route
 * is not an approval for the next.
 *
 * The lesson for anyone reading a zero here: this guard measures whether the
 * spec and the code AGREE, which is not the same question as whether a client
 * can act on the answer. #1630 was invisible to it in both directions.
 *
 * (The issue's own numbers almost certainly came from matching the substring
 * `ErrorResponse`, which `RawErrorResponse` contains. I reproduced that mistake
 * before reading the `$ref`.)
 *
 * So this guard is not a cleanup ratchet. It is a tripwire on the mechanism
 * #1447 actually identified:
 *
 *   > Writing the spec for a route is not transcription: the act of documenting
 *   > turns an inconsistency into a lie.
 *
 * 29 bare bodies sit on statuses nothing documents. Nothing is lying today. The
 * moment somebody registers one of those routes through `op()` — which adds
 * `400 → ErrorResponse` by default — the count below goes from 0 to N and this
 * fails, in the same change that created the problem rather than months later.
 *
 * ## What it does NOT cover
 *
 * Only the literal `{ error: '<string>' }` shape, and only where a `status:`
 * sits in the same call so the response can be matched to a documented status.
 * A route could diverge another way — a spread, a variable, a helper. The
 * honest reading of a green run is "no instance of THIS pattern contradicts the
 * spec", not "every route is compliant". #1447 says the same of its own
 * numbers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

const SPEC = 'src/generated/openapi.json';

/**
 * A bare body, captured together with the `status:` of the same
 * `jsonResponse(…)` call — the status is what decides which documented
 * response this has to agree with.
 */
const BARE_WITH_STATUS = /\{\s*error\s*:\s*['"`][\s\S]{0,400}?\}\s*,\s*\{[^}]*status\s*:\s*(\d{3})/g;

interface Finding {
    file: string;
    template: string;
    status: string;
    /** The component the spec declares for that status, or null when undocumented. */
    declared: string | null;
}

/** `src/app/api/t/[tenantSlug]/x/[id]/route.ts` -> `/api/t/{tenantSlug}/x/{id}`. */
function templateOf(rel: string): string {
    const seg = rel.slice('src/app/api/'.length, -'/route.ts'.length);
    return '/api/' + seg.replace(/\[(?:\.\.\.)?([A-Za-z0-9_]+)\]/g, '{$1}');
}

function scan(): { handlers: number; findings: Finding[] } {
    // `collectSourceFiles` rather than a hand-rolled walk: a local `walk` is the
    // function #865 found gutted-and-still-green in 37 of 47 dead guards, and
    // `file-collection-is-not-silently-empty` enforces the migration. The
    // `floor` makes an empty population THROW rather than pass.
    const all = collectSourceFiles({ roots: ['src/app/api/t'], floor: 200 });
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, SPEC), 'utf8')) as {
        paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };

    const findings: Finding[] = [];
    let handlers = 0;

    for (const abs of all) {
        const rel = path.relative(ROOT, abs);
        if (path.basename(rel) !== 'route.ts') continue;
        handlers += 1;

        // Comments blanked, strings KEPT: the subject is a code shape whose
        // discriminator is the start of a string literal, and a guard that read
        // comments would count this file's own docblock — the shape that made
        // `no-server-authored-user-copy` report five hits that were prose about
        // a throw.
        const code = blankNonCode(fs.readFileSync(abs, 'utf8'));
        const template = templateOf(rel);

        for (const m of code.matchAll(BARE_WITH_STATUS)) {
            const status = m[1];
            const entry = spec.paths[template];
            let declared: string | null = null;
            if (entry) {
                for (const op of Object.values(entry)) {
                    const r = op.responses?.[status] as
                        | { content?: { 'application/json'?: { schema?: { $ref?: string } } } }
                        | undefined;
                    if (!r) continue;
                    declared =
                        r.content?.['application/json']?.schema?.$ref?.split('/').pop() ??
                        '(inline)';
                }
            }
            findings.push({ file: rel, template, status, declared });
        }
    }
    return { handlers, findings };
}

const { handlers, findings } = scan();
const lies = findings.filter((f) => f.declared !== null && f.declared !== 'RawErrorResponse');
const honest = findings.filter((f) => f.declared === 'RawErrorResponse');
const undocumented = findings.filter((f) => f.declared === null);

/**
 * The undocumented population, pinned so it cannot GROW unnoticed.
 *
 * Not a cleanup list — nothing here is lying. It is the set that becomes a lie
 * if documented without being migrated, so a new entry is worth a look even
 * though no entry is a defect today.
 */
const UNDOCUMENTED_CEILING = 29;

describe('a bare error body never contradicts the spec (#1447)', () => {
    it('prints the denominators, so a detector that stopped matching is visible', () => {
        console.log(
            `[coded-errors] ${handlers} tenant route handlers; ${findings.length} bare-string ` +
                `bodies — ${lies.length} contradict the spec, ${honest.length} documented as ` +
                `RawErrorResponse, ${undocumented.length} on undocumented statuses`,
        );
        // Both the population and the pattern are asserted alive: a zero that
        // means "the regex stopped matching" is the failure mode here.
        expect(handlers).toBeGreaterThanOrEqual(200);
        expect(findings.length).toBeGreaterThan(0);
    });

    it('ZERO bare bodies sit on a status documented as an envelope', () => {
        // The whole point. #1447 reported 9 of these; #1478 resolved them by
        // declaring `RawErrorResponse` honestly rather than by changing code,
        // so the honest count today is zero and this is a tripwire rather than
        // a cleanup.
        //
        // If this fails, you have EITHER added a bare body to a documented
        // route, or documented a route that still has one. The second is the
        // common case and the fix belongs in the same change: reach for a
        // `coded*` helper so the refusal is machine-readable.
        expect(
            lies.map((f) => `${f.status} ${f.template} declares ${f.declared} — ${f.file}`),
        ).toEqual([]);
    });

    it('the honest ones really are declared as RawErrorResponse', () => {
        // A control on the classification above. If `RawErrorResponse` were
        // renamed or these routes re-documented, every finding would fall into
        // `lies` or `undocumented` and the zero above would stop meaning what
        // it says.
        expect(honest.length).toBeGreaterThan(0);
        for (const f of honest) expect(f.declared).toBe('RawErrorResponse');
    });

    it('the undocumented population does not grow', () => {
        // Pinned as a ceiling rather than an exact map: these are not defects,
        // so a fix should not have to edit this file. Growth should, because a
        // new bare body on an undocumented route is a future lie.
        expect({ undocumented: undocumented.length, ceiling: UNDOCUMENTED_CEILING }).toEqual({
            undocumented: Math.min(undocumented.length, UNDOCUMENTED_CEILING),
            ceiling: UNDOCUMENTED_CEILING,
        });
    });

    it('control: no OAuth-shaped route lives under this prefix', () => {
        // #1447 proposed exempting the OAuth/OIDC prefixes, where
        // `{"error":"invalid_grant"}` IS the RFC 6749 §5.2 shape and correct.
        // None are under `/api/t/` — they are under `/api/auth/`, which this
        // guard does not range over. Asserted so that an OAuth-shaped tenant
        // route has to be handled deliberately rather than inheriting an
        // exemption written for a different scope.
        expect(
            findings.filter((f) => /oauth|oidc|saml|\btoken\b|authorize/i.test(f.template)),
        ).toEqual([]);
    });
});
