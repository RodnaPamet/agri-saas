/**
 * A script a compose service RUNS must exist in the image that runs it.
 *
 * ── the failure this prevents ──
 *
 * The runtime stage of the Dockerfile does not copy `scripts/` wholesale — it
 * copies `scripts/entrypoint.sh` by name. So adding
 * `./scripts/wait-for-migrations.sh` to the worker's compose command without a
 * matching COPY produces an image that builds cleanly, passes every test, and
 * then crash-loops the worker at deploy time with "not found".
 *
 * Nothing else catches it: the compose file is not typechecked, the Dockerfile
 * is not read by any test, and the only place the two must agree is in a
 * container nobody runs locally. Measured while writing P1.8 — the COPY was
 * genuinely missing from the first version of that change.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const COMPOSE_FILES = [
    'deploy/docker-compose.vm.yml',
    'docker-compose.prod.yml',
] as const;

/** Every `./scripts/x.sh` a compose file asks a container to execute. */
function scriptsReferenced(compose: string): string[] {
    const hits = compose.matchAll(/\.\/(scripts\/[A-Za-z0-9._-]+\.sh)/g);
    return [...new Set([...hits].map((m) => m[1]))];
}

/** Every `scripts/x.sh` the Dockerfile's runtime stage copies in. */
function scriptsCopied(dockerfile: string): string[] {
    const hits = dockerfile.matchAll(/COPY[^\n]*?\/app\/(scripts\/[A-Za-z0-9._-]+\.sh)/g);
    return [...new Set([...hits].map((m) => m[1]))];
}

const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
const copied = scriptsCopied(dockerfile);

describe('every script a compose service runs ships in the image', () => {
    it('reports the population, so a zero would be visible', () => {
        // Both sides non-empty: an extractor that found nothing would make the
        // comparison below pass over two empty sets.
        expect(copied.length).toBeGreaterThan(0);
        const referenced = COMPOSE_FILES.flatMap((f) =>
            scriptsReferenced(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')),
        );
        expect(referenced.length).toBeGreaterThan(0);
    });

    it.each(COMPOSE_FILES)('%s references only scripts the image contains', (rel) => {
        const compose = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        const missing = scriptsReferenced(compose).filter((s) => !copied.includes(s));
        if (missing.length > 0) {
            throw new Error(
                `${rel} runs ${missing.length} script(s) the Dockerfile's runtime ` +
                    `stage does not COPY:\n  ` +
                    missing.join('\n  ') +
                    `\n\nThat image builds and tests clean, then crash-loops the ` +
                    `container at deploy time. Add a COPY line beside ` +
                    `scripts/entrypoint.sh (this stage does not copy scripts/ wholesale).`,
            );
        }
    });

    it('every copied script is EXECUTABLE in the image', () => {
        // A copied-but-unchmodded script fails the same way, one step later.
        const chmod = dockerfile.match(/RUN chmod \+x([^&\n]*)/)?.[1] ?? '';
        const notChmodded = copied.filter((s) => !chmod.includes(s));
        expect(notChmodded).toEqual([]);
    });

    it('the referenced scripts exist in the repo at all', () => {
        for (const rel of COMPOSE_FILES) {
            const compose = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            for (const s of scriptsReferenced(compose)) {
                expect(fs.existsSync(path.join(REPO_ROOT, s))).toBe(true);
            }
        }
    });
});

describe('the extractors have teeth', () => {
    it('a compose command is seen, and a bare mention in a comment is not a COPY', () => {
        expect(scriptsReferenced('command: ["./scripts/x.sh && node y"]')).toEqual(['scripts/x.sh']);
        // The COPY side must require the /app/ prefix the builder stage uses,
        // so prose naming a script does not count as shipping it.
        expect(scriptsCopied('# we should copy scripts/x.sh one day')).toEqual([]);
        expect(scriptsCopied('COPY --from=builder /app/scripts/x.sh ./scripts/x.sh')).toEqual([
            'scripts/x.sh',
        ]);
    });
});
