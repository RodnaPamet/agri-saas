/**
 * Shell assertions that cannot fail.
 *
 * bash lets you write something that reads like a check and cannot report a
 * problem. Three shapes, all found live in this repo on 2026-09-10:
 *
 *   psql 'SELECT ...' >/dev/null && echo "  ✓ Tenant table reachable"
 *       `cmd && echo` is not an assertion. Under `set -euo pipefail` a failing
 *       left side short-circuits, prints nothing, and does NOT trip errexit.
 *       A missing core table sailed through the monthly restore drill.
 *
 *   STARTED="$(gh api ... 2>/dev/null || echo 0)"
 *       Collapses a rate limit, a 5xx and a jq error into the same answer as a
 *       genuine zero. That value was the SOLE discriminator between a
 *       superseded cancel and a real timeout, so timeouts went unreported.
 *
 *   gcloud compute instances delete ... 2>/dev/null || echo "(nothing to delete)"
 *       Reported a DENIED delete in the same words as a no-op, while leaking a
 *       disk holding a production database and its encryption key.
 *
 * shellcheck does not catch any of these — `cmd && echo` is not an SC
 * diagnostic and SC2015 only covers the `A && B || C` mis-idiom — which is
 * why this is a repo-local guard.
 *
 * Deliberate exceptions carry `# fail-open: <reason>` on the line above.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['.github/scripts', 'infra/scripts', 'deploy'];

/** Commands whose failure means something — the ones worth asserting on. */
const FALLIBLE = /^(psql|gh|curl|wget|gcloud|docker|kubectl|aws|terraform|npm|node|jq)$/;

/**
 * The command HEADS on a line: the first word, plus the first word inside each
 * `$(...)`. Matching the bare word anywhere is not good enough — it flagged
 * `usermod -aG docker iveaghlow || true`, where `docker` is an argument and
 * `usermod` is the command.
 */
function heads(line: string): string[] {
    const out: string[] = [];
    const first = line.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '').trim().split(/\s+/)[0];
    if (first) out.push(first.replace(/^["'`$(]+/, ''));
    // Keep the `$` — `$("$GH" api ...)` must yield `$GH`, not `GH`, or the
    // variable-command test below cannot recognise it.
    for (const m of line.matchAll(/\$\(\s*["'`]?(\$?\{?[A-Za-z0-9_./-]+\}?)/g)) out.push(m[1]);
    return out;
}

/**
 * A command invoked THROUGH A VARIABLE is still a command, and the two worst
 * defects in this repo were written that way — `${GC} compute instances delete`
 * and `"$GH" api ...`. Matching only literal binary names missed both, so a
 * `${VAR}` / `"$VAR"` in command position counts as fallible: nothing else is
 * held in a variable and then invoked.
 */
const VAR_COMMAND = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/**
 * Escape hatch. NOT called "fail-open", because the commonest legitimate case
 * is the opposite: `deploy/apply.sh` uses `|| echo 000` as a sentinel OUTSIDE
 * the healthy range and then fails closed on it. That is the correct pattern.
 * `|| echo 0` in the notifier was wrong for the opposite reason — 0 collided
 * with a legitimate healthy answer. The distinction is whether the fallback
 * value can be mistaken for success, and only a human can say.
 */
const ALLOW = /#\s*shell-check-ok:/;

function shellFiles(): string[] {
    const out: string[] = [];
    for (const dir of SCAN_DIRS) {
        const abs = path.join(ROOT, dir);
        if (!fs.existsSync(abs)) continue;
        for (const e of fs.readdirSync(abs, { withFileTypes: true, recursive: true } as never) as fs.Dirent[]) {
            if (!e.isFile() || !e.name.endsWith('.sh')) continue;
            out.push(path.relative(ROOT, path.join((e as unknown as { parentPath: string }).parentPath ?? abs, e.name)));
        }
    }
    return out.sort();
}

interface Offence {
    file: string;
    line: number;
    shape: string;
    text: string;
}

export function scan(files: string[], read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8')): Offence[] {
    const found: Offence[] = [];
    for (const file of files) {
        const physical = read(file).split('\n');
        // Join `\`-continued lines FIRST. Scanning physical lines misses every
        // multi-line command, which is how the two worst defects in this repo
        // were written:
        //     gcloud compute instances delete ... 2>/dev/null \
        //         || echo "  (no VM to delete)"
        // The first physical line has no `|| echo`; the second has no command.
        // A line-by-line scanner sees neither. This guard shipped with that
        // exact bug and the mutation proof below is what caught it.
        const lines: string[] = [];
        const lineNo: number[] = [];
        for (let i = 0; i < physical.length; i++) {
            let joined = physical[i];
            const start = i;
            while (/\\\s*$/.test(joined) && i + 1 < physical.length) {
                joined = joined.replace(/\\\s*$/, ' ') + physical[++i].trim();
            }
            lines.push(joined);
            lineNo.push(start + 1);
        }
        lines.forEach((raw, i) => {
            const line = raw.trim();
            if (line.startsWith('#')) return;
            // Walk back over the contiguous comment block, not just one line —
            // a real exemption usually needs a sentence or three to justify
            // itself, and a marker that only works on a one-liner encourages
            // the reason to be too short to be a reason.
            if (ALLOW.test(raw)) return;
            for (let j = i - 1; j >= 0 && lines[j].trim().startsWith('#'); j--) {
                if (ALLOW.test(lines[j])) return;
            }
            if (!heads(line).some((h) => FALLIBLE.test(h) || VAR_COMMAND.test(h))) return;

            // `cmd && echo "..."` — the echo is the whole assertion
            if (/&&\s*echo\b/.test(line) && !/\|\|/.test(line)) {
                found.push({ file, line: lineNo[i], shape: 'cmd && echo', text: line });
                return;
            }
            // `... || echo ...` / `|| true` / `|| :` as the terminal handler
            if (/\|\|\s*(echo\b|true\b|:\s*$)/.test(line)) {
                found.push({ file, line: lineNo[i], shape: '|| echo / || true', text: line });
                return;
            }
            // Failure sent to /dev/null on a command whose result is then
            // interpreted — UNLESS the failure is actually handled. Two
            // legitimate forms, both present in deploy/check-drift.sh, which
            // is the best-written script in the tree on this axis:
            //     VAR="$(cmd 2>/dev/null)" || { err ...; exit 2; }
            //     if [ -z "$VAR" ]; then err ...; exit 2; fi
            // Suppressing a command's NOISE is fine. Suppressing the only
            // evidence that it failed is not. The difference is whether
            // anything downstream can still tell.
            const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
            const handledInline = /\|\|\s*[{(]|\|\|\s*exit\b|\|\|\s*return\b/.test(line);
            const handledNearby =
                assigned !== undefined &&
                lines
                    .slice(i + 1, i + 11)
                    .some((l) => new RegExp(`\\[\\s+-[zn]\\s+"?\\$\\{?${assigned}\\b`).test(l));
            if (
                /2>\s*\/dev\/null/.test(line) &&
                /\$\(/.test(line) &&
                !handledInline &&
                !handledNearby
            ) {
                found.push({ file, line: lineNo[i], shape: '2>/dev/null on an interpreted result', text: line });
            }
        });
    }
    return found;
}

describe('shell checks that cannot fail', () => {
    const files = shellFiles();

    it('the scan actually found scripts to read', () => {
        // Without this, a directory rename empties the selection and every
        // assertion below passes over nothing. An empty selection is a PASS.
        expect(files.length).toBeGreaterThan(3);
        expect(files).toEqual(expect.arrayContaining(['.github/scripts/ci-failure-issue.sh']));
    });

    it('...and the detector fires on all three shapes — a control on the emptiness below', () => {
        // The live assertion asserts an EMPTY result. That is satisfied by a
        // detector that can never match, so prove it matches on input of the
        // same shape the real scripts have.
        const cases: Array<[string, string]> = [
            ['psql \'SELECT count(*) FROM "Tenant"\' >/dev/null && echo "  ok"', 'cmd && echo'],
            ['X="$(gh api foo --jq .bar 2>/dev/null || echo 0)"', '|| echo / || true'],
            ['gcloud compute disks delete "$D" 2>/dev/null || echo "(nothing)"', '|| echo / || true'],
            ['N="$(curl -s "$U" 2>/dev/null)"', '2>/dev/null on an interpreted result'],
            // invoked through a variable — how both of this repo's worst
            // instances were actually written
            ['${GC} compute instances delete "$V" 2>/dev/null || echo "(none)"', '|| echo / || true'],
            ['S="$("$GH" api foo --jq .bar 2>/dev/null || echo 0)"', '|| echo / || true'],
        ];
        for (const [line, shape] of cases) {
            const hits = scan(['fixture.sh'], () => line);
            expect({ line, shapes: hits.map((h) => h.shape) }).toEqual({ line, shapes: [shape] });
        }
        // ...and it sees a command split over a line continuation, which is
        // how the two worst instances in this repo were actually written
        const continued = 'gcloud compute instances delete "$V" 2>/dev/null \\\n    || echo "  (no VM to delete)"';
        expect(scan(['fixture.sh'], () => continued).map((h) => h.shape)).toEqual(['|| echo / || true']);

        // ...and it does NOT fire on the shapes that are fine
        const fine = [
            'usermod -aG docker iveaghlow || true',
            'echo "plain output"',
            '# psql foo && echo bar',
            // noise suppressed, failure handled inline
            'V="$(gcloud compute ssh x --command y 2>/dev/null)" || { err "no"; exit 2; }',
            // noise suppressed, emptiness checked downstream
            'V="$(curl -s "$U" 2>/dev/null)"\nif [ -z "$V" ]; then exit 2; fi',
        ];
        for (const ok of fine) {
            expect({ ok, hits: scan(['fixture.sh'], () => ok) }).toEqual({ ok, hits: [] });
        }
    });

    it('...and it fires when a REAL script is corrupted, not just a fixture', () => {
        // Controls that only ever see hand-made input prove nothing about the
        // path that executes. Corrupt the real file and require a hit.
        const real = fs.readFileSync(path.join(ROOT, 'infra/scripts/restore-test-gcp.sh'), 'utf-8');
        const corrupted = real.replace(
            /^TENANTS=.*$/m,
            'psql \'SELECT count(*) FROM "Tenant"\' >/dev/null && echo "  ✓ Tenant table reachable"',
        );
        expect(corrupted).not.toEqual(real); // the mutation actually applied
        expect(scan(['x.sh'], () => corrupted).length).toBeGreaterThan(0);
    });

    it('no shell check in this repo is written so it cannot fail', () => {
        const offences = scan(files);
        expect(
            offences.map((o) => `${o.file}:${o.line}  [${o.shape}]  ${o.text.slice(0, 90)}`),
        ).toEqual([]);
    });
});
