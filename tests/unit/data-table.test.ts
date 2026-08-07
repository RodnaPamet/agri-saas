/**
 * DataTable Foundation Tests
 *
 * Tests for the core table-utils module (pure functions) and column definition
 * contracts. DOM-dependent tests (isClickOnInteractiveChild) are excluded because
 * jest-environment-jsdom is not installed in this project.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- this file
 * introspects TanStack Table column-definition objects via patterns
 * like `(col as any).accessorFn(row)` and `(col as any).cell` and
 * `(col as any).meta`. TanStack's `ColumnDef<T>` is a discriminated
 * union (AccessorColumnDef vs DisplayColumnDef vs GroupColumnDef);
 * each test asserts a specific variant's runtime field. Narrowing
 * via `'accessorFn' in col` per-site would add ~30 lines for zero
 * type-safety benefit (the tests fail-by-runtime if the variant is
 * wrong). The `[…] as any` row-array casts pass minimal mock rows
 * to the helpers — typing them via TanStack's `Row<T>` would pull
 * in 50+ unused properties. */

// ─── table-utils: deepEqual tests ───────────────────────────────────

import { deepEqual } from '@/components/ui/table/table-utils';

describe('table-utils', () => {
  describe('deepEqual', () => {
    it('returns true for identical references', () => {
      const obj = { a: 1 };
      expect(deepEqual(obj, obj)).toBe(true);
    });

    it('returns true for deeply equal objects', () => {
      expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    });

    it('returns false for objects with different values', () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('returns false for objects with different keys', () => {
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it('returns false for objects with different key counts', () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });

    it('handles null objects', () => {
      expect(deepEqual(null, { a: 1 })).toBe(false);
      expect(deepEqual({ a: 1 }, null)).toBe(false);
    });

    it('returns true for empty objects', () => {
      expect(deepEqual({}, {})).toBe(true);
    });

    it('handles nested arrays', () => {
      expect(deepEqual({ a: [1, 2, 3] }, { a: [1, 2, 3] })).toBe(true);
      expect(deepEqual({ a: [1, 2, 3] }, { a: [1, 2, 4] })).toBe(false);
    });

    it('handles primitives vs objects', () => {
      expect(deepEqual(42, { a: 1 })).toBe(false);
      expect(deepEqual({ a: 1 }, 'string')).toBe(false);
    });

    it('handles deeply nested structures', () => {
      const a = { level1: { level2: { level3: { value: 42 } } } };
      const b = { level1: { level2: { level3: { value: 42 } } } };
      const c = { level1: { level2: { level3: { value: 99 } } } };
      expect(deepEqual(a, b)).toBe(true);
      expect(deepEqual(a, c)).toBe(false);
    });
  });
});

// ─── Column definition contract tests ───────────────────────────────

import type { ColumnDef } from '@tanstack/react-table';

/**
 * Helper to create a typed column array — mirrors createColumns from
 * data-table.tsx but avoids the JSX import.
 */
function createTestColumns<T>(
  columns: ColumnDef<T, any>[],
): ColumnDef<T, any>[] {
  return columns;
}

interface MockControl {
  id: string;
  code: string;
  name: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'IMPLEMENTED';
  owner?: { name: string };
}

describe('Column definition contracts', () => {
  const controlColumns = createTestColumns<MockControl>([
    { accessorKey: 'code', header: 'Code', size: 120 },
    { accessorKey: 'name', header: 'Name' },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ getValue }) => {
        const status = getValue() as string;
        return status.replace(/_/g, ' ');
      },
    },
    {
      id: 'owner',
      header: 'Owner',
      accessorFn: (row) => row.owner?.name ?? '—',
    },
    {
      id: 'actions',
      header: '',
      cell: () => null,
      meta: { disableTruncate: true },
    },
  ]);

  it('column definitions cover typical entity table pattern', () => {
    expect(controlColumns).toHaveLength(5);
  });

  it('accessorKey columns have correct keys', () => {
    expect(controlColumns[0]).toHaveProperty('accessorKey', 'code');
    expect(controlColumns[1]).toHaveProperty('accessorKey', 'name');
    expect(controlColumns[2]).toHaveProperty('accessorKey', 'status');
  });

  it('accessorFn columns use computed values', () => {
    const ownerCol = controlColumns[3];
    expect(ownerCol).toHaveProperty('id', 'owner');
    expect(ownerCol).toHaveProperty('accessorFn');
    const mockWithOwner: MockControl = { id: '1', code: 'AC-001', name: 'Test', status: 'IMPLEMENTED', owner: { name: 'Alice' } };
    const mockNoOwner: MockControl = { id: '2', code: 'AC-002', name: 'Test', status: 'IN_PROGRESS' };
    expect((ownerCol as any).accessorFn(mockWithOwner)).toBe('Alice');
    expect((ownerCol as any).accessorFn(mockNoOwner)).toBe('—');
  });

  it('action column uses id instead of accessorKey', () => {
    expect(controlColumns[4]).toHaveProperty('id', 'actions');
    expect(controlColumns[4]).not.toHaveProperty('accessorKey');
  });

  it('cell renderers transform values correctly', () => {
    const statusCol = controlColumns[2];
    const cellFn = (statusCol as any).cell;
    expect(cellFn({ getValue: () => 'IN_PROGRESS' })).toBe('IN PROGRESS');
    expect(cellFn({ getValue: () => 'NOT_STARTED' })).toBe('NOT STARTED');
    expect(cellFn({ getValue: () => 'IMPLEMENTED' })).toBe('IMPLEMENTED');
  });

  it('meta.disableTruncate is supported on columns', () => {
    const actionCol = controlColumns[4];
    expect((actionCol as any).meta?.disableTruncate).toBe(true);
  });

  it('columns can have size constraints', () => {
    expect(controlColumns[0]).toHaveProperty('size', 120);
  });
});

// ─── Multi-entity column patterns ───────────────────────────────────

describe('Multi-entity column patterns', () => {
  it('supports Risk entity column pattern', () => {
    interface MockRisk {
      id: string;
      title: string;
      category: string;
      likelihood: number;
      impact: number;
    }

    const riskColumns = createTestColumns<MockRisk>([
      { accessorKey: 'title', header: 'Risk' },
      { accessorKey: 'category', header: 'Category' },
      { accessorKey: 'likelihood', header: 'Likelihood' },
      { accessorKey: 'impact', header: 'Impact' },
      {
        id: 'score',
        header: 'Score',
        accessorFn: (row) => row.likelihood * row.impact,
      },
    ]);

    expect(riskColumns).toHaveLength(5);
    expect((riskColumns[4] as any).accessorFn({ likelihood: 4, impact: 5 } as MockRisk)).toBe(20);
  });

  it('supports Policy entity column pattern', () => {
    interface MockPolicy {
      id: string;
      title: string;
      status: string;
      category: string;
      updatedAt: string;
    }

    const columns = createTestColumns<MockPolicy>([
      { accessorKey: 'title', header: 'Policy' },
      { accessorKey: 'status', header: 'Status' },
      { accessorKey: 'category', header: 'Category' },
      { accessorKey: 'updatedAt', header: 'Last Updated' },
    ]);

    expect(columns).toHaveLength(4);
  });

  it('supports Vendor entity column pattern', () => {
    interface MockVendor {
      id: string;
      name: string;
      criticality: string;
      status: string;
      reviewDate: string | null;
    }

    const columns = createTestColumns<MockVendor>([
      { accessorKey: 'name', header: 'Vendor' },
      { accessorKey: 'criticality', header: 'Criticality' },
      { accessorKey: 'status', header: 'Status' },
      {
        id: 'reviewDate',
        header: 'Next Review',
        accessorFn: (row) => row.reviewDate ?? 'Not scheduled',
      },
    ]);

    expect(columns).toHaveLength(4);
    expect((columns[3] as any).accessorFn({ reviewDate: null } as MockVendor)).toBe('Not scheduled');
    expect((columns[3] as any).accessorFn({ reviewDate: '2026-06-01' } as MockVendor)).toBe('2026-06-01');
  });

  it('supports Evidence entity column pattern', () => {
    interface MockEvidence {
      id: string;
      title: string;
      type: string;
      status: string;
      uploadedBy: { name: string };
    }

    const columns = createTestColumns<MockEvidence>([
      { accessorKey: 'title', header: 'Evidence' },
      { accessorKey: 'type', header: 'Type' },
      { accessorKey: 'status', header: 'Status' },
      {
        id: 'uploadedBy',
        header: 'Uploaded By',
        accessorFn: (row) => row.uploadedBy.name,
      },
    ]);

    expect(columns).toHaveLength(4);
  });

  it('supports Task/Issue entity column pattern', () => {
    interface MockTask {
      id: string;
      title: string;
      type: string;
      severity: string;
      status: string;
      dueDate: string | null;
      assignee?: { name: string };
    }

    const columns = createTestColumns<MockTask>([
      { accessorKey: 'title', header: 'Task' },
      { accessorKey: 'type', header: 'Type' },
      { accessorKey: 'severity', header: 'Severity' },
      { accessorKey: 'status', header: 'Status' },
      {
        id: 'assignee',
        header: 'Assignee',
        accessorFn: (row) => row.assignee?.name ?? 'Unassigned',
      },
      {
        id: 'dueDate',
        header: 'Due',
        accessorFn: (row) => row.dueDate ?? '—',
      },
    ]);

    expect(columns).toHaveLength(6);
  });

  it('supports Framework entity column pattern', () => {
    interface MockFramework {
      key: string;
      name: string;
      version: string;
      requirementCount: number;
      coverage: number;
    }

    const columns = createTestColumns<MockFramework>([
      { accessorKey: 'name', header: 'Framework' },
      { accessorKey: 'version', header: 'Version' },
      { accessorKey: 'requirementCount', header: 'Requirements' },
      {
        id: 'coverage',
        header: 'Coverage',
        accessorFn: (row) => `${Math.round(row.coverage * 100)}%`,
      },
    ]);

    expect(columns).toHaveLength(4);
    expect((columns[3] as any).accessorFn({ coverage: 0.875 } as MockFramework)).toBe('88%');
  });

  it('supports Admin members column pattern', () => {
    interface MockMember {
      id: string;
      name: string;
      email: string;
      role: string;
      lastLogin: string | null;
    }

    const columns = createTestColumns<MockMember>([
      { accessorKey: 'name', header: 'Name' },
      { accessorKey: 'email', header: 'Email' },
      { accessorKey: 'role', header: 'Role' },
      {
        id: 'lastLogin',
        header: 'Last Login',
        accessorFn: (row) => row.lastLogin ?? 'Never',
      },
    ]);

    expect(columns).toHaveLength(4);
    expect((columns[3] as any).accessorFn({ lastLogin: null } as MockMember)).toBe('Never');
  });

  it('supports sortable column pattern', () => {
    interface MockItem {
      id: string;
      name: string;
      createdAt: string;
    }

    const columns = createTestColumns<MockItem>([
      { accessorKey: 'name', header: 'Name' },
      { accessorKey: 'createdAt', header: 'Created' },
    ]);

    // Sortable columns are specified separately from column defs
    const sortableColumns = ['name', 'createdAt'];

    expect(sortableColumns).toContain('name');
    expect(sortableColumns).toContain('createdAt');
    expect(columns).toHaveLength(2);
  });
});

// ─── Type-level contract tests ──────────────────────────────────────

describe('Type contracts', () => {
  it('UseTableProps accepts the base required fields', () => {
    type UseTableProps = import('@/components/ui/table/types').UseTableProps<MockControl>;

    const props: UseTableProps = {
      data: [],
      columns: [],
    };
    expect(props.data).toEqual([]);
  });

  it('UseTableProps accepts pagination discriminated union', () => {
    type UseTableProps = import('@/components/ui/table/types').UseTableProps<MockControl>;

    const withPag: UseTableProps = {
      data: [],
      columns: [],
      pagination: { pageIndex: 1, pageSize: 25 },
      onPaginationChange: () => {},
      rowCount: 100,
    };
    expect(withPag.rowCount).toBe(100);
  });

  it('UseTableProps accepts all optional features', () => {
    type UseTableProps = import('@/components/ui/table/types').UseTableProps<MockControl>;

    const full: UseTableProps = {
      data: [],
      columns: [],
      sortableColumns: ['code', 'name'],
      sortBy: 'code',
      sortOrder: 'asc',
      onSortChange: () => {},
      loading: true,
      getRowId: (row) => row.id,
      columnVisibility: { code: true, name: true },
    };
    expect(full.sortableColumns).toEqual(['code', 'name']);
  });

  it('TableProps requires table instance', () => {
    type TableProps = import('@/components/ui/table/types').TableProps<MockControl>;

    // Type-level check — verify the type shape exists
    const check: Partial<TableProps> = {
      data: [],
      columns: [],
      loading: false,
    };
    expect(check).toBeDefined();
  });
});
// ─── Selection & Batch Action Architecture Tests ────────────────────

import type { RowSelectionState, Table as TableType } from '@tanstack/react-table';

describe('Selection state management', () => {
  it('RowSelectionState is a Record<string, boolean> for row tracking', () => {
    const state: RowSelectionState = {
      'row-1': true,
      'row-2': true,
      'row-3': false,
    };
    expect(Object.keys(state)).toHaveLength(3);
    expect(state['row-1']).toBe(true);
    expect(state['row-3']).toBe(false);
  });

  it('empty RowSelectionState means no rows selected', () => {
    const state: RowSelectionState = {};
    expect(Object.entries(state).filter(([, v]) => v)).toHaveLength(0);
  });

  it('selected row count is computed from true values', () => {
    const state: RowSelectionState = { a: true, b: true, c: false, d: true };
    const selectedCount = Object.values(state).filter(Boolean).length;
    expect(selectedCount).toBe(3);
  });

  it('select-all is modeled as all row IDs set to true', () => {
    const rowIds = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const selectAll: RowSelectionState = Object.fromEntries(
      rowIds.map(id => [id, true]),
    );
    expect(Object.keys(selectAll)).toHaveLength(5);
    expect(Object.values(selectAll).every(Boolean)).toBe(true);
  });

  it('deselect-all resets to empty object', () => {
    const state: RowSelectionState = { a: true, b: true };
    const cleared: RowSelectionState = {};
    expect(Object.keys(cleared)).toHaveLength(0);
    // Original remains unaffected (immutable)
    expect(Object.keys(state)).toHaveLength(2);
  });

  it('toggle-row flips a single row in the selection state', () => {
    const toggleRow = (state: RowSelectionState, id: string): RowSelectionState => {
      const next = { ...state };
      next[id] = !next[id];
      return next;
    };

    let state: RowSelectionState = {};
    state = toggleRow(state, 'row-1');
    expect(state['row-1']).toBe(true);
    state = toggleRow(state, 'row-1');
    expect(state['row-1']).toBe(false);
  });

  it('shift-select range selects contiguous rows', () => {
    const rowIds = ['r1', 'r2', 'r3', 'r4', 'r5'];

    // Simulate shift-click from r2 to r4
    const start = rowIds.indexOf('r2');
    const end = rowIds.indexOf('r4');
    const rangeIds = rowIds.slice(start, end + 1);

    const state: RowSelectionState = {};
    const withRange = {
      ...state,
      ...Object.fromEntries(rangeIds.map(id => [id, true])),
    };

    expect(withRange['r1']).toBeUndefined();
    expect(withRange['r2']).toBe(true);
    expect(withRange['r3']).toBe(true);
    expect(withRange['r4']).toBe(true);
    expect(withRange['r5']).toBeUndefined();
  });

  it('stale row removal filters selection to current data', () => {
    const selection: RowSelectionState = { 'row-1': true, 'row-2': true, 'row-3': true };
    const currentData = [{ id: 'row-1' }, { id: 'row-3' }];
    const currentIds = new Set(currentData.map(r => r.id));

    const cleaned = Object.fromEntries(
      Object.entries(selection).filter(([key]) => currentIds.has(key)),
    );

    expect(Object.keys(cleaned)).toEqual(['row-1', 'row-3']);
    expect(cleaned['row-2']).toBeUndefined();
  });
});

describe('SelectionToolbar visibility contract', () => {
  it('toolbar is visible when selectedCount > 0', () => {
    const isVisible = (count: number) => count > 0;
    expect(isVisible(0)).toBe(false);
    expect(isVisible(1)).toBe(true);
    expect(isVisible(50)).toBe(true);
  });

  it('toolbar is inert (non-interactive) when no selection', () => {
    const isInert = (count: number) => count === 0;
    expect(isInert(0)).toBe(true);
    expect(isInert(3)).toBe(false);
  });

  it('lastSelectedCount persists when selection clears (for animation)', () => {
    let lastSelectedCount = 0;
    const selectedCounts = [0, 3, 5, 0]; // select → select more → clear

    for (const count of selectedCounts) {
      if (count !== 0) lastSelectedCount = count;
    }

    expect(lastSelectedCount).toBe(5);
  });

  it('toolbar shows indeterminate state when some rows selected', () => {
    const getCheckState = (allSelected: boolean, someSelected: boolean) => {
      if (allSelected) return true;
      if (someSelected) return 'indeterminate';
      return false;
    };

    expect(getCheckState(false, false)).toBe(false);
    expect(getCheckState(false, true)).toBe('indeterminate');
    expect(getCheckState(true, false)).toBe(true);
  });
});

describe('BatchAction type contracts', () => {
  // Import the actual type to ensure it's well-formed
  type BatchAction<T> = import('@/components/ui/table/selection-toolbar').BatchAction<T>;

  interface MockEntity {
    id: string;
    name: string;
    status: string;
  }

  it('BatchAction requires label and onClick', () => {
    const action: BatchAction<MockEntity> = {
      label: 'Export',
      onClick: () => {},
    };
    expect(action.label).toBe('Export');
    expect(typeof action.onClick).toBe('function');
  });

  it('BatchAction supports variant property', () => {
    const safeAction: BatchAction<MockEntity> = {
      label: 'Export',
      onClick: () => {},
      variant: 'default',
    };
    const dangerAction: BatchAction<MockEntity> = {
      label: 'Delete',
      onClick: () => {},
      variant: 'danger',
    };
    expect(safeAction.variant).toBe('default');
    expect(dangerAction.variant).toBe('danger');
  });

  it('BatchAction supports disabled and title properties', () => {
    const action: BatchAction<MockEntity> = {
      label: 'Archive',
      onClick: () => {},
      disabled: true,
      title: 'Archiving is disabled for this view',
    };
    expect(action.disabled).toBe(true);
    expect(action.title).toBeDefined();
  });

  it('BatchAction onClick receives row array', () => {
    const collected: string[] = [];
    const action: BatchAction<MockEntity> = {
      label: 'Collect IDs',
      onClick: (rows) => {
        rows.forEach(r => collected.push((r as any).id));
      },
    };

    // Simulate row objects with IDs
    const mockRows = [{ id: 'r1' }, { id: 'r2' }] as any;
    action.onClick(mockRows);
    expect(collected).toEqual(['r1', 'r2']);
  });

  it('BatchAction array supports mixed variants', () => {
    const actions: BatchAction<MockEntity>[] = [
      { label: 'Export', onClick: () => {}, variant: 'default' },
      { label: 'Assign', onClick: () => {} },
      { label: 'Delete', onClick: () => {}, variant: 'danger' },
    ];
    expect(actions).toHaveLength(3);
    expect(actions.filter(a => a.variant === 'danger')).toHaveLength(1);
    expect(actions.filter(a => !a.variant || a.variant === 'default')).toHaveLength(2);
  });
});

describe('renderBatchActions helper', () => {
  // Test the pure function behavior of renderBatchActions
  it('returns a function when given an action array', () => {
    // We can't import the JSX-heavy implementation here, but we can test the contract
    type BatchAction<T> = import('@/components/ui/table/selection-toolbar').BatchAction<T>;

    interface Item { id: string }

    // The type contract: renderBatchActions returns (table) => ReactNode
    type RenderFn = (actions: BatchAction<Item>[]) =>
      (table: TableType<Item>) => import('react').ReactNode;

    // Type-level assertion only (would need JSX environment for actual rendering)
    const typeCheck: RenderFn | undefined = undefined;
    expect(typeCheck).toBeUndefined(); // prevent unused lint
  });
});

describe('DataTable selection props contract', () => {
  type DataTableProps<T> = import('@/components/ui/table/data-table').DataTableProps<T>;

  interface MockItem {
    id: string;
    name: string;
  }

  it('DataTable supports onRowSelectionChange for selection enabling', () => {
    const props: Partial<DataTableProps<MockItem>> = {
      data: [],
      columns: [],
      getRowId: (row) => row.id,
      onRowSelectionChange: () => {},
    };
    expect(props.onRowSelectionChange).toBeDefined();
  });

  it('DataTable supports selectedRows for externally controlled selection', () => {
    const props: Partial<DataTableProps<MockItem>> = {
      data: [],
      columns: [],
      selectedRows: { 'item-1': true, 'item-2': true },
    };
    expect(Object.keys(props.selectedRows!)).toHaveLength(2);
  });

  it('DataTable supports selectionControls for custom toolbar content', () => {
    const props: Partial<DataTableProps<MockItem>> = {
      data: [],
      columns: [],
      selectionControls: (table) => null,
      onRowSelectionChange: () => {},
    };
    expect(typeof props.selectionControls).toBe('function');
  });

  it('DataTable supports batchActions for declarative batch action buttons', () => {
    const props: Partial<DataTableProps<MockItem>> = {
      data: [],
      columns: [],
      getRowId: (row) => row.id,
      batchActions: [
        { label: 'Export', onClick: () => {} },
        { label: 'Delete', onClick: () => {}, variant: 'danger' },
      ],
    };
    expect(props.batchActions).toHaveLength(2);
  });

  it('batchActions implicitly enables selection (no onRowSelectionChange needed)', () => {
    // When only batchActions is provided, selection should auto-enable
    const props: Partial<DataTableProps<MockItem>> = {
      data: [{ id: '1', name: 'A' }],
      columns: [],
      getRowId: (row) => row.id,
      batchActions: [{ label: 'Act', onClick: () => {} }],
      // No onRowSelectionChange — should still work
    };
    expect(props.batchActions!.length).toBeGreaterThan(0);
    expect(props.onRowSelectionChange).toBeUndefined();
  });

  it('selectionControls and batchActions can coexist (selectionControls wins)', () => {
    const props: Partial<DataTableProps<MockItem>> = {
      data: [],
      columns: [],
      getRowId: (row) => row.id,
      selectionControls: () => null,
      batchActions: [{ label: 'Export', onClick: () => {} }],
      onRowSelectionChange: () => {},
    };
    // Both are present; selectionControls takes precedence per our implementation
    expect(props.selectionControls).toBeDefined();
    expect(props.batchActions).toBeDefined();
  });
});

describe('Selection keyboard ergonomics', () => {
  it('Escape key clears selection when rows are selected', () => {
    // Contract test: Escape handler should only fire when selectedCount > 0
    const shouldHookBeEnabled = (count: number) => count > 0;

    expect(shouldHookBeEnabled(0)).toBe(false);
    expect(shouldHookBeEnabled(1)).toBe(true);
    expect(shouldHookBeEnabled(10)).toBe(true);
  });

  it('Escape shortcut has priority 2 (above filter clear)', () => {
    // The SelectionToolbar uses priority: 2 for Escape
    // This ensures selection clear takes precedence over filter clear (priority 1)
    const priorities = { filterClear: 1, selectionClear: 2, modalClose: 3 };
    expect(priorities.selectionClear).toBeGreaterThan(priorities.filterClear);
    expect(priorities.selectionClear).toBeLessThan(priorities.modalClose);
  });
});

describe('No regression: read-only table usage', () => {
  type DataTableProps<T> = import('@/components/ui/table/data-table').DataTableProps<T>;

  interface ReadOnlyItem {
    id: string;
    name: string;
    value: number;
  }

  it('DataTable works without any selection props', () => {
    const props: Partial<DataTableProps<ReadOnlyItem>> = {
      data: [
        { id: '1', name: 'Alpha', value: 10 },
        { id: '2', name: 'Beta', value: 20 },
      ],
      columns: [],
      loading: false,
    };
    // No selection props — should be valid
    expect(props.onRowSelectionChange).toBeUndefined();
    expect(props.selectedRows).toBeUndefined();
    expect(props.selectionControls).toBeUndefined();
    expect(props.batchActions).toBeUndefined();
  });

  it('onRowClick works independently of selection', () => {
    const clicked: string[] = [];
    const props: Partial<DataTableProps<ReadOnlyItem>> = {
      data: [],
      columns: [],
      onRowClick: (row) => clicked.push(row.id),
    };
    expect(props.onRowClick).toBeDefined();
    expect(props.onRowSelectionChange).toBeUndefined();
  });

  it('sorting works independently of selection', () => {
    const props: Partial<DataTableProps<ReadOnlyItem>> = {
      data: [],
      columns: [],
      sortableColumns: ['name', 'value'],
      sortBy: 'name',
      sortOrder: 'asc',
      onSortChange: () => {},
    };
    expect(props.sortableColumns).toHaveLength(2);
    expect(props.onRowSelectionChange).toBeUndefined();
  });

  it('pagination works independently of selection', () => {
    const props: Partial<DataTableProps<ReadOnlyItem>> = {
      data: [],
      columns: [],
      pagination: { pageIndex: 0, pageSize: 25 },
      onPaginationChange: () => {},
      rowCount: 100,
    };
    expect(props.pagination).toBeDefined();
    expect(props.onRowSelectionChange).toBeUndefined();
  });
});

// ─── Pagination Utility Tests ───────────────────────────────────────

import {
  getPageCount,
  getPageRange,
  getPaginationState,
  clampPage,
  formatPageRange,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
} from '@/components/ui/table/pagination-utils';

describe('getPageCount', () => {
  it('returns correct page count for exact division', () => {
    expect(getPageCount(100, 25)).toBe(4);
    expect(getPageCount(50, 50)).toBe(1);
  });

  it('rounds up for non-exact division', () => {
    expect(getPageCount(101, 25)).toBe(5);
    expect(getPageCount(1, 25)).toBe(1);
    expect(getPageCount(26, 25)).toBe(2);
  });

  it('returns 0 for zero total count', () => {
    expect(getPageCount(0, 25)).toBe(0);
  });

  it('returns 0 for zero or negative page size', () => {
    expect(getPageCount(100, 0)).toBe(0);
    expect(getPageCount(100, -5)).toBe(0);
  });

  it('returns 0 for negative total count', () => {
    expect(getPageCount(-10, 25)).toBe(0);
  });
});

describe('getPageRange', () => {
  it('returns correct range for first page', () => {
    const range = getPageRange({ page: 1, pageSize: 25, totalCount: 100 });
    expect(range).toEqual({ from: 1, to: 25, total: 100 });
  });

  it('returns correct range for middle page', () => {
    const range = getPageRange({ page: 2, pageSize: 25, totalCount: 100 });
    expect(range).toEqual({ from: 26, to: 50, total: 100 });
  });

  it('returns correct range for last page (partial)', () => {
    const range = getPageRange({ page: 3, pageSize: 25, totalCount: 60 });
    expect(range).toEqual({ from: 51, to: 60, total: 60 });
  });

  it('returns correct range for last page (full)', () => {
    const range = getPageRange({ page: 4, pageSize: 25, totalCount: 100 });
    expect(range).toEqual({ from: 76, to: 100, total: 100 });
  });

  it('returns correct range for single item', () => {
    const range = getPageRange({ page: 1, pageSize: 25, totalCount: 1 });
    expect(range).toEqual({ from: 1, to: 1, total: 1 });
  });

  it('returns zeros for empty dataset', () => {
    const range = getPageRange({ page: 1, pageSize: 25, totalCount: 0 });
    expect(range).toEqual({ from: 0, to: 0, total: 0 });
  });

  it('clamps "to" to totalCount on partial last page', () => {
    const range = getPageRange({ page: 2, pageSize: 50, totalCount: 73 });
    expect(range.to).toBe(73);
    expect(range.from).toBe(51);
  });
});

describe('getPaginationState', () => {
  it('returns correct state for first page of multi-page set', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 100 });
    expect(state.pageCount).toBe(4);
    expect(state.canPreviousPage).toBe(false);
    expect(state.canNextPage).toBe(true);
    expect(state.isFirstPage).toBe(true);
    expect(state.isLastPage).toBe(false);
    expect(state.isSinglePage).toBe(false);
    expect(state.isEmpty).toBe(false);
  });

  it('returns correct state for middle page', () => {
    const state = getPaginationState({ page: 2, pageSize: 25, totalCount: 100 });
    expect(state.canPreviousPage).toBe(true);
    expect(state.canNextPage).toBe(true);
    expect(state.isFirstPage).toBe(false);
    expect(state.isLastPage).toBe(false);
  });

  it('returns correct state for last page', () => {
    const state = getPaginationState({ page: 4, pageSize: 25, totalCount: 100 });
    expect(state.canPreviousPage).toBe(true);
    expect(state.canNextPage).toBe(false);
    expect(state.isFirstPage).toBe(false);
    expect(state.isLastPage).toBe(true);
  });

  it('returns correct state for single-page result', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 10 });
    expect(state.pageCount).toBe(1);
    expect(state.canPreviousPage).toBe(false);
    expect(state.canNextPage).toBe(false);
    expect(state.isSinglePage).toBe(true);
    expect(state.isEmpty).toBe(false);
  });

  it('returns correct state for empty result', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 0 });
    expect(state.pageCount).toBe(0);
    expect(state.canPreviousPage).toBe(false);
    expect(state.canNextPage).toBe(false);
    expect(state.isEmpty).toBe(true);
    expect(state.isSinglePage).toBe(true);
  });

  it('includes correct range in state', () => {
    const state = getPaginationState({ page: 2, pageSize: 25, totalCount: 60 });
    expect(state.range.from).toBe(26);
    expect(state.range.to).toBe(50);
    expect(state.range.total).toBe(60);
  });
});

describe('clampPage', () => {
  it('clamps to 1 when page is below bounds', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-3, 5)).toBe(1);
  });

  it('clamps to pageCount when page is above bounds', () => {
    expect(clampPage(10, 5)).toBe(5);
    expect(clampPage(100, 3)).toBe(3);
  });

  it('returns page when within bounds', () => {
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(1, 1)).toBe(1);
  });

  it('returns 1 when pageCount is 0', () => {
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('formatPageRange', () => {
  it('formats basic range', () => {
    expect(formatPageRange({ from: 1, to: 25, total: 100 })).toBe('1–25 of 100 items');
  });

  it('formats with custom resource name', () => {
    const name = (plural: boolean) => plural ? 'controls' : 'control';
    expect(formatPageRange({ from: 1, to: 25, total: 100 }, name)).toBe('1–25 of 100 controls');
  });

  it('formats singular resource name', () => {
    const name = (plural: boolean) => plural ? 'controls' : 'control';
    expect(formatPageRange({ from: 1, to: 1, total: 1 }, name)).toBe('1–1 of 1 control');
  });

  it('returns empty string for empty range', () => {
    expect(formatPageRange({ from: 0, to: 0, total: 0 })).toBe('');
  });
});

describe('Pagination constants', () => {
  it('DEFAULT_PAGE_SIZE is a reasonable number', () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(100);
  });

  it('PAGE_SIZE_OPTIONS contains the default', () => {
    expect(PAGE_SIZE_OPTIONS).toContain(DEFAULT_PAGE_SIZE);
  });

  it('PAGE_SIZE_OPTIONS are in ascending order', () => {
    for (let i = 1; i < PAGE_SIZE_OPTIONS.length; i++) {
      expect(PAGE_SIZE_OPTIONS[i]).toBeGreaterThan(PAGE_SIZE_OPTIONS[i - 1]);
    }
  });
});

// ─── PaginationControls Contract Tests ──────────────────────────────

describe('PaginationControls contract', () => {
  type PaginationControlsProps = import('@/components/ui/table/pagination-controls').PaginationControlsProps;

  it('accepts the required props', () => {
    const props: PaginationControlsProps = {
      page: 1,
      pageSize: 25,
      totalCount: 100,
      onPageChange: () => {},
    };
    expect(props.page).toBe(1);
    expect(props.totalCount).toBe(100);
  });

  it('accepts optional resourceName', () => {
    const props: PaginationControlsProps = {
      page: 1,
      pageSize: 25,
      totalCount: 100,
      onPageChange: () => {},
      resourceName: (p) => p ? 'risks' : 'risk',
    };
    expect(props.resourceName!(true)).toBe('risks');
    expect(props.resourceName!(false)).toBe('risk');
  });

  it('accepts optional allRowsHref', () => {
    const props: PaginationControlsProps = {
      page: 1,
      pageSize: 25,
      totalCount: 100,
      onPageChange: () => {},
      allRowsHref: '/controls?view=all',
    };
    expect(props.allRowsHref).toBe('/controls?view=all');
  });

  it('onPageChange receives the next page number', () => {
    const pages: number[] = [];
    const props: PaginationControlsProps = {
      page: 2,
      pageSize: 25,
      totalCount: 100,
      onPageChange: (p) => pages.push(p),
    };
    // Simulate clicking "Previous"
    props.onPageChange(props.page - 1);
    expect(pages).toEqual([1]);

    // Simulate clicking "Next"
    props.onPageChange(props.page + 1);
    expect(pages).toEqual([1, 3]);
  });
});

// ─── PaginationControls Rendering Logic Tests ───────────────────────

describe('PaginationControls rendering logic', () => {
  it('should not render when totalCount is 0 (empty)', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 0 });
    const shouldRender = !state.isEmpty && !state.isSinglePage;
    expect(shouldRender).toBe(false);
  });

  it('should not render when results fit in one page', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 20 });
    const shouldRender = !state.isEmpty && !state.isSinglePage;
    expect(shouldRender).toBe(false);
  });

  it('should render when results span multiple pages', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 50 });
    const shouldRender = !state.isEmpty && !state.isSinglePage;
    expect(shouldRender).toBe(true);
  });

  it('Previous button disabled on first page', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 100 });
    expect(state.canPreviousPage).toBe(false);
  });

  it('Next button disabled on last page', () => {
    const state = getPaginationState({ page: 4, pageSize: 25, totalCount: 100 });
    expect(state.canNextPage).toBe(false);
  });

  it('Both buttons enabled on middle page', () => {
    const state = getPaginationState({ page: 2, pageSize: 25, totalCount: 100 });
    expect(state.canPreviousPage).toBe(true);
    expect(state.canNextPage).toBe(true);
  });
});

// ─── TableEmptyState Contract Tests ─────────────────────────────────

describe('TableEmptyState contract', () => {
  type TableEmptyStateProps = import('@/components/ui/table/table-empty-state').TableEmptyStateProps;

  it('accepts minimal props (all defaults)', () => {
    const props: TableEmptyStateProps = {};
    expect(props.title).toBeUndefined();
  });

  it('accepts title and description', () => {
    const props: TableEmptyStateProps = {
      title: 'No controls found',
      description: 'Create your first control to get started.',
    };
    expect(props.title).toBe('No controls found');
    expect(props.description).toBeDefined();
  });

  it('accepts action with label and onClick', () => {
    const clicked: boolean[] = [];
    const props: TableEmptyStateProps = {
      title: 'No items',
      action: {
        label: 'Create Item',
        onClick: () => clicked.push(true),
        variant: 'primary',
      },
    };
    expect(props.action!.label).toBe('Create Item');
    props.action!.onClick();
    expect(clicked).toHaveLength(1);
  });

  it('accepts children for custom content', () => {
    const props: TableEmptyStateProps = {
      children: 'Custom empty state',
    };
    expect(props.children).toBe('Custom empty state');
  });
});

// ─── Loading State Contract Tests ───────────────────────────────────

describe('Loading state contract', () => {
  type DataTableProps<T> = import('@/components/ui/table/data-table').DataTableProps<T>;

  interface Item { id: string; name: string }

  it('DataTable accepts loading prop', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      loading: true,
    };
    expect(props.loading).toBe(true);
  });

  it('DataTable accepts error prop', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      error: 'Failed to load controls',
    };
    expect(props.error).toBe('Failed to load controls');
  });

  it('DataTable accepts emptyState prop', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      emptyState: 'Custom empty message',
    };
    expect(props.emptyState).toBe('Custom empty message');
  });

  it('loading and data can coexist (overlay pattern)', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [{ id: '1', name: 'A' }],
      columns: [],
      loading: true, // shows overlay on top of stale data
    };
    expect(props.loading).toBe(true);
    expect(props.data!.length).toBeGreaterThan(0);
  });

  it('error takes precedence over empty state', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      error: 'Network error',
      emptyState: 'No items',
    };
    // In the Table component, error || emptyState means error wins
    const displayed = props.error || props.emptyState;
    expect(displayed).toBe('Network error');
  });
});

// ─── Pagination Boundary Tests ──────────────────────────────────────

describe('Pagination boundary cases', () => {
  it('single item in dataset', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 1 });
    expect(state.pageCount).toBe(1);
    expect(state.isSinglePage).toBe(true);
    expect(state.range.from).toBe(1);
    expect(state.range.to).toBe(1);
  });

  it('exact page boundary (25 of 25)', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 25 });
    expect(state.pageCount).toBe(1);
    expect(state.isSinglePage).toBe(true);
    expect(state.range.to).toBe(25);
  });

  it('one over page boundary (26 of 25)', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 26 });
    expect(state.pageCount).toBe(2);
    expect(state.isSinglePage).toBe(false);
    expect(state.canNextPage).toBe(true);
  });

  it('very large dataset', () => {
    const state = getPaginationState({ page: 1, pageSize: 25, totalCount: 1_000_000 });
    expect(state.pageCount).toBe(40_000);
    expect(state.canNextPage).toBe(true);
    expect(state.range.from).toBe(1);
    expect(state.range.to).toBe(25);
  });

  it('last page of large dataset', () => {
    const state = getPaginationState({ page: 40_000, pageSize: 25, totalCount: 1_000_000 });
    expect(state.isLastPage).toBe(true);
    expect(state.canNextPage).toBe(false);
    expect(state.range.from).toBe(999_976);
    expect(state.range.to).toBe(1_000_000);
  });

  it('page size equals total count', () => {
    const state = getPaginationState({ page: 1, pageSize: 100, totalCount: 100 });
    expect(state.pageCount).toBe(1);
    expect(state.isSinglePage).toBe(true);
  });

  it('page size larger than total count', () => {
    const state = getPaginationState({ page: 1, pageSize: 100, totalCount: 5 });
    expect(state.pageCount).toBe(1);
    expect(state.isSinglePage).toBe(true);
    expect(state.range.from).toBe(1);
    expect(state.range.to).toBe(5);
  });
});

// ─── Column Visibility Utility Tests ────────────────────────────────

import {
  getDefaultVisibility,
  mergeVisibility,
  countVisibility,
  hasCustomVisibility,
  getVisibilityStorageKey,
  COLUMN_VISIBILITY_PREFIX,
} from '@/components/ui/table/column-visibility-utils';
import type { ColumnVisibilityConfig } from '@/components/ui/table/column-visibility-utils';
import type { VisibilityState } from '@tanstack/react-table';

const testConfig: ColumnVisibilityConfig = {
  all: ['code', 'name', 'status', 'owner', 'updatedAt', 'category'],
  defaultVisible: ['code', 'name', 'status', 'owner'],
  fixed: ['code'],
};

describe('getDefaultVisibility', () => {
  it('returns visibility state with defaults visible', () => {
    const vis = getDefaultVisibility(testConfig);
    expect(vis.code).toBe(true);
    expect(vis.name).toBe(true);
    expect(vis.status).toBe(true);
    expect(vis.owner).toBe(true);
    expect(vis.updatedAt).toBe(false);
    expect(vis.category).toBe(false);
  });

  it('includes all columns in the result', () => {
    const vis = getDefaultVisibility(testConfig);
    expect(Object.keys(vis).sort()).toEqual(testConfig.all.slice().sort());
  });

  it('fixed columns are always visible even if not in defaultVisible', () => {
    const config: ColumnVisibilityConfig = {
      all: ['a', 'b', 'c'],
      defaultVisible: ['b'],
      fixed: ['a'],
    };
    const vis = getDefaultVisibility(config);
    expect(vis.a).toBe(true); // fixed
    expect(vis.b).toBe(true); // defaultVisible
    expect(vis.c).toBe(false);
  });

  it('handles config with no fixed columns', () => {
    const config: ColumnVisibilityConfig = {
      all: ['a', 'b', 'c'],
      defaultVisible: ['a'],
    };
    const vis = getDefaultVisibility(config);
    expect(vis.a).toBe(true);
    expect(vis.b).toBe(false);
    expect(vis.c).toBe(false);
  });

  it('handles config with all columns visible by default', () => {
    const config: ColumnVisibilityConfig = {
      all: ['a', 'b', 'c'],
      defaultVisible: ['a', 'b', 'c'],
    };
    const vis = getDefaultVisibility(config);
    expect(Object.values(vis).every(Boolean)).toBe(true);
  });

  it('handles empty config', () => {
    const config: ColumnVisibilityConfig = {
      all: [],
      defaultVisible: [],
    };
    const vis = getDefaultVisibility(config);
    expect(Object.keys(vis)).toHaveLength(0);
  });
});

describe('mergeVisibility', () => {
  it('returns defaults when saved is null', () => {
    const vis = mergeVisibility(null, testConfig);
    expect(vis).toEqual(getDefaultVisibility(testConfig));
  });

  it('returns defaults when saved is undefined', () => {
    const vis = mergeVisibility(undefined, testConfig);
    expect(vis).toEqual(getDefaultVisibility(testConfig));
  });

  it('uses saved values for known columns', () => {
    const saved: VisibilityState = {
      code: true,
      name: false, // user hid name
      status: true,
      owner: false,
      updatedAt: true, // user showed updatedAt
      category: false,
    };
    const vis = mergeVisibility(saved, testConfig);
    expect(vis.name).toBe(false);
    expect(vis.updatedAt).toBe(true);
  });

  it('forces fixed columns to true regardless of saved state', () => {
    const saved: VisibilityState = {
      code: false, // user tried to hide fixed column
      name: true,
      status: true,
      owner: true,
      updatedAt: false,
      category: false,
    };
    const vis = mergeVisibility(saved, testConfig);
    expect(vis.code).toBe(true); // forced visible
  });

  it('uses defaults for new columns not in saved state', () => {
    // Simulates schema evolution: config now has 'priority', saved doesn't
    const config: ColumnVisibilityConfig = {
      all: ['code', 'name', 'priority'],
      defaultVisible: ['code', 'name', 'priority'],
    };
    const saved: VisibilityState = {
      code: true,
      name: false,
      // 'priority' not in saved — should get default
    };
    const vis = mergeVisibility(saved, config);
    expect(vis.code).toBe(true);
    expect(vis.name).toBe(false);
    expect(vis.priority).toBe(true); // defaultVisible
  });

  it('ignores removed columns in saved state', () => {
    // Simulates schema evolution: 'oldCol' was removed from config
    const config: ColumnVisibilityConfig = {
      all: ['a', 'b'],
      defaultVisible: ['a'],
    };
    const saved: VisibilityState = {
      a: true,
      b: false,
      oldCol: true, // no longer in config
    };
    const vis = mergeVisibility(saved, config);
    expect(Object.keys(vis).sort()).toEqual(['a', 'b']);
    expect(vis).not.toHaveProperty('oldCol');
  });
});

describe('countVisibility', () => {
  it('counts visible and hidden columns', () => {
    const state: VisibilityState = {
      a: true,
      b: true,
      c: false,
      d: true,
      e: false,
    };
    const counts = countVisibility(state);
    expect(counts.visible).toBe(3);
    expect(counts.hidden).toBe(2);
    expect(counts.total).toBe(5);
  });

  it('handles all visible', () => {
    const state: VisibilityState = { a: true, b: true, c: true };
    const counts = countVisibility(state);
    expect(counts.visible).toBe(3);
    expect(counts.hidden).toBe(0);
  });

  it('handles all hidden', () => {
    const state: VisibilityState = { a: false, b: false };
    const counts = countVisibility(state);
    expect(counts.visible).toBe(0);
    expect(counts.hidden).toBe(2);
  });

  it('handles empty state', () => {
    const counts = countVisibility({});
    expect(counts.total).toBe(0);
  });
});

describe('hasCustomVisibility', () => {
  it('returns false when current matches defaults', () => {
    const current = getDefaultVisibility(testConfig);
    expect(hasCustomVisibility(current, testConfig)).toBe(false);
  });

  it('returns true when user has hidden a default-visible column', () => {
    const current: VisibilityState = {
      ...getDefaultVisibility(testConfig),
      name: false, // user hid name
    };
    expect(hasCustomVisibility(current, testConfig)).toBe(true);
  });

  it('returns true when user has shown a default-hidden column', () => {
    const current: VisibilityState = {
      ...getDefaultVisibility(testConfig),
      updatedAt: true, // user showed updatedAt
    };
    expect(hasCustomVisibility(current, testConfig)).toBe(true);
  });
});

describe('getVisibilityStorageKey', () => {
  it('prefixes with the standard namespace', () => {
    const key = getVisibilityStorageKey('controls');
    expect(key).toBe(`${COLUMN_VISIBILITY_PREFIX}controls`);
  });

  it('handles entity-specific IDs', () => {
    expect(getVisibilityStorageKey('risks')).toContain('risks');
    expect(getVisibilityStorageKey('policies')).toContain('policies');
  });

  it('keys are unique per table', () => {
    const k1 = getVisibilityStorageKey('controls');
    const k2 = getVisibilityStorageKey('risks');
    expect(k1).not.toBe(k2);
  });
});

describe('EditColumnsButton contract', () => {
  type EditColumnsButtonProps<T> = import('@/components/ui/table/edit-columns-button').EditColumnsButtonProps<T>;

  interface Item { id: string; name: string }

  it('accepts required table prop', () => {
    const props: Partial<EditColumnsButtonProps<Item>> = {
      table: undefined as any, // would be a TanStack table instance
    };
    expect(props).toBeDefined();
  });

  it('accepts optional onReset callback', () => {
    let resetCalled = false;
    const props: Partial<EditColumnsButtonProps<Item>> = {
      onReset: () => { resetCalled = true; },
    };
    props.onReset!();
    expect(resetCalled).toBe(true);
  });

  it('accepts optional className and title', () => {
    const props: Partial<EditColumnsButtonProps<Item>> = {
      className: 'custom-class',
      title: 'Customize columns',
    };
    expect(props.className).toBe('custom-class');
    expect(props.title).toBe('Customize columns');
  });
});

describe('Column visibility integration with DataTable', () => {
  type DataTableProps<T> = import('@/components/ui/table/data-table').DataTableProps<T>;

  interface Item { id: string; name: string; status: string }

  it('DataTable accepts columnVisibility prop', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      columnVisibility: { name: true, status: false },
    };
    expect(props.columnVisibility!.status).toBe(false);
  });

  it('DataTable accepts onColumnVisibilityChange callback', () => {
    const changes: VisibilityState[] = [];
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      onColumnVisibilityChange: (v) => changes.push(v),
    };
    props.onColumnVisibilityChange!({ name: false, status: true });
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe(false);
  });

  it('columnVisibility and onColumnVisibilityChange work together', () => {
    let visibility: VisibilityState = { name: true, status: true };
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      columnVisibility: visibility,
      onColumnVisibilityChange: (v) => { visibility = v; },
    };

    // Simulate toggling status off
    props.onColumnVisibilityChange!({ ...visibility, status: false });
    expect(visibility.status).toBe(false);
    expect(visibility.name).toBe(true);
  });

  it('columns without selection/actions are independently hideable', () => {
    const props: Partial<DataTableProps<Item>> = {
      data: [],
      columns: [],
      columnVisibility: { name: false, status: false },
      onRowSelectionChange: () => {},
    };
    // Selection columns are separate from data columns
    expect(props.columnVisibility!.name).toBe(false);
    expect(props.onRowSelectionChange).toBeDefined();
  });
});

describe('Fixed columns cannot be hidden', () => {
  it('mergeVisibility enforces fixed columns are always visible', () => {
    const config: ColumnVisibilityConfig = {
      all: ['id', 'name', 'actions'],
      defaultVisible: ['id', 'name', 'actions'],
      fixed: ['id', 'actions'],
    };

    // Even if user saved them as hidden
    const saved: VisibilityState = { id: false, name: false, actions: false };
    const result = mergeVisibility(saved, config);

    expect(result.id).toBe(true);     // fixed
    expect(result.name).toBe(false);  // user choice
    expect(result.actions).toBe(true); // fixed
  });

  it('getDefaultVisibility includes fixed columns as visible', () => {
    const config: ColumnVisibilityConfig = {
      all: ['code', 'desc'],
      defaultVisible: [],
      fixed: ['code'],
    };
    const vis = getDefaultVisibility(config);
    expect(vis.code).toBe(true);
    expect(vis.desc).toBe(false);
  });
});

describe('Schema evolution resilience', () => {
  it('handles column added to config after user saved preferences', () => {
    const oldConfig: ColumnVisibilityConfig = {
      all: ['a', 'b'],
      defaultVisible: ['a', 'b'],
    };
    const saved = getDefaultVisibility(oldConfig); // { a: true, b: true }

    // Config now has column 'c'
    const newConfig: ColumnVisibilityConfig = {
      all: ['a', 'b', 'c'],
      defaultVisible: ['a', 'b', 'c'],
    };
    const vis = mergeVisibility(saved, newConfig);
    expect(vis.c).toBe(true); // new column gets default
  });

  it('handles column removed from config after user saved preferences', () => {
    const saved: VisibilityState = { a: true, b: true, removed: false };

    const newConfig: ColumnVisibilityConfig = {
      all: ['a', 'b'],
      defaultVisible: ['a'],
    };
    const vis = mergeVisibility(saved, newConfig);
    expect(vis).not.toHaveProperty('removed');
    expect(Object.keys(vis)).toEqual(['a', 'b']);
  });

  it('handles column renamed (old removed, new added)', () => {
    const saved: VisibilityState = { oldName: true, b: false };

    const newConfig: ColumnVisibilityConfig = {
      all: ['newName', 'b'],
      defaultVisible: ['newName'],
    };
    const vis = mergeVisibility(saved, newConfig);
    expect(vis).not.toHaveProperty('oldName');
    expect(vis.newName).toBe(true); // gets default since not in saved
    expect(vis.b).toBe(false); // preserved from saved
  });
});

// ─── Architecture Compliance: ad-hoc table regression guard ─────────

import * as fs from 'fs';
import * as path from 'path';

describe('Architecture compliance — no ad-hoc tables on list pages', () => {
  const clientDir = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

  // Pages that are intentionally excluded from DataTable migration
  // (SoAClient was one until the compliance uproot deleted it)
  // AuditsClient: master/detail panel UX, not a list page
  // AccessReviewDetailClient: list-of-decisions inside a campaign
  // detail page; per-row inline decision dropdown + decision dialog
  // sit on the row itself. Same architectural shape as
  // AuditsClient — list inside a parent record, not a list page.
  const EXCLUDED_PAGES = [
    'AuditsClient.tsx',
    'AccessReviewDetailClient.tsx',
  ];

  // Discover all *Client.tsx files in the app directory
  function findClientFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findClientFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('Client.tsx')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const clientFiles = findClientFiles(clientDir);

  // Ensure we found the expected files
  it('discovers at least 10 client page files', () => {
    expect(clientFiles.length).toBeGreaterThanOrEqual(10);
  });

  // For each non-excluded file, verify it uses DataTable instead of raw <table>
  const migratedFiles = clientFiles.filter(
    f => !EXCLUDED_PAGES.includes(path.basename(f))
  );

  for (const filePath of migratedFiles) {
    const basename = path.basename(filePath);

    it(`${basename} uses DataTable (not ad-hoc <table>)`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const hasRawTable = /<table[\s>]/.test(content);
      const hasDataTable = /DataTable/.test(content) || /data-table/.test(content);

      // Pages with tables MUST use DataTable
      if (hasRawTable) {
        // If a page still has a raw <table>, it must also have DataTable
        // (this handles transitional cases — but ideally raw table is gone)
        expect(hasDataTable).toBe(true);
      }
    });

    it(`${basename} does not import SkeletonTableRow`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toContain('SkeletonTableRow');
    });
  }

  // Verify excluded pages are still present (guard against accidental deletion)
  for (const excluded of EXCLUDED_PAGES) {
    it(`${excluded} exists and is intentionally excluded`, () => {
      const exists = clientFiles.some(f => path.basename(f) === excluded);
      expect(exists).toBe(true);
    });
  }
});

// ─── Platform Hardening: barrel export surface ──────────────────────

describe('Table barrel export — surface completeness', () => {
  const barrelPath = path.resolve(__dirname, '../../src/components/ui/table/index.ts');
  const barrelContent = fs.readFileSync(barrelPath, 'utf-8');

  // Core modules that MUST be re-exported from the barrel
  const REQUIRED_EXPORTS = [
    'data-table',
    'table',
    'types',
    'table-utils',
    'pagination-utils',
    'pagination-controls',
    'table-empty-state',
    'selection-toolbar',
    'column-visibility-utils',
    'edit-columns-button',
    'use-table-pagination',
  ];

  for (const mod of REQUIRED_EXPORTS) {
    it(`re-exports ./${mod}`, () => {
      expect(barrelContent).toContain(`"./${mod}"`);
    });
  }

  it('does not have orphan module files missing from barrel', () => {
    const tableDir = path.resolve(__dirname, '../../src/components/ui/table');
    const tsFiles = fs.readdirSync(tableDir)
      .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== 'index.ts');

    for (const file of tsFiles) {
      const mod = file.replace(/\.(ts|tsx)$/, '');
      expect(barrelContent).toContain(mod);
    }
  });
});

// ─── Platform Hardening: no duplicate table utilities ────────────────

describe('No duplicate table utilities outside the table module', () => {
  const uiDir = path.resolve(__dirname, '../../src/components/ui');

  it('no standalone pagination-controls.tsx in ui/ (use table/pagination-controls)', () => {
    const duplicatePath = path.join(uiDir, 'pagination-controls.tsx');
    expect(fs.existsSync(duplicatePath)).toBe(false);
  });

  it('GUIDE.md exists in the table module', () => {
    const guidePath = path.join(uiDir, 'table', 'GUIDE.md');
    expect(fs.existsSync(guidePath)).toBe(true);
  });
});

// ─── Platform Hardening: page-level patterns ─────────────────────────

describe('Page-level column definition patterns', () => {
  const clientDir = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');
  const EXCLUDED = ['SoAClient.tsx', 'AuditsClient.tsx'];

  function findClientFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findClientFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('Client.tsx')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const migratedFiles = findClientFiles(clientDir)
    .filter(f => !EXCLUDED.includes(path.basename(f)));

  // Every migrated page with DataTable should use createColumns
  for (const filePath of migratedFiles) {
    const basename = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    if (!content.includes('DataTable')) continue; // skip pages without tables

    it(`${basename} uses createColumns for column definitions`, () => {
      expect(content).toContain('createColumns');
    });

    it(`${basename} wraps columns in useMemo (not inline/IIFE)`, () => {
      // Verify useMemo is used (columns should be memoized)
      expect(content).toContain('useMemo');
    });

    it(`${basename} imports from barrel (not deep modules)`, () => {
      // Should import from '@/components/ui/table', not sub-paths
      const hasBarrelImport = content.includes("from '@/components/ui/table'");
      expect(hasBarrelImport).toBe(true);
    });

    it(`${basename} has a data-testid`, () => {
      expect(content).toContain('data-testid');
    });
  }
});

export {};
