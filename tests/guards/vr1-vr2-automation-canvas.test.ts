/**
 * VR-1 + VR-2 — Visual Rule Editor foundation ratchet.
 *
 * Locks the additive foundation: the 4 automation node kinds, the
 * mode-gated palette, the ProcessCanvasMode schema + CanvasModeContext,
 * and canvasMode threading through the process-map create/list path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The WHOLE schema folder, concatenated.
 *
 * These assertions are about what the schema DECLARES, not about which file
 * happens to hold it -- and models do move between files: the GRC teardown
 * relocated the Task, Asset, Evidence and process-map families out of the
 * compliance-owned files in a single commit that changed no column at all.
 * Reading one file by name made this guard fail on that pure move, which is
 * a guard reporting on filing rather than on the property it exists to hold.
 */
const readSchema = (): string =>
    fs
        .readdirSync(path.join(ROOT, 'prisma/schema'))
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(ROOT, 'prisma/schema', f), 'utf8'))
        .join('\n');

const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-1/VR-2 — automation canvas foundation', () => {
    it('taxonomy declares the 4 automation kinds + a separate order', () => {
        const src = read('src/components/processes/node-taxonomy.ts');
        for (const k of ['trigger', 'condition', 'action', 'slaGate']) {
            expect(src).toMatch(new RegExp(`'${k}'`));
        }
        expect(src).toMatch(/AUTOMATION_NODE_ORDER/);
        expect(src).toMatch(/isAutomationNodeKind/);
    });

    it('the palette gates the automation section on canvas mode', () => {
        const src = read('src/components/processes/ProcessPalette.tsx');
        expect(src).toMatch(/useIsAutomationMode/);
        expect(src).toMatch(/isAutomation &&/);
        expect(src).toMatch(/AUTOMATION_NODE_ORDER/);
    });

    it('the canvas-mode context exists', () => {
        expect(exists('src/lib/processes/canvas-mode-context.tsx')).toBe(true);
        const src = read('src/lib/processes/canvas-mode-context.tsx');
        expect(src).toMatch(/CanvasModeProvider/);
        expect(src).toMatch(/useIsAutomationMode/);
    });

    it('schema carries ProcessCanvasMode + ProcessMap.canvasMode', () => {
        expect(readSchema()).toMatch(/enum ProcessCanvasMode/);
        expect(readSchema()).toMatch(
            /canvasMode\s+ProcessCanvasMode/,
        );
    });

    it('canvasMode threads through create + list', () => {
        expect(read('src/app-layer/schemas/process-map.ts')).toMatch(/canvasMode/);
        expect(read('src/app-layer/repositories/ProcessMapRepository.ts')).toMatch(
            /canvasMode/,
        );
        // ProcessesClient provides the mode to the canvas
        expect(read('src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx')).toMatch(
            /CanvasModeProvider/,
        );
    });
});
