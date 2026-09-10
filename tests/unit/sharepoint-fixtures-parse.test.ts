/**
 * SP-F4 — parse-through test over recorded Graph fixtures.
 *
 * Drives the REAL SharePointClient parsers with documented-shape Graph responses
 * from tests/fixtures/sharepoint/. These are synthetic (no real tenant data);
 * when a redacted REAL capture replaces a fixture and the shape drifts, the
 * corresponding parser assertion fails here — that's the point.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SharePointClient, type SharePointConnectionConfig } from '@/app-layer/integrations/providers/sharepoint/client';

const FIX = path.resolve(__dirname, '../fixtures/sharepoint');
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

function clientReturning(body: unknown) {
    const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(8),
    });
    const config: SharePointConnectionConfig = {
        aadTenantId: 'tid',
        allowedSiteIds: ['site-1'],
        accessToken: 'tok',
    };
    return { client: new SharePointClient(config, fetchImpl as unknown as typeof fetch), fetchImpl };
}

describe('SP-F4 — Graph fixture parse-through', () => {
    it('sites.json → listSites parses id/displayName', async () => {
        const { client } = clientReturning(load('sites.json'));
        const sites = await client.listSites();
        expect(sites).toHaveLength(2);
        expect(sites[0].displayName).toBe('Compliance');
        expect(sites[0].id).toContain('contoso.sharepoint.com');
    });

    it('site-drives.json → listDrives parses document libraries', async () => {
        const { client } = clientReturning(load('site-drives.json'));
        const drives = await client.listDrives('site-1');
        expect(drives.map((d) => d.name)).toEqual(['Documents', 'Policies']);
        expect(drives[0].driveType).toBe('documentLibrary');
    });

    it('children.json → listChildren parses folder + file + nextLink', async () => {
        const { client } = clientReturning(load('children.json'));
        const page = await client.listChildren('b!aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
        expect(page.items).toHaveLength(2);
        expect(page.items[0].folder?.childCount).toBe(4);
        expect(page.items[1].file?.mimeType).toBe('application/pdf');
        expect(page.items[1].cTag).toBeDefined();
        expect(page.nextLink).toContain('$skiptoken=');
    });

    it('delta.json → getDelta parses changed + deleted items + new token', async () => {
        const { client } = clientReturning(load('delta.json'));
        const res = await client.getDelta('b!aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
        expect(res.items).toHaveLength(2);
        expect(res.items.find((i) => i.deleted)).toBeTruthy();
        expect(res.items.find((i) => i.cTag)).toBeTruthy();
        expect(res.deltaToken).toBe('NEWDELTATOKEN123');
    });

    it('driveitem.json → getItem parses a single file (eTag/cTag/mime)', async () => {
        const { client } = clientReturning(load('driveitem.json'));
        const item = await client.getItem('b!aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', '01FILE001BBBBBBBBBBBBBBBBBBBBBBBBB');
        expect(item.name).toBe('SOC2-evidence.pdf');
        expect(item.file?.mimeType).toBe('application/pdf');
        expect(item.eTag).toBeDefined();
        expect(item.cTag).toBeDefined();
        expect(item.parentReference?.driveId).toBeTruthy();
    });
});
