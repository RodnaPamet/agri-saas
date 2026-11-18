/**
 * #3217 — a file extension makes an ASSET public at the Edge, never an API path.
 *
 * `STATIC_EXTENSIONS` was tested against every pathname, so any `/api/**` route
 * whose last segment ended in `.json`, `.png`, `.js`… skipped Edge
 * authentication and the Edge-only gates (operator lockdown, MFA, terms).
 */
import { isPublicPath } from '@/lib/auth/guard';

describe('isPublicPath and file extensions (#3217)', () => {
    it.each([
        '/api/t/farm/journal/export.json',
        '/api/t/farm/locations/l1/photo.png',
        '/api/account/profile.json',
        '/api/evidence/e1.js',
    ])('does NOT make %s public', (path) => {
        expect(isPublicPath(path)).toBe(false);
    });

    it.each(['/logo.png', '/icons/icon-192.png', '/fonts/onest.woff2', '/manifest.webmanifest', '/logo.png?v=2'])(
        'control: still makes the asset %s public',
        (path) => {
            expect(isPublicPath(path)).toBe(true);
        },
    );
});
