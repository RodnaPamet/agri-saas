/**
 * Structural Test: Ensure no API route handler directly calls Prisma.
 * Route handlers must delegate to the application layer (usecases/repositories).
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

function getAllRouteFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...getAllRouteFiles(fullPath));
        } else if (entry.name === 'route.ts' || entry.name === 'route.js') {
            results.push(fullPath);
        }
    }
    return results;
}

describe('Structural: No direct Prisma calls in tenant-scoped API route handlers', () => {
    const apiDir = path.resolve(__dirname, '../../src/app/api/t');

    it('no route.ts files under /api/t/ contain "prisma." calls', () => {
        if (!fs.existsSync(apiDir)) {
            // Skip if directory doesn't exist yet
            return;
        }
        const routeFiles = getAllRouteFiles(apiDir);
        expect(routeFiles.length).toBeGreaterThan(0);

        const violations: string[] = [];
        // SCIM token management routes legitimately use global prisma for cross-tenant token CRUD
        const ROUTE_EXCLUDE_DIRS = ['scim'];
        for (const file of routeFiles) {
            const rel = path.relative(apiDir, file);
            if (ROUTE_EXCLUDE_DIRS.some(d => rel.includes(d))) continue;
            // Comments blanked (#1774): the matcher below looks for
            // `prisma.<something>`, and a docblock saying "never call
            // prisma.user here" reads as the call it warns against. Strings
            // are kept — blanking them is unnecessary for a code matcher and
            // would be a wider claim than this needs.
            const content = blankNonCode(fs.readFileSync(file, 'utf-8'));
            // Check for direct prisma calls (prisma.xxx)
            if (/\bprisma\.\w+/g.test(content)) {
                violations.push(rel);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `The following route files contain direct Prisma calls:\n${violations.map(v => `  - ${v}`).join('\n')}\n\n` +
                'Route handlers should delegate to the application layer (usecases/repositories).'
            );
        }
    });
});
