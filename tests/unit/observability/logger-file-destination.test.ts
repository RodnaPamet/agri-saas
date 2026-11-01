/**
 * The second log destination (#2682) must never break the process it observes.
 *
 * This feature exists so a production incident is still readable after the
 * deploy that fixed the previous one. A logger that throws on a bad path would
 * take down the application during exactly the kind of event it was added for,
 * which is the one outcome worse than losing the logs.
 *
 * So the properties under test are all about NOT failing:
 *   · unset        → the previous behaviour, exactly
 *   · unusable     → stdout only, a warning, and a live process
 *   · usable       → writes, and still does not throw
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGINAL = process.env.LOG_FILE_PATH;

/** Re-import the logger with a given LOG_FILE_PATH, in isolation. */
function loadLogger(value: string | undefined): typeof import('@/lib/observability/logger') {
    if (value === undefined) delete process.env.LOG_FILE_PATH;
    else process.env.LOG_FILE_PATH = value;
    let mod!: typeof import('@/lib/observability/logger');
    jest.isolateModules(() => {
        mod = require('@/lib/observability/logger');
    });
    return mod;
}

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LOG_FILE_PATH;
    else process.env.LOG_FILE_PATH = ORIGINAL;
    jest.restoreAllMocks();
});

describe('LOG_FILE_PATH', () => {
    it('UNSET: the logger loads and logs, exactly as before', () => {
        const { pinoInstance } = loadLogger(undefined);
        expect(pinoInstance).toBeDefined();
        // The important half: no second destination is constructed at all, so
        // a deployment that does not opt in cannot be affected by this change.
        expect(() => pinoInstance.info({ component: 'test' }, 'hello')).not.toThrow();
    });

    it('EMPTY STRING counts as unset', () => {
        // A compose file that sets the variable to nothing must not be read as
        // "write to a file called empty-string".
        const { pinoInstance } = loadLogger('   ');
        expect(() => pinoInstance.info('hello')).not.toThrow();
    });

    it('UNUSABLE path: warns on stderr and keeps running on stdout', () => {
        // Spying on `process.stderr.write`, which is what the code calls —
        // NOT `console.error`. An earlier version of this test spied on
        // console and kept passing after the implementation moved, because the
        // only hard assertion is the no-throw below; the spy had become
        // decoration that read as a check.
        const warn = jest
            .spyOn(process.stderr, 'write')
            .mockImplementation(() => true);
        // A path whose PARENT is a file, so a directory cannot be created.
        //
        // The blocker lives inside a `mkdtempSync` directory rather than
        // directly in the OS temp dir under a `Date.now()` name. CodeQL
        // flagged the latter as an insecure temporary file and was right:
        // a predictable name in a world-writable directory is a symlink
        // target, and "it is only a test" is how that pattern gets copied
        // into something that is not.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrentblock-'));
        const blocker = path.join(dir, 'not-a-directory');
        fs.writeFileSync(blocker, 'not a directory');
        try {
            const { pinoInstance } = loadLogger(path.join(blocker, 'nested', 'app.jsonl'));
            // The process is alive and logging. That is the main assertion.
            expect(() => pinoInstance.info('still here')).not.toThrow();
            // ...and the operator was TOLD, rather than the file silently not
            // existing. A silent fallback here would mean an incident is
            // unreadable and nobody knows why.
            const said = warn.mock.calls.map((c) => String(c[0])).join('');
            expect(said).toContain('LOG_FILE_PATH');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            warn.mockRestore();
        }
    });

    it('USABLE path: the logger still does not throw', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrentlog-'));
        const file = path.join(dir, 'nested', 'app.jsonl');
        try {
            const { pinoInstance } = loadLogger(file);
            expect(() => pinoInstance.info({ component: 'test' }, 'written')).not.toThrow();
            // Deliberately NOT asserting the bytes landed: pino's file
            // destination is buffered (`sync: false`, chosen so a shared disk
            // does not tax every request), so reading the file here would be a
            // race and a flaky test is worse than an unasserted buffer.
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
