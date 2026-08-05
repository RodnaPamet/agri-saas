/**
 * CI Guardrails for file security:
 * 1. No code writes uploads into /public
 * 2. No API returns absolute filesystem paths
 * 3. Download endpoints accept fileId/evidenceId (not pathKey)
 * 4. FILE_STORAGE_ROOT is validated
 */
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve('src');

function readFilesRecursive(dir: string): { path: string; content: string }[] {
    const results: { path: string; content: string }[] = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            if (item.name === 'node_modules' || item.name === '.next') continue;
            results.push(...readFilesRecursive(fullPath));
        } else if (/\.(ts|tsx|js|jsx)$/.test(item.name)) {
            results.push({ path: fullPath, content: fs.readFileSync(fullPath, 'utf-8') });
        }
    }
    return results;
}

describe('File Security Guardrails', () => {
    const allFiles = readFilesRecursive(SRC_ROOT);

    test('no upload code writes into /public directory', () => {
        const violations: string[] = [];
        for (const file of allFiles) {
            // Match patterns like writeFile('public/...' or path.join('public', ...)
            if (/(?:writeFile|createWriteStream|mkdir)\s*\([^)]*['"]public\//i.test(file.content)) {
                violations.push(file.path);
            }
            if (/path\.join\s*\([^)]*['"]public['"][^)]*upload/i.test(file.content)) {
                violations.push(file.path);
            }
        }
        expect(violations).toEqual([]);
    });

    test('no API route returns absolute filesystem paths in responses', () => {
        const apiRoutes = allFiles.filter(f => f.path.includes(`api${path.sep}`) && f.path.endsWith('route.ts'));
        const violations: string[] = [];
        for (const file of apiRoutes) {
            // Check for pathKey, finalPath, absPath, or filePath being returned in JSON responses
            if (/NextResponse\.json\([^)]*(?:finalPath|absPath|filePath|pathKey)/i.test(file.content)) {
                // Exception: pathKey is OK in internal form (it's relative), but finalPath/absPath are not
                if (/NextResponse\.json\([^)]*(?:finalPath|absPath|filePath)/i.test(file.content)) {
                    violations.push(file.path);
                }
            }
            // Check for fs.resolve appearing in response bodies
            if (/NextResponse\.json\([^)]*path\.resolve/i.test(file.content)) {
                violations.push(file.path);
            }
        }
        expect(violations).toEqual([]);
    });

    test('every storage read uses a RESOLVED record key, never a caller string', () => {
        // THE GUARD THAT DID NOT FIRE.
        //
        // The previous version filtered to files whose path contained
        // "download" and then grepped for `params.pathKey`. Neither of the two
        // routes that actually had this bug qualified: /files/[fileName] and
        // /files/[fileName]/verify have no "download" in their path, and both
        // name the param `fileName`. So it passed, permanently, over a
        // cross-tenant byte read and a cross-tenant hash oracle.
        //
        // It now checks the property that matters rather than a spelling:
        // the argument to a storage read must be a RESOLVED record's key
        // (`something.pathKey`), not a bare identifier that could be a
        // caller-supplied string. "Check one value, read another" is the
        // shape of both original bugs.
        const READ_CALL = /\b(?:storage|provider)\s*\.\s*(readStream|createSignedDownloadUrl|delete)\s*\(\s*([^,)]+)/g;

        // A storage key is CALLER-SUPPLIED when it comes straight off the
        // request — a route param, a query string, or a bare identifier with a
        // request-shaped name. Those must never reach a read. Everything else
        // is a resolved record's field (`fileRecord.pathKey`,
        // `existing.storageKey`, `payload.stagingPathKey`) or a key this code
        // built itself with buildTenantObjectKey.
        const CALLER_SUPPLIED =
            /^(?:params|req|request|searchParams)\b|^(?:fileName|filename|name|path|objectKey)$/;

        const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
            {
                file: 'src/lib/storage/local-provider.ts',
                reason: 'The provider itself — it receives the key its callers resolved.',
            },
            {
                file: 'src/lib/storage/s3-provider.ts',
                reason: 'Same: provider implementation, not a call site.',
            },
        ];

        const violations: string[] = [];
        let callsInspected = 0;

        for (const file of allFiles) {
            if (ALLOWLIST.some((a) => file.path.endsWith(a.file))) continue;
            for (const m of file.content.matchAll(READ_CALL)) {
                callsInspected += 1;
                const arg = m[2].trim();
                if (CALLER_SUPPLIED.test(arg)) {
                    violations.push(`${file.path}: storage.${m[1]}(${arg}) — caller-supplied key reaches storage`);
                }
            }
        }

        // Detector self-check: a guard that matches nothing passes forever.
        // If the storage API is renamed, this fails loudly instead of going
        // quietly green — which is exactly how the old version survived.
        expect(callsInspected).toBeGreaterThan(0);
        expect(violations).toEqual([]);
    });

    test('the read-guard detector actually catches the original bug', () => {
        // Mutation proof, against the real pre-fix source shape.
        const READ_CALL = /\b(?:storage|provider)\s*\.\s*(readStream|createSignedDownloadUrl|delete)\s*\(\s*([^,)]+)/g;
        const CALLER_SUPPLIED =
            /^(?:params|req|request|searchParams)\b|^(?:fileName|filename|name|path|objectKey)$/;

        // The exact pre-fix line from file.ts, and the exact post-fix one.
        const vulnerable = `const stream = storage.readStream(fileName);`;
        const fixed = `const stream = storage.readStream(fileRecord.pathKey);`;
        // A legitimate site that must NOT be flagged.
        const legitimate = `await storage.delete(payload.stagingPathKey);`;

        const check = (src: string) =>
            [...src.matchAll(READ_CALL)].filter((m) => CALLER_SUPPLIED.test(m[2].trim())).length;

        expect(check(vulnerable)).toBe(1);
        expect(check(fixed)).toBe(0);
        expect(check(legitimate)).toBe(0);
    });

    test('FILE_STORAGE_ROOT is validated via env.ts', () => {
        const envFile = allFiles.find(f => f.path.endsWith('env.ts'));
        expect(envFile).toBeDefined();
        // Should reference FILE_STORAGE_ROOT or UPLOAD_DIR
        expect(envFile!.content).toMatch(/UPLOAD_DIR|FILE_STORAGE_ROOT/);
    });

    test('storage driver does not use raw process.env in src/', () => {
        const storageFile = allFiles.find(f => f.path.endsWith('storage.ts'));
        expect(storageFile).toBeDefined();
        // Should NOT contain process.env for storage config (should use @/env)
        const lines = storageFile!.content.split('\n');
        const violations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('process.env.FILE_') || lines[i].includes('process.env.UPLOAD_DIR')) {
                violations.push(`Line ${i + 1}: ${lines[i].trim()}`);
            }
        }
        expect(violations).toEqual([]);
    });

    test('file uploads go through mulitpart endpoints, not direct DB writes', () => {
        // Verify that Evidence create with type=FILE goes through uploadEvidenceFile
        // No route should create FILE evidence via plain JSON POST
        const evidenceRoutes = allFiles.filter(
            f => f.path.includes(`evidence${path.sep}`) && f.path.endsWith('route.ts') && !f.path.includes('uploads'),
        );
        const violations: string[] = [];
        for (const file of evidenceRoutes) {
            // Check if any route creates evidence of type FILE without going through upload
            if (/type.*['"]FILE['"].*createEvidence/i.test(file.content)) {
                violations.push(`${file.path}: creates FILE evidence without upload flow`);
            }
        }
        expect(violations).toEqual([]);
    });
});
