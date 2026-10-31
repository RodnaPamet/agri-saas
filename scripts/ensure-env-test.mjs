#!/usr/bin/env node
/**
 * Create `.env.test` from `.env.test.example` when it is missing (#2531).
 *
 * `.env.test.example` has been checked in for months, carrying the correct
 * `localhost:5435` test-database URLs, and `.env.test` is gitignored — so the
 * intended workflow was a copy, and NOTHING performed it. The consequence is
 * not a missing convenience: `tests/integration/db-helper.ts` resolves its URL
 * through a chain, and with no `.env.test` a run falls past it to
 * `$DATABASE_URL` and, until #2531, on to `.env` — a DEVELOPMENT database.
 *
 * Measured across two checkouts of this repo: one had `.env.test` from
 * 2026-10-01 by historical accident and never saw the problem; the other did
 * not and produced 51 failing suites with 440 `P1001` errors against
 * pgbouncer on 5436, every one of which passed when run alone. The difference
 * between the two machines was this one untracked file.
 *
 * It does NOT overwrite an existing `.env.test`. A developer who has edited
 * theirs — a different port, a different database name — keeps it, and this
 * is a no-op on every run after the first. Overwriting would be the louder
 * failure: it would silently repoint a working setup.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(ROOT, '.env.test');
const example = join(ROOT, '.env.test.example');

if (existsSync(target)) {
    console.log('[ensure-env-test] .env.test already exists — left untouched');
    process.exit(0);
}

if (!existsSync(example)) {
    // Refuse rather than invent one. A hard-coded URL here would be a third
    // copy of the test-database address, and the one nobody updates.
    console.error(
        '[ensure-env-test] .env.test is missing and .env.test.example is not there to copy.\n'
        + 'That example is the source of truth for the test database URL — without it\n'
        + 'there is nothing to create, and guessing a URL is how a test run ends up\n'
        + 'pointed at the wrong database (#2531).',
    );
    process.exit(1);
}

copyFileSync(example, target);
console.log('[ensure-env-test] wrote .env.test from .env.test.example');
console.log('[ensure-env-test] edit it if your test database is not on localhost:5435');
