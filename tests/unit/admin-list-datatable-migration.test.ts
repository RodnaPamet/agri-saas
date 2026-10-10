/**
 * Epic 48 — admin list pages must use the shared DataTable
 * architecture (members + roles).
 *
 * The api-keys page already uses DataTable; this ratchet locks
 * the same migration in place for members + roles. A future
 * "simplify" PR could quietly revert either page back to
 * `<table className="data-table">` (the legacy hand-rolled
 * markup) and the regression would be silent — pages still
 * render rows, just outside the shared primitive.
 *
 * Also locks every stable id used by E2E + analytics so the
 * migration can't accidentally drop them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MEMBERS = path.join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx');
const ROLES = path.join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx');
const API_KEYS = path.join(REPO_ROOT, 'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx');
const SHELL_GUARD = path.join(REPO_ROOT, 'tests/guards/list-page-shell-coverage.test.ts');

function read(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

// ─── Members page ─────────────────────────────────────────────────────

describe('admin/members — DataTable migration', () => {
    const src = read(MEMBERS);

    it('imports DataTable + createColumns from the shared primitive', () => {
        expect(src).toMatch(/from\s*['"]@\/components\/ui\/table['"]/);
        expect(src).toMatch(/\bDataTable\b/);
        expect(src).toMatch(/createColumns\b/);
    });

    it('mounts a <DataTable> for the members list (replaces the hand-rolled table)', () => {
        // Two DataTables expected (members + invites). Match the
        // JSX-element form (newline / attribute after) so doc-
        // comment mentions don't inflate the count.
        const matches = src.match(/<DataTable\s/g) ?? [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT carry the legacy hand-rolled `<table className="data-table"`', () => {
        // The legacy block was the canonical signal of an
        // un-migrated admin list page. Strip block comments
        // first — the migration doc comment intentionally
        // mentions the legacy form for context.
        const stripped = blankNonCode(src);
        expect(stripped).not.toMatch(/<table\s+className="data-table"/);
    });

    it('preserves every stable id E2E + analytics rely on', () => {
        const ids = [
            // page chrome
            'invite-member-btn',
            'members-error',
            'members-success',
            // invite form
            'invite-form',
            'invite-email-input',
            'invite-role-select',
            'send-invite-btn',
            // table cards. The `member-search` input id was
            // retired by the FilterToolbar text-search kill sweep
            // (the sidebar palette + global search now own
            // textual search on every list page).
            'members-table-card',
            'invites-table-card',
            // sessions modal list
            'sessions-list',
        ];
        for (const id of ids) {
            expect(src).toMatch(new RegExp(`id="${id}"`));
        }
    });

    it('preserves the per-row stable id templates (role badge, sessions count, action menu, deactivate)', () => {
        // Source format: id={`role-badge-${m.id}`}. Match the
        // template-literal start ` ${prefix}${ ` inside an `id={…}`
        // JSX attribute. The `[\\s\\S]*?` allows any whitespace
        // between `id={` and the backtick (Prettier sometimes
        // breaks the line).
        const templates = [
            'role-badge-',
            'role-select-',
            'role-save-',
            'custom-role-select-',
            'sessions-count-',
            'member-menu-',
            'action-change-role-',
            'action-view-sessions-',
            'action-deactivate-',
            'revoke-session-',
        ];
        for (const t of templates) {
            // `id={`<template>${`  →  literal: id={`role-badge-${
            // Regex-escape `${` as `\$\{`.
            expect(src).toMatch(new RegExp(`id=\\{\`${t}\\$\\{`));
        }
    });

    it('exposes data-testid="members-table" + "invites-table" for E2E', () => {
        expect(src).toMatch(/data-testid="members-table"/);
        expect(src).toMatch(/data-testid="invites-table"/);
    });

    it('keeps page in the ListPageShell-coverage exemption (multi-table layout)', () => {
        const guard = read(SHELL_GUARD);
        expect(guard).toMatch(/'admin\/members\/page\.tsx'/);
    });
});

// ─── Roles page ───────────────────────────────────────────────────────

describe('admin/roles — DataTable migration', () => {
    const src = read(ROLES);

    it('imports DataTable + createColumns + ListPageShell', () => {
        expect(src).toMatch(/from\s*['"]@\/components\/ui\/table['"]/);
        expect(src).toMatch(/from\s*['"]@\/components\/layout\/ListPageShell['"]/);
        expect(src).toMatch(/\bDataTable\b/);
        expect(src).toMatch(/<ListPageShell\b/);
    });

    it('mounts exactly one <DataTable> for the roles list', () => {
        // JSX-element form (newline / attribute after) so doc-
        // comment mentions don't inflate the count.
        const matches = src.match(/<DataTable\s/g) ?? [];
        expect(matches.length).toBe(1);
    });

    it('does NOT carry the legacy hand-rolled `<table className="data-table" id="roles-table"`', () => {
        // The PermissionGrid (defined inside the same file)
        // still uses `<table className="data-table">` styling
        // — that's a static permissions matrix, not a list, so
        // it's allowed to keep the inline table markup. The
        // ROLE-LIST table is the one that had to migrate; it
        // used to carry `id="roles-table"`.
        expect(src).not.toMatch(/<table[^>]*id="roles-table"/);
    });

    it('moves the inline-row edit form to an above-table panel (DataTable model)', () => {
        // The legacy markup expanded a row to a `<td colSpan={6}>`
        // when editing. The migrated shape renders an
        // `#edit-role-form` panel above the table — same place +
        // shape as the existing `#create-role-form` create panel.
        expect(src).toMatch(/id="edit-role-form"/);
        expect(src).toMatch(/id="create-role-form"/);
        // The cell-colSpan pattern must be gone for the role
        // table. Match `colSpan=` followed by `{6}` in JSX form;
        // ignore comment mentions (which aren't JSX attributes).
        // Strip block comments first, then assert.
        const stripped = blankNonCode(src);
        expect(stripped).not.toMatch(/colSpan=\{6\}/);
    });

    it('hides the row currently being edited from the table (one obvious focus surface)', () => {
        expect(src).toMatch(/visibleRoles/);
    });

    it('preserves every stable id E2E + analytics rely on', () => {
        const ids = [
            'create-role-btn',
            'create-role-form',
            'role-name-input',
            'role-base-select',
            'role-description-input',
            'toggle-permissions-btn',
            'role-submit-btn',
            'roles-error',
            'roles-success',
            'roles-table-card',
        ];
        for (const id of ids) {
            expect(src).toMatch(new RegExp(`id="${id}"`));
        }
    });

    it('preserves the per-row stable id templates (edit, delete, permission toggles, role presets)', () => {
        const templates = [
            'edit-role-',
            'delete-role-',
            'perm-',
            'preset-',
        ];
        for (const t of templates) {
            // id={`<template>${ … }`}
            expect(src).toMatch(new RegExp(`id=\\{\`${t}\\$\\{`));
        }
    });

    it('exposes data-testid="roles-table" for E2E', () => {
        expect(src).toMatch(/data-testid="roles-table"/);
    });
});

// ─── Cross-page consistency with api-keys (the reference) ────────────

describe('admin list architecture parity with api-keys', () => {
    const apiKeys = read(API_KEYS);
    const members = read(MEMBERS);
    const roles = read(ROLES);

    it('all three admin lists import DataTable from the same path (no shadow primitives)', () => {
        const importPattern = /from\s*['"]@\/components\/ui\/table['"]/;
        expect(apiKeys).toMatch(importPattern);
        expect(members).toMatch(importPattern);
        expect(roles).toMatch(importPattern);
    });

    it('all three use createColumns rather than inline tanstack column defs', () => {
        for (const src of [apiKeys, members, roles]) {
            expect(src).toMatch(/createColumns\s*</);
        }
    });
});
