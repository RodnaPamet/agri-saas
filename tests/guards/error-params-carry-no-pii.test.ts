/**
 * `ErrorParams` values are ids and quantities. Never personal data.
 *
 * A coded error carries `params` so a client can interpolate into its own
 * TRANSLATED sentence. Those values leave the server in the clear, reach
 * every client, and on the phone they land in whatever a `UserMessage` map
 * does with them.
 *
 * ── Why this needs a test and not a paragraph ──
 *
 * This repo has already paid for the same accident once, in a different
 * costume. `ParcelLease.lessorName` and `lessorEik` are in
 * `ENCRYPTED_FIELDS` *because* they are personal data about a third party,
 * and they still reached plaintext `localStorage` on the web — not because
 * anyone decided to persist them, but because persisting them required
 * nobody's decision. `PERSISTABLE_PATHS` is an allowlist for exactly that
 * reason: "a forgotten denylist entry writes PII to a phone; a forgotten
 * allowlist entry costs one refetch."
 *
 * `params` is the same shape of accident — a field that is careful at rest,
 * handed to a client in the clear because an error message wanted to name
 * something. The rule was agreed across two repos in conversation, which is
 * precisely the kind of agreement that gets rediscovered rather than kept.
 *
 * ── What this can and cannot see ──
 *
 * It matches on the KEY name, so it catches the accident — someone reaching
 * for `{ name: lease.lessorName }` because the message reads better. It
 * cannot catch a determined `{ id: person.email }`, and pretending
 * otherwise would be worse than saying so. A key-name check is a smoke
 * alarm, not a vault.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['src/app-layer', 'src/lib'];

/**
 * Key fragments that read as a person rather than a record.
 *
 * `eik` and `egn` are Bulgarian company and personal identifiers; the EGN
 * is a national ID number and the most sensitive value in the schema.
 */
const PERSONAL_KEY_FRAGMENTS = [
    'name',
    'email',
    'phone',
    'egn',
    'eik',
    'address',
    'lessor',
    'owner',
    'contact',
    'person',
];

/** The start of a coded throw: the helper and its opening paren. */
const CODED_CALL_START = /\bcoded(?:BadRequest|NotFound|Forbidden|Conflict)\(/g;
/** Hard stop, so a malformed file cannot make the scan run away. */
const MAX_ARG_SCAN = 600;

/**
 * The call's OWN argument list, from `start` to its matching close paren.
 *
 * A balanced scan and not a forward window, because a window was wrong here
 * in a way worth recording — it is the second time today the same shape bit
 * me. The first draft matched the first `{…}` within 400 characters of the
 * code argument. `evidence.ts` throws `codedBadRequest('FILE_VALIDATION_
 * ERROR', err.message)` with NO params, and five lines later builds
 * `EvidenceRepository.create(db, ctx, { type, title, fileName, owner,
 * ownerUserId, … })`. The window sailed past the call and reported three
 * PII violations in code that passes no params at all.
 *
 * A guard that cries wolf is not merely noisy: the fix I nearly reached for
 * was to loosen the RULE, which would have left the real rule weaker than
 * before the guard existed.
 */
function argsOf(src: string, start: number): string {
    let depth = 1;
    const end = Math.min(src.length, start + MAX_ARG_SCAN);
    for (let i = start; i < end; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return src.slice(start, i);
        }
    }
    return src.slice(start, end);
}

export interface ParamHit {
    file: string;
    key: string;
}

/** Param keys that read personal, across every coded throw under `dirs`. */
export function collectPersonalParamKeys(root: string, dirs: string[] = ROOTS): ParamHit[] {
    const files = collectSourceFiles({
        roots: dirs.map((d) => path.join(root, d)),
        extensions: ['.ts'],
        exclude: (rel) => /\.(test|spec)\.ts$/.test(rel),
        floor: root === REPO_ROOT ? 200 : 1,
    });

    const hits: ParamHit[] = [];
    for (const full of files) {
        const src = fs.readFileSync(full, 'utf8');
        for (const call of src.matchAll(CODED_CALL_START)) {
            // Strings AND comments blanked before the brace scan (#1387).
            // `${x}` contains a `{x}`, so a template literal in the message
            // argument was read as the params object: measured, 20 of 104
            // coded calls resolved their "params" to an interpolation. That
            // cost both ways. It reported `FARM_NAME_MAX` as a personal key
            // for containing NAME — and, worse and unreported, it meant the
            // REAL params object of 5 of those calls was never examined at
            // all, so the guard was blind on them.
            //
            // Blanking whole string literals rather than just `${…}` also
            // closes the sibling case: a quoted `'use {name} here'` is
            // likewise indistinguishable from an object literal to a regex.
            const args = argsOf(src, (call.index ?? 0) + call[0].length);
            // LOCATE in the blanked text, READ from the original. Blanking is
            // what makes `${x}` stop looking like an object literal; reading
            // the original back is what keeps a QUOTED key — `{ 'owner-name':
            // x }` — visible, since the blanked copy has erased it. Measured
            // 0 quoted keys in the 104 coded calls today, so this costs
            // nothing now and is the difference between a guard that stays
            // correct and one that goes silently blind the first time
            // somebody needs a hyphen in a key.
            //
            // Only sound because `blankNonCode` preserves positions exactly.
            const scan = blankNonCode(args, { strings: true });
            const obj = /\{([^{}]*)\}/.exec(scan);
            if (!obj) continue; // no params object among this call's arguments
            const body = args.slice(obj.index + 1, obj.index + obj[0].length - 1);
            for (const entry of body.split(',')) {
                const key = entry.split(':')[0]?.trim().replace(/['"`]/g, '');
                if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
                const lower = key.toLowerCase();
                if (PERSONAL_KEY_FRAGMENTS.some((f) => lower.includes(f))) {
                    hits.push({ file: path.relative(root, full), key });
                }
            }
        }
    }
    return hits;
}

describe('error params carry no personal data', () => {
    it('no coded throw names a personal-looking param key', () => {
        const hits = collectPersonalParamKeys(REPO_ROOT);
        if (hits.length > 0) {
            const sample = hits.map((h) => `  ${h.file}  { ${h.key}: … }`).join('\n');
            throw new Error(
                `A coded error carries a personal-looking param key:\n${sample}\n\n` +
                    `\`params\` leaves the server in the clear and reaches every client. ` +
                    `Send an id and let the client resolve the name it wants to show, or ` +
                    `leave the value out of the translated sentence. See ErrorParams in ` +
                    `src/lib/errors/types.ts.`,
            );
        }
        expect(hits).toEqual([]);
    });

    it('SELF-TEST: a personal key IS detected, an id is not', () => {
        // The rule has no real violations, so it is proven here or not at
        // all — a guard whose only evidence is an empty result is one
        // nobody can distinguish from a broken matcher.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'err-params-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    `throw codedBadRequest('A', 'msg', { id: parcel.id });`,
                    `throw codedNotFound('B', 'msg', { lessorName: lease.lessorName });`,
                    `throw codedBadRequest('C', 'msg', { count: 3 });`,
                ].join('\n'),
            );
            const found = collectPersonalParamKeys(dir, ['src/lib']);
            expect(found.map((h) => h.key)).toEqual(['lessorName']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a template literal is not a params object (#1387)', () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'err-interp-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    'throw codedBadRequest(',
                    "    'FARM_NAME_TOO_LONG',",
                    '    `A farm name may be at most ${FARM_NAME_MAX} characters.`,',
                    '    undefined,',
                    '    { max: FARM_NAME_MAX },',
                    ');',
                ].join('\n'),
                'utf8',
            );
            // Reported `FARM_NAME_MAX` before the fix — for containing NAME —
            // with no personal data anywhere near it.
            expect(collectPersonalParamKeys(dir, ['src/lib'])).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('…and the REAL params object behind one is still read (#1387)', () => {
        // The half the issue did not name, and the reason this is a fix and
        // not a mute. When the scan stopped at the interpolation it never
        // reached the actual params object, so it was BLIND on those calls —
        // measured at 5 of the 20 affected. A change that merely stopped the
        // false positive would pass the test above and leave the blindness.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'err-blind-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    'throw codedBadRequest(',
                    "    'LEASE_INVALID',",
                    '    `The lease for ${parcel.code} is invalid.`,',
                    '    undefined,',
                    '    { lessorName: lease.lessorName },',
                    ');',
                ].join('\n'),
                'utf8',
            );
            expect(collectPersonalParamKeys(dir, ['src/lib']).map((h) => h.key)).toEqual([
                'lessorName',
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a QUOTED key is still read, though the scan cannot see it (#1387)', () => {
        // Blanking string literals is what makes `${x}` stop looking like an
        // object, but it also erases a quoted key. The object is therefore
        // LOCATED in the blanked copy and READ from the original, which only
        // works because the blanker preserves positions exactly. No call in
        // the repo uses a quoted key today, so without this fixture the
        // regression would be invisible until someone needed a hyphen.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'err-quoted-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    'throw codedBadRequest(',
                    "    'X',",
                    '    `msg ${a}`,',
                    "    undefined,",
                    "    { 'ownerName': x, id: y },",
                    ');',
                ].join('\n'),
                'utf8',
            );
            expect(collectPersonalParamKeys(dir, ['src/lib']).map((h) => h.key)).toEqual([
                'ownerName',
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a brace inside a quoted MESSAGE is not a params object either (#1387)', () => {
        // The sibling of the `${…}` case: `'use {name} here'` is just as
        // indistinguishable from an object literal to a regex, and would
        // report `name` on a call whose params are an id.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'err-brace-'));
        try {
            fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'src/lib/sample.ts'),
                [
                    "throw codedBadRequest('Y', 'Use {name} in the template.', undefined, {",
                    '    id: parcel.id,',
                    '});',
                ].join('\n'),
                'utf8',
            );
            expect(collectPersonalParamKeys(dir, ['src/lib'])).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the params that DO exist are ids — a positive control on the scan', () => {
        // Two throws in journal.ts carry `{ id }`. If the matcher stops
        // finding them the suite above passes for the wrong reason, so
        // assert the scan still sees a coded call with params at all.
        const files = collectSourceFiles({
            roots: [path.join(REPO_ROOT, 'src/app-layer')],
            extensions: ['.ts'],
            exclude: (rel) => /\.(test|spec)\.ts$/.test(rel),
            floor: 50,
        });
        const withParams = files.filter((f) => {
            const src = fs.readFileSync(f, 'utf8');
            return [...src.matchAll(CODED_CALL_START)].some((m) => {
                const args = argsOf(src, (m.index ?? 0) + m[0].length);
                return /\{[^{}]*\bid\s*:/.test(args);
            });
        });
        expect(withParams.length).toBeGreaterThan(0);
    });
});
