/**
 * #3189 — no third-party image in the production compose file floats.
 *
 * `deploy/docker-compose.vm.yml` ran `containrrr/watchtower:latest` (which
 * holds the Docker socket and deploys production unattended) and
 * `edoburu/pgbouncer:latest` (on the path of every database query). A
 * floating tag is a change to production that never appears in a diff: the
 * next recreate pulls whatever the tag points at. Both are pinned by digest
 * now; this keeps a third-party `:latest` (or a bare, tagless reference, which
 * Docker reads as `:latest`) from coming back.
 *
 * ## What is exempt, and why
 *
 * - Our OWN image, `ghcr.io/rodnapamet/agri-saas:latest`, floats on purpose:
 *   that tag is how Watchtower deploys a merged main. Its supply chain is
 *   gated in `ghcr-publish.yml`, not here.
 * - `*:local` images are built on the VM from a build context in this repo.
 *
 * A version tag (`redis:7-alpine`, `caddy:2-alpine`) is allowed: it is a
 * deliberate, readable choice even though it still moves within its line.
 * The rule this guard holds is narrower — never `latest`, never untagged.
 */
import * as fs from 'fs';
import * as path from 'path';

const COMPOSE = path.join(__dirname, '../../deploy/docker-compose.vm.yml');

const OWN_IMAGE = /^ghcr\.io\/rodnapamet\/agri-saas[:@]/;
const LOCAL_IMAGE = /:local$/;

/** Every `image:` value in a compose source, comments stripped. */
function images(src: string): string[] {
    const out: string[] = [];
    for (const line of src.split('\n')) {
        const m = /^\s*image:\s*["']?([^"'\s#]+)["']?/.exec(line);
        if (m) out.push(m[1]);
    }
    return out;
}

/** A reference that floats: tagged `latest`, or carrying neither tag nor digest. */
function floats(ref: string): boolean {
    if (ref.includes('@sha256:')) return false;
    const lastSegment = ref.slice(ref.lastIndexOf('/') + 1);
    const tag = lastSegment.includes(':') ? lastSegment.slice(lastSegment.indexOf(':') + 1) : null;
    return tag === null || tag === 'latest';
}

function offenders(src: string): string[] {
    return images(src).filter((ref) => !OWN_IMAGE.test(ref) && !LOCAL_IMAGE.test(ref) && floats(ref));
}

describe('production compose: third-party images do not float (#3189)', () => {
    const src = fs.readFileSync(COMPOSE, 'utf8');
    const all = images(src);

    it('reports its population', () => {
        const thirdParty = all.filter((r) => !OWN_IMAGE.test(r) && !LOCAL_IMAGE.test(r));
        console.log(`[vm-compose-images] ${all.length} image(s), ${thirdParty.length} third-party`);
        // Floor, so a selector that stopped matching fails rather than passing
        // over nothing. The file held 9 images, 5 third-party, at #3189.
        expect(all.length).toBeGreaterThanOrEqual(8);
        expect(thirdParty.length).toBeGreaterThanOrEqual(4);
    });

    it('pins watchtower and pgbouncer by digest', () => {
        expect(all.some((r) => /^containrrr\/watchtower@sha256:[0-9a-f]{64}$/.test(r))).toBe(true);
        expect(all.some((r) => /^edoburu\/pgbouncer@sha256:[0-9a-f]{64}$/.test(r))).toBe(true);
    });

    it('has no third-party image on :latest or untagged', () => {
        expect(offenders(src)).toEqual([]);
    });

    describe('the detector (positive controls)', () => {
        it('flags :latest and an untagged reference', () => {
            expect(offenders('    image: containrrr/watchtower:latest')).toHaveLength(1);
            expect(offenders('    image: edoburu/pgbouncer')).toHaveLength(1);
            expect(offenders('    image: "redis:latest"')).toHaveLength(1);
        });

        it('accepts a digest and a version tag, including a registry with a port', () => {
            expect(offenders(`    image: edoburu/pgbouncer@sha256:${'a'.repeat(64)}`)).toEqual([]);
            expect(offenders('    image: redis:7-alpine')).toEqual([]);
            expect(offenders('    image: registry.example:5000/team/img:1.2')).toEqual([]);
        });

        it('exempts our own Watchtower-deployed image and locally built images', () => {
            expect(offenders('    image: ghcr.io/rodnapamet/agri-saas:latest')).toEqual([]);
            expect(offenders('    image: agrent-db:local')).toEqual([]);
        });

        it('ignores an image named only in a comment', () => {
            expect(offenders('    # image: containrrr/watchtower:latest')).toEqual([]);
        });
    });
});
