/**
 * Roadmap-2 PR-4 — list-page editorial descriptions.
 *
 * Every list page in the product introduces itself in one editorial
 * sentence — not a count chip alone. The user lands on `/risks` and
 * reads, at the top, what the register is FOR. Premium products
 * frame; this PR adds the framing.
 *
 * What this ratchet locks in
 *   1. The seven canonical entity sections in `messages/en.json`
 *      each carry a `listDescription` key. Adding a new entity
 *      list page MUST extend the curated list below in the same
 *      diff.
 *   2. The seven adopting client files render the description
 *      slot — either via `description:` on `<EntityListPage>`'s
 *      header, or via a `<Caption>` rendered after the
 *      `<Heading>`. The ratchet checks for one of those two
 *      shapes; the page's exact composition stays open.
 *
 * Tone — every description is one declarative sentence ≤ 80
 * characters, capability-led ("Track and treat enterprise risk"
 * not "This is the risks page"). The ratchet does not police
 * the words — copy review owns that — but it asserts the slot
 * is filled.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const ENTITIES = [
    'assets',
    'controls',
    'evidence',
    'policies',
    'audits',
    'findings',
] as const;

interface ClientFile {
    entity: (typeof ENTITIES)[number];
    file: string;
}

const CLIENTS: ClientFile[] = [
    { entity: 'assets', file: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx' },
    { entity: 'controls', file: 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx' },
    { entity: 'evidence', file: 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx' },
    { entity: 'policies', file: 'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx' },
    { entity: 'audits', file: 'src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx' },
    { entity: 'findings', file: 'src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx' },
];

describe('List-page editorial descriptions (Roadmap-2 PR-4)', () => {
    it('each entity section in messages/en.json carries a listDescription', () => {
        const messages = JSON.parse(read('messages/en.json'));
        const missing: string[] = [];
        for (const entity of ENTITIES) {
            const section = messages[entity];
            if (!section || typeof section.listDescription !== 'string') {
                missing.push(entity);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Missing listDescription on these messages/en.json sections: ${missing.join(', ')}.\n\nAdd a one-sentence editorial framing under each: '<entity>': { ..., listDescription: '...' }.`,
            );
        }
        expect(missing).toEqual([]);
    });

    it('each list-page client renders the description slot', () => {
        const offenders: string[] = [];
        for (const { entity, file } of CLIENTS) {
            const src = read(file);
            // Four valid shapes:
            //   (a) EntityListPage `description:` slot — used by
            //       controls + policies.
            //   (a') PageHeader `description=` JSX prop — R9-PR1
            //       migration shape. Same semantics as (a) but
            //       authored as a React prop, not an object key.
            //   (b) PR-11 Calendar-style `<p>` subtitle directly
            //       under the heading — used by every raw-Heading
            //       page after PR-11 retired the count chip.
            //   (c) Legacy `<Caption>` mount — preserved as a
            //       valid shape for pages that haven't yet
            //       migrated to (b).
            const usesEntityListPageDescription =
                /description[:=]\s*\{?(t\.listDescription|t\(['"]listDescription['"]\)|['"][^'"]+['"])/.test(
                    src,
                );
            const usesPSubtitle =
                /<p[^>]*text-content-muted[^>]*>\s*\{?\s*(t\.listDescription|t\(['"]listDescription['"]\))/.test(
                    src,
                );
            const usesCaptionMount =
                /<Caption[^>]*>\s*\{?\s*(t\.listDescription|t\(['"]listDescription['"]\))/.test(
                    src,
                );
            if (!usesEntityListPageDescription && !usesPSubtitle && !usesCaptionMount) {
                offenders.push(`${entity} (${file})`);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `These list pages do not render the editorial description slot:\n  ${offenders.join('\n  ')}\n\nAdd either: (a) <EntityListPage header={{ description: ... }}>, (b) a <p className="text-sm text-content-muted mt-1"> below the <Heading> referencing t.listDescription, OR (c) the legacy <Caption> mount.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
