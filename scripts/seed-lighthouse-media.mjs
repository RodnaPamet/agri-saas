/**
 * Give `/f/lighthouse` real images, so the Lighthouse budget measures the page
 * the product actually serves — P6.3 (#1812).
 *
 * ## Why this script exists
 *
 * `lighthouserc.json` gates `/f/.*` on LCP (error, 2200 ms) and CLS (error,
 * 0.05). Until #1812 that page was text, and those numbers were measured on
 * text. The moment it can carry a logo and up to six photographs, the gate is
 * either measuring the real page or it is reporting on a page nobody visits —
 * and a green gate over a page with no images is indistinguishable from a
 * green gate over a fast one.
 *
 * That is the shape #2009 tracks: a surface ships, the check stays green, and
 * nothing reports the difference. So the seeding is part of the feature rather
 * than an afterthought.
 *
 * ## The images are SYNTHETIC but sized like photographs, and that is the point
 *
 * Measured on this machine at 1600x1200, JPEG q80:
 *
 *     flat colour        11 KB   <- what a naive fixture gives
 *     gradient + noise  432 KB   <- what this script makes
 *     pure noise       1190 KB   <- compresses worse than any real photo
 *
 * A flat-colour fixture would sail through any budget and prove nothing — a
 * control that cannot express failure. Pure noise is pessimistic past the
 * point of usefulness. The gradient-plus-noise mix lands at the top of the
 * range a real 1600px field photo occupies (~250-450 KB), so the gate is
 * slightly conservative, which is the right direction for a regression bound.
 *
 * ## It seeds the CEILING, not a typical farm
 *
 * Six photographs, which is `FARM_BRAND_MAX_PHOTOS`. A gate that measured two
 * would pass while the cap allowed something that fails. If this seeding makes
 * the budget fail, the finding is about the cap or about the rendering — not
 * about the fixture.
 *
 * ## Why a script and not inline SQL
 *
 * The hashes have to BE the hashes: `/api/public/media/{hash}` resolves a
 * sha256 of the stored bytes, so the row and the file cannot be written
 * independently. Generating, hashing and inserting in one pass is what keeps
 * them in step. The rest of the seeding in `lighthouse.yml` stays as psql
 * heredocs, which is right for rows that have no such coupling.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';
import sharp from 'sharp';

/**
 * Where the bytes go. `local-provider.ts` reads these two in order.
 *
 * There is NO `/tmp` fallback, deliberately. The provider's own default is
 * `/tmp/uploads`, and following it here earned a high-severity CodeQL alert —
 * `js/insecure-temporary-file`: a file created in the shared OS temp
 * directory with default permissions is readable, and replaceable, by any
 * other user on the machine.
 *
 * On an ephemeral single-tenant runner that is a small risk, but "it is only
 * CI" is a premise that goes stale quietly, and the fix is cheaper than the
 * argument: the caller passes a path inside the workspace. Refusing to guess
 * is what keeps it that way — a default would be followed, and the default
 * that suggests itself is the temp directory again.
 */
const STORAGE_ROOT = process.env.FILE_STORAGE_ROOT || process.env.UPLOAD_DIR;
if (!STORAGE_ROOT) {
    throw new Error(
        'FILE_STORAGE_ROOT (or UPLOAD_DIR) must be set, and must not be inside the OS temp '
            + 'directory — see this file for why there is no fallback.',
    );
}
const HANDLE = 'lighthouse';
const TENANT_ID = 't-lighthouse-media';
const PHOTO_COUNT = 6;

/**
 * Must match `FARM_MEDIA_THUMB_DIMENSION` in
 * `src/app-layer/usecases/farm-brand-media.ts` (#2062).
 *
 * Duplicated rather than imported, because this script is plain ESM run by
 * `node` and that module is TypeScript in the app's path-aliased graph. The
 * cost of the copy is real, so the guard
 * `tests/guards/lighthouse-seed-matches-the-pipeline.test.ts` asserts the two
 * numbers agree — a seeding that generated a different size from the product
 * would measure a page the product never serves, which is the whole failure
 * this seeding exists to prevent.
 */
const THUMB_DIMENSION = 440;

/**
 * A photograph-shaped image: smooth gradient plus fine grain.
 *
 * The gradient gives the large smooth regions a field or a sky has; the grain
 * is what stops JPEG compressing it to nothing. Deterministic per index so a
 * re-run produces the same bytes and therefore the same hash — a changing hash
 * would orphan the previous row on every run.
 */
async function photographLike(width, height, seed) {
    const raw = Buffer.alloc(width * height * 3);
    // A tiny LCG rather than Math.random: deterministic, and this file has no
    // business making a run's output depend on the run.
    let state = (seed + 1) * 1103515245;
    const next = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 3;
            const g = Math.floor(120 + 100 * Math.sin((x + seed * 37) / 220) * Math.cos(y / 180));
            const n = Math.floor((next() - 0.5) * 38);
            const clamp = (v) => Math.max(0, Math.min(255, v));
            raw[o] = clamp(g + n + 30);
            raw[o + 1] = clamp(g + n + 10);
            raw[o + 2] = clamp(g * 0.6 + n);
        }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
}

/** Store one image and return the row it needs. */
async function store(bytes, label) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // The key shape `buildTenantObjectKey` produces. Written by hand because
    // this script does not boot the app, and the public media route resolves
    // by HASH rather than by key — so the key only has to be stable and
    // inside the tenant's own prefix.
    const pathKey = `tenants/${TENANT_ID}/farm-media/2026/10/${sha256.slice(0, 16)}.jpg`;
    void label;
    const target = path.resolve(STORAGE_ROOT, pathKey);
    // 0o700 / 0o600: the directory and the file are for this process and the
    // app it seeds, not for every account on the host. Belt to the braces of
    // keeping the root out of the temp directory in the first place.
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    console.log(
        `  ${label.padEnd(8)} ${String(Math.round(bytes.length / 1024)).padStart(4)} KB  ${sha256.slice(0, 12)}…  ${pathKey}`,
    );
    return { sha256, pathKey, sizeBytes: bytes.length };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
    console.log(`[seed-lighthouse-media] storage root: ${STORAGE_ROOT}`);

    // A logo is small and mostly flat — a real one is a wordmark. 400px is
    // plenty for a 96px display box at 4x, and its modest weight is the honest
    // input: the logo is the one image loaded EAGERLY, so inflating it would
    // mismeasure the LCP this gate exists to bound.
    const logoBytes = await sharp({
        create: { width: 400, height: 400, channels: 3, background: '#2f6d4f' },
    })
        .composite([
            {
                input: Buffer.from(
                    `<svg width="400" height="400"><circle cx="200" cy="200" r="150" fill="#e8f0ea"/><text x="200" y="235" font-size="140" font-family="serif" text-anchor="middle" fill="#2f6d4f">СП</text></svg>`,
                ),
                top: 0,
                left: 0,
            },
        ])
        .jpeg({ quality: 82 })
        .toBuffer();

    const logo = await store(logoBytes, 'logo');

    // Each photograph is stored TWICE, exactly as `uploadFarmBrandMedia` does
    // it (#2062): the 1600px original the farm selected, and the
    // display-sized thumbnail the public grid renders.
    //
    // Seeding only thumbnails would be the easier thing and the wrong one.
    // The originals have to exist for the same reason they exist in
    // production: `projectFarmBrand` maps originals to thumbnails, so a
    // seeding with no originals would exercise a code path the product does
    // not have.
    const photos = [];
    for (let i = 0; i < PHOTO_COUNT; i++) {
        const originalBytes = await photographLike(1600, 1200, i);
        const original = await store(originalBytes, `photo ${i + 1}`);
        const thumbBytes = await sharp(originalBytes)
            .resize(THUMB_DIMENSION, THUMB_DIMENSION, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            .jpeg({ quality: 80 })
            .toBuffer();
        const thumb = await store(thumbBytes, `  thumb ${i + 1}`);
        photos.push({ original, thumb });
    }

    const stored = [logo, ...photos.flatMap((p) => [p.original, p.thumb])];
    const total = stored.reduce((n, f) => n + f.sizeBytes, 0);
    // What the PAGE fetches, which is the number the budget is about — the
    // originals are stored but not published, so they cost the visitor
    // nothing.
    const served = logo.sizeBytes + photos.reduce((n, p) => n + p.thumb.sizeBytes, 0);
    console.log(
        `[seed-lighthouse-media] ${stored.length} files, ${Math.round(total / 1024)} KB stored; `
            + `${Math.round(served / 1024)} KB will be SERVED to the page`,
    );

    // A tenant and a user, because `FileRecord` is tenant-scoped and carries a
    // real relation on both. The PUBLIC read needs neither — which is why the
    // existing profile seeding deliberately skips them — but the media route
    // reads `FileRecord`, so they are a precondition here rather than a
    // convenience.
    await client.query(
        `INSERT INTO "Tenant" ("id", "name", "slug", "updatedAt")
         VALUES ($1, 'Lighthouse media', 'lighthouse-media', NOW())
         ON CONFLICT ("id") DO NOTHING`,
        [TENANT_ID],
    );
    const user = await client.query(
        `INSERT INTO "User" ("id", "emailEncrypted", "emailHash", "updatedAt")
         VALUES ('u-lighthouse-media', 'lighthouse@example.test', 'lighthouse-media-hash', NOW())
         ON CONFLICT ("id") DO UPDATE SET "updatedAt" = NOW()
         RETURNING "id"`,
    );
    const userId = user.rows[0].id;

    for (const f of stored) {
        await client.query(
            `INSERT INTO "FileRecord"
               ("id", "tenantId", "pathKey", "originalName", "mimeType", "sizeBytes",
                "sha256", "status", "scanStatus", "uploadedByUserId", "storageProvider",
                "domain", "updatedAt")
             VALUES ($6, $1, $2, 'seed.jpg', 'image/jpeg', $3,
                     $4, 'STORED', 'CLEAN', $5, 'local', 'farm-media', NOW())
             ON CONFLICT DO NOTHING`,
            // The id is derived from the hash rather than from
            // `gen_random_uuid()`: that function needs pgcrypto on older
            // servers, and deriving it keeps a re-run idempotent — the same
            // bytes produce the same row instead of a second one.
            [TENANT_ID, f.pathKey, f.sizeBytes, f.sha256, userId, `f-${f.sha256.slice(0, 24)}`],
        );
    }

    // The pairing, matching what `uploadFarmBrandMedia` writes (#2062).
    // Without it `projectFarmBrand` would find no thumbnail and fall back to
    // the original — which is the correct fallback and the wrong thing to
    // measure, because the page would then serve 2601 KB again and the budget
    // would fail for a reason the product has fixed.
    for (const { original, thumb } of photos) {
        await client.query(
            `UPDATE "FileRecord" SET "derivedFromSha256" = $1 WHERE "sha256" = $2`,
            [original.sha256, thumb.sha256],
        );
    }

    // The projection is what the page reads and what the media route checks
    // for authorisation, so this UPDATE is what actually publishes the images.
    //
    // THUMBNAIL hashes, not originals — the same thing `projectFarmBrand`
    // publishes. This script writes the projection directly rather than going
    // through that function (it would need a tenant, a membership and an admin
    // context), so it has to reproduce that decision rather than inherit it.
    // The guard named above is what keeps the reproduction honest.
    const updated = await client.query(
        `UPDATE "PublicFarmProfile"
            SET "logoMediaHash" = $1, "photoMediaHashes" = $2
          WHERE "handle" = $3`,
        [logo.sha256, photos.map((p) => p.thumb.sha256), HANDLE],
    );
    if (updated.rowCount !== 1) {
        throw new Error(
            `expected to publish media on exactly one profile, updated ${updated.rowCount}. ` +
                `Seed /f/${HANDLE} before this step.`,
        );
    }
    console.log(`[seed-lighthouse-media] published on /f/${HANDLE}`);
} finally {
    await client.end();
}
