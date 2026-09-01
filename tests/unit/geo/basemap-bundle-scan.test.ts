/**
 * Unit tests — the basemap branch scanner (#781).
 *
 * Every fixture string below is TRANSCRIBED from real bundle bytes measured on
 * the running `agrent` container, not invented. That matters most for the
 * bystander: the zod schema site sits ~200 bytes from the value site in the
 * SAME file, and a scanner that matches it reports `maptiler` for a keyless
 * build. It is the direct analogue of the CSP-nonce `getLayerAssets` bystander
 * CLAUDE.md describes, and it is the reason this scanner allowlists value
 * shapes instead of blocklisting known bystanders.
 *
 * The key value is redacted throughout — a placeholder of the right SHAPE
 * (20 chars) rather than the real one, which must never enter the repo.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanChunkDir } from '@/lib/geo/basemap-bundle-scan';

/** The env object as emitted when the key IS supplied at build time. */
const ENV_OBJECT_WITH_KEY =
    'NEXT_PUBLIC_VAPID_PUBLIC_KEY:nf.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,' +
    'NEXT_PUBLIC_MAPTILER_KEY:"abcdefghij0123456789",' +
    'NEXT_PUBLIC_MAP_BASEMAP_STYLE:"hybrid",';

/** …as emitted when the ARG default `""` reaches the build. */
const ENV_OBJECT_EMPTY_KEY =
    'NEXT_PUBLIC_VAPID_PUBLIC_KEY:nf.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,' +
    'NEXT_PUBLIC_MAPTILER_KEY:"",' +
    'NEXT_PUBLIC_MAP_BASEMAP_STYLE:"hybrid",';

/** …as emitted when the var is absent from the build env entirely. */
const ENV_OBJECT_NOT_INLINED =
    'NEXT_PUBLIC_VAPID_PUBLIC_KEY:nf.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,' +
    'NEXT_PUBLIC_MAPTILER_KEY:nf.env.NEXT_PUBLIC_MAPTILER_KEY,';

/**
 * The BYSTANDER — the zod schema site, measured in two different minified
 * spellings in two different chunks of the same build.
 */
const BYSTANDER_A = 'NEXT_PUBLIC_MAPTILER_KEY:n.string().optional()';
const BYSTANDER_B = 'NEXT_PUBLIC_MAPTILER_KEY:rw().optional()';

/** The resolver's two branch URLs — the positive controls. */
const BRANCH_LITERALS =
    'https://demotiles.maplibre.org/style.json' +
    ' https://api.maptiler.com/maps/';

/** The decision site itself — identical on both branches, so it proves nothing. */
const DECISION_SITE = 'let e=j._.NEXT_PUBLIC_MAPTILER_KEY;if(!e)return';

let dir: string;

async function chunks(files: Record<string, string>) {
    const d = join(dir, `case-${Math.abs(hash(JSON.stringify(files)))}`);
    await mkdir(d, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
        await writeFile(join(d, name), body, 'utf8');
    }
    return d;
}

/** Deterministic — `Math.random` is unavailable in some runners here. */
function hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'basemap-scan-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('scanChunkDir — the three inlined shapes', () => {
    it('classifies an inlined non-empty key as maptiler', async () => {
        const d = await chunks({
            'main-a.js': ENV_OBJECT_WITH_KEY + BYSTANDER_A + DECISION_SITE,
            'chunk-b.js': BRANCH_LITERALS,
        });
        const r = await scanChunkDir(d);
        expect(r.branch).toBe('maptiler');
        expect(r.bindingSites).toBe(1);
    });

    it('classifies an EMPTY inlined key as demotiles', async () => {
        // This is the `Dockerfile:54` ARG default reaching the build — the exact
        // state #781 says would ship silently.
        const d = await chunks({
            'main-a.js': ENV_OBJECT_EMPTY_KEY + BYSTANDER_A,
            'chunk-b.js': BRANCH_LITERALS,
        });
        expect((await scanChunkDir(d)).branch).toBe('demotiles');
    });

    it('classifies a NOT-inlined key as demotiles', async () => {
        const d = await chunks({
            'main-a.js': ENV_OBJECT_NOT_INLINED + BYSTANDER_B,
            'chunk-b.js': BRANCH_LITERALS,
        });
        expect((await scanChunkDir(d)).branch).toBe('demotiles');
    });
});

describe('the bystander must not fool it — the whole point', () => {
    it.each([
        ['zod spelling A', BYSTANDER_A],
        ['zod spelling B', BYSTANDER_B],
    ])('a chunk carrying ONLY the %s reports blind, never maptiler', async (_l, bystander) => {
        // A presence check (`grep -c NEXT_PUBLIC_MAPTILER_KEY`) returns 1 here
        // and would call it maptiler. That is the measured trap.
        const d = await chunks({
            'main-a.js': bystander + DECISION_SITE,
            'chunk-b.js': BRANCH_LITERALS,
        });
        const r = await scanChunkDir(d);
        expect(r.branch).toBe('blind');
        expect(r.blindReason).toBe('no_binding');
    });

    it('the decision site alone proves nothing — it is identical on both branches', async () => {
        const d = await chunks({ 'main-a.js': DECISION_SITE + BRANCH_LITERALS });
        expect((await scanChunkDir(d)).branch).toBe('blind');
    });
});

describe('positive controls — fails BLIND, never confidently wrong', () => {
    it('no chunk directory at all → blind:no_chunks', async () => {
        const r = await scanChunkDir(join(dir, 'does-not-exist'));
        expect(r).toMatchObject({ branch: 'blind', blindReason: 'no_chunks', bindingSites: 0 });
    });

    it('a binding but NO branch literal → blind:no_branch_literals', async () => {
        // The resolver was restructured, so "which branch" is meaningless even
        // though the env fingerprint still matches. Without this control the
        // scanner would answer confidently about a resolver that no longer
        // exists — failing open on exactly the release that broke it.
        const d = await chunks({ 'main-a.js': ENV_OBJECT_WITH_KEY });
        const r = await scanChunkDir(d);
        expect(r.branch).toBe('blind');
        expect(r.blindReason).toBe('no_branch_literals');
        expect(r.bindingSites).toBe(1);
    });

    it('reports which branch literals it saw, so a blind result is diagnosable', async () => {
        const d = await chunks({
            'main-a.js': ENV_OBJECT_WITH_KEY,
            'chunk-b.js': 'https://demotiles.maplibre.org/style.json',
        });
        const r = await scanChunkDir(d);
        expect(r.sawDemotilesLiteral).toBe(true);
        expect(r.sawMaptilerLiteral).toBe(false);
    });
});

describe('the result never carries the key', () => {
    it('serialises to a closed enum plus counts — no value, no path', async () => {
        const d = await chunks({
            'main-a.js': ENV_OBJECT_WITH_KEY,
            'chunk-b.js': BRANCH_LITERALS,
        });
        const serialised = JSON.stringify(await scanChunkDir(d));
        expect(serialised).not.toContain('abcdefghij0123456789');
        expect(serialised).not.toContain(d);
        expect(serialised).not.toContain('NEXT_PUBLIC_MAPTILER_KEY');
    });
});

describe('it finds the binding in a nested chunk tree', () => {
    it('recurses rather than naming a file — webpack chunking is not contractual', async () => {
        const d = await chunks({ 'top.js': BRANCH_LITERALS });
        const nested = join(d, 'nested', 'deeper');
        await mkdir(nested, { recursive: true });
        await writeFile(join(nested, 'main-app-x.js'), ENV_OBJECT_WITH_KEY, 'utf8');
        expect((await scanChunkDir(d)).branch).toBe('maptiler');
    });
});
