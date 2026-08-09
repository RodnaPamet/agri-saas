/**
 * Epic 53 — typed filter contract model.
 *
 * Complements:
 *   - `filter-system.test.ts`    — pure URL/state functions
 *   - `filter-foundation.test.ts` — module layout & barrel surface
 *
 * This suite locks the *contract*:
 *   1. Contract sanity — group, description, resetBehavior flow through
 *      `createFilterDefs` unchanged and land on the resolved Filter shape.
 *   2. Roundtrip serialisation — the three canonical filter kinds
 *      (enum/status, entity-ref, range) all survive URL encode → decode.
 *   3. Compile-time type safety — the typed factory narrows keys to a literal
 *      union; the codec helpers preserve value types.
 */

import {
  addFilterValue,
  filterStateToUrlParams,
  parseUrlToFilterState,
  type FilterState,
} from '../../src/components/ui/filter/filter-state';
import {
  booleanCodec,
  codecForExampleValue,
  createFilterDefs,
  createTypedFilterDefs,
  numberCodec,
  stringCodec,
  typedOptionsFromEnum,
} from '../../src/components/ui/filter/filter-definitions';
import {
  encodeRangeToken,
  parseRangeToken,
  type TypedActiveFilter,
  type TypedFilterOption,
} from '../../src/components/ui/filter/types';
import {
  EXAMPLE_FILTER_DEFS,
  ownerOptionsFromEntities,
  statusTypedOptions,
  type PracticeStatus,
  type OwnerReference,
} from '../../src/components/ui/filter/filter-examples';
import { CircleDot, Flag, Activity } from 'lucide-react';

// ─── 1. Contract sanity ──────────────────────────────────────────────

describe('Filter contract — extended fields (group/description/resetBehavior)', () => {
  it('propagates `group`, `description`, and `resetBehavior` through createFilterDefs', () => {
    const { getFilter } = createFilterDefs({
      status: {
        label: 'Status',
        description: 'Lifecycle state',
        group: 'Attributes',
        resetBehavior: 'clearable',
        icon: CircleDot,
        options: [{ value: 'OPEN', label: 'Open' }],
      },
    });

    const f = getFilter('status')!;
    expect(f.description).toBe('Lifecycle state');
    expect(f.group).toBe('Attributes');
    expect(f.resetBehavior).toBe('clearable');
  });

  it('treats omitted fields as undefined (no accidental defaults)', () => {
    const { getFilter } = createFilterDefs({
      category: {
        label: 'Category',
        icon: Flag,
        options: [{ value: 'A', label: 'A' }],
      },
    });

    const f = getFilter('category')!;
    expect(f.group).toBeUndefined();
    expect(f.description).toBeUndefined();
    expect(f.resetBehavior).toBeUndefined();
  });

  it('accepts the three documented resetBehavior values', () => {
    const { defs } = createFilterDefs({
      a: { label: 'a', icon: Flag, options: [], resetBehavior: 'clearable' },
      b: { label: 'b', icon: Flag, options: [], resetBehavior: 'sticky' },
      c: { label: 'c', icon: Flag, options: [], resetBehavior: 'resetsToDefault' },
    });
    expect(defs.a.resetBehavior).toBe('clearable');
    expect(defs.b.resetBehavior).toBe('sticky');
    expect(defs.c.resetBehavior).toBe('resetsToDefault');
  });
});

// ─── 2. Typed factory — literal key narrowing ────────────────────────

describe('createTypedFilterDefs — literal-narrowed keys', () => {
  const build = createTypedFilterDefs<{ status: string; priority: number }>();
  const bundle = build({
    status: {
      label: 'Status',
      icon: CircleDot,
      options: [{ value: 'OPEN', label: 'Open' }],
    },
    priority: {
      label: 'Priority',
      icon: Flag,
      options: [{ value: 'HIGH', label: 'High' }],
    },
  });

  it('produces a filters array containing every declared key', () => {
    const keys = bundle.filters.map((f) => f.key).sort();
    expect(keys).toEqual(['priority', 'status']);
  });

  it('exposes filterKeys narrowed to the declared literal union', () => {
    // Runtime behavior: filterKeys is an array; type side is literal-narrowed.
    // We assert behavior here; the type-narrowing is verified by tsc.
    expect([...bundle.filterKeys].sort()).toEqual(['priority', 'status']);
  });

  it('throws on getFilter() for an unknown key (defence for runtime misuse)', () => {
    // The typed API rejects this at compile time, but runtime callers coming
    // from untyped code paths (e.g. URL query params) may still hit it.
    // Using `as any` here is intentional — simulates a runtime-unsafe call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (bundle.getFilter as any)('does-not-exist')).toThrow(
      /unknown filter key "does-not-exist"/,
    );
  });

  it('getFilter returns the same FilterDef instance as bundle.defs[key]', () => {
    expect(bundle.getFilter('status')).toBe(bundle.defs.status);
  });

  // Type-level assertion — validated by `tsc --noEmit`. If someone ever
  // widens filterKeys back to `string[]`, this line fails to compile.
  it('filterKeys entries are typed as the declared literal union', () => {
    type Keys = (typeof bundle.filterKeys)[number];

    const _assert: Keys extends 'status' | 'priority' ? true : false = true;
    expect(_assert).toBe(true);
  });
});

// ─── 3. Codec roundtrips ─────────────────────────────────────────────

describe('Filter value codecs', () => {
  it('stringCodec is identity', () => {
    expect(stringCodec.encode('OPEN')).toBe('OPEN');
    expect(stringCodec.decode('OPEN')).toBe('OPEN');
  });

  it('numberCodec roundtrips finite numbers and rejects NaN', () => {
    expect(numberCodec.encode(42)).toBe('42');
    expect(numberCodec.decode('42')).toBe(42);
    expect(numberCodec.decode('3.14')).toBeCloseTo(3.14);
    expect(numberCodec.decode('not-a-number')).toBeNull();
  });

  it('booleanCodec encodes readable form and accepts legacy "1"/"0"', () => {
    expect(booleanCodec.encode(true)).toBe('true');
    expect(booleanCodec.encode(false)).toBe('false');
    expect(booleanCodec.decode('true')).toBe(true);
    expect(booleanCodec.decode('false')).toBe(false);
    expect(booleanCodec.decode('1')).toBe(true);
    expect(booleanCodec.decode('0')).toBe(false);
    expect(booleanCodec.decode('maybe')).toBeNull();
  });

  it('codecForExampleValue resolves the right codec from a sample value', () => {
    // Cast the sample to the base type so the returned codec's generic widens
    // from the string literal to `string` — otherwise `encode('y')` would be a
    // type error against the literal-narrowed codec.
    expect(codecForExampleValue('x' as string).encode('y')).toBe('y');
    expect(codecForExampleValue(0 as number).decode('5')).toBe(5);
    expect(codecForExampleValue(false as boolean).decode('true')).toBe(true);
  });

  it('codecForExampleValue throws for unsupported primitives', () => {
    // @ts-expect-error — testing runtime fallback for TypeScript-invalid input
    expect(() => codecForExampleValue(Symbol('x'))).toThrow();
  });
});

// ─── 4. Representative examples (enum, entity-ref, range) ────────────

describe('Example filter definitions', () => {
  it('exposes a status enum filter grouped under Attributes', () => {
    const status = EXAMPLE_FILTER_DEFS.status;
    expect(status.label).toBe('Status');
    expect(status.group).toBe('Attributes');
    expect(status.resetBehavior).toBe('clearable');
    // Enum-backed options — values are the enum members.
    const values = (status.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(
      ['IMPLEMENTED', 'IMPLEMENTING', 'IN_PROGRESS', 'NEEDS_REVIEW', 'NOT_APPLICABLE', 'NOT_STARTED', 'PLANNED'].sort(),
    );
  });

  it('typedOptionsFromEnum preserves the value type at compile time', () => {
    // Compile-time: the array's value type is PracticeStatus, not `string`.
    const first = statusTypedOptions[0];
    const take: PracticeStatus = first.value;
    expect(['NOT_STARTED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTING',
            'IMPLEMENTED', 'NEEDS_REVIEW', 'NOT_APPLICABLE']).toContain(take);
  });

  it('owner entity-ref filter has null options (async-loaded) and multi-select enabled', () => {
    const owner = EXAMPLE_FILTER_DEFS.owner;
    expect(owner.options).toBeNull();
    expect(owner.multiple).toBe(true);
    // Server-filtered — disable cmdk's local filter.
    expect(owner.shouldFilter).toBe(false);
  });

  it('ownerOptionsFromEntities maps entities with a friendly displayLabel', () => {
    const owners: OwnerReference[] = [
      { id: 'u1', name: 'Ada Lovelace', email: 'ada@acme.com' },
      { id: 'u2', name: 'Linus Torvalds', email: 'linus@acme.com' },
    ];
    const opts = ownerOptionsFromEntities(owners);
    expect(opts[0]).toEqual({
      value: 'u1',
      label: 'Ada Lovelace — ada@acme.com',
      displayLabel: 'Ada Lovelace',
    });
    // The mapped options carry the original ID as `value` — round-trippable.
    expect(opts.map((o) => o.value)).toEqual(['u1', 'u2']);
  });

  it('risk score range filter hides the IS/IS_NOT operator and scales display values', () => {
    const range = EXAMPLE_FILTER_DEFS.riskScore;
    expect(range.type).toBe('range');
    expect(range.hideOperator).toBe(true);
    expect(range.rangeDisplayScale).toBe(10);
    expect(range.formatRangeBound?.(50)).toBe('5.0');
    expect(range.formatRangePillLabel?.('30|70')).toBe('Score 3.0–7.0');
    expect(range.formatRangePillLabel?.('|50')).toBe('Score —–5.0');
  });
});

// ─── 5. Active-state URL roundtrip across all three filter kinds ─────

describe('Active-state URL serialisation roundtrip', () => {
  it('enum/status values roundtrip through URL → state → URL', () => {
    const keys = ['status'];
    const url = 'status=OPEN,CLOSED';
    const state = parseUrlToFilterState(url, keys);
    expect(state).toEqual({ status: ['OPEN', 'CLOSED'] });

    const params = filterStateToUrlParams(state);
    expect(params.get('status')).toBe('OPEN,CLOSED');
  });

  it('entity-ref IDs roundtrip with a typed active filter', () => {
    const active: TypedActiveFilter<'owner', string> = {
      key: 'owner',
      values: ['u1', 'u2'],
      operator: 'IS_ONE_OF',
    };
    // Simulate the state layer — typed wrapper simply lines up under the hood.
    // setFilterValue takes a single value; addFilterValue accepts arrays, which
    // matches a multi-select active filter's persisted shape.
    const state: FilterState = addFilterValue({}, active.key, active.values);
    const params = filterStateToUrlParams(state);
    expect(params.get('owner')).toBe('u1,u2');

    const decoded = parseUrlToFilterState(params, ['owner']);
    expect(decoded).toEqual({ owner: ['u1', 'u2'] });
  });

  it('range values roundtrip through encodeRangeToken → parseRangeToken', () => {
    // Store: score 30–70 (display: 3.0–7.0 after scale=10)
    const token = encodeRangeToken(30, 70);
    expect(token).toBe('30|70');

    const state = addFilterValue({}, 'riskScore', token);
    const params = filterStateToUrlParams(state);
    expect(params.get('riskScore')).toBe('30|70');

    const parsed = parseRangeToken(params.get('riskScore'));
    expect(parsed).toEqual({ min: 30, max: 70 });
  });

  it('open-ended range tokens preserve the missing bound on roundtrip', () => {
    expect(parseRangeToken(encodeRangeToken(undefined, 70))).toEqual({ max: 70 });
    expect(parseRangeToken(encodeRangeToken(30, undefined))).toEqual({ min: 30 });
    expect(parseRangeToken(encodeRangeToken(undefined, undefined))).toEqual({});
  });
});

// ─── 6. Generic reach — typed active filter shape holds across entities ──

describe('TypedActiveFilter<K, V> — generics work for every represented entity', () => {
  // Purely compile-time. Runtime just checks the structural shape exists.
  it('narrows V to string enums (practices)', () => {
    const f: TypedActiveFilter<'status', PracticeStatus> = {
      key: 'status',
      values: ['IN_PROGRESS'],
      operator: 'IS',
    };
    expect(f.values[0]).toBe('IN_PROGRESS');
  });

  it('narrows V to string IDs (entity-ref)', () => {
    const f: TypedActiveFilter<'owner', string> = {
      key: 'owner',
      values: ['u1', 'u2'],
      operator: 'IS_ONE_OF',
    };
    expect(f.values.length).toBe(2);
  });

  it('narrows V to numbers (range-like scalar filters)', () => {
    const f: TypedActiveFilter<'score', number> = {
      key: 'score',
      values: [42],
      operator: 'IS',
    };
    expect(f.values[0]).toBe(42);
  });
});

// ─── 7. TypedFilterOption.displayLabel is the pill override ──────────

describe('TypedFilterOption.displayLabel', () => {
  it('is optional and falls back to label', () => {
    const opt: TypedFilterOption<string> = { value: 'x', label: 'Long picker label' };
    expect(opt.displayLabel).toBeUndefined();
    expect(opt.label).toBe('Long picker label');
  });

  it('carries a separate string when the pill should read differently', () => {
    const opt: TypedFilterOption<string> = {
      value: 'u1',
      label: 'Ada Lovelace — ada@acme.com',
      displayLabel: 'Ada Lovelace',
    };
    expect(opt.displayLabel).toBe('Ada Lovelace');
  });
});

// ─── 8. typedOptionsFromEnum icon plumbing ───────────────────────────

describe('typedOptionsFromEnum', () => {
  it('stamps the provided icon on every option', () => {
    const opts = typedOptionsFromEnum(
      { LOW: 'Low', HIGH: 'High' } as const,
      Activity,
    );
    for (const o of opts) {
      expect(o.icon).toBe(Activity);
    }
  });

  it('omits the icon when none is provided', () => {
    const opts = typedOptionsFromEnum({ A: 'A', B: 'B' } as const);
    for (const o of opts) {
      expect(o.icon).toBeUndefined();
    }
  });
});
