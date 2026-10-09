/**
 * Report script: counts the `any`-debt patterns in `src/`.
 * Run: npm run count-any
 *
 * This does NOT fail the build — it outputs metrics. The gate is
 * `tests/guards/no-explicit-any-ratchet.test.ts`, and it reads the SAME
 * `countAll` this does (`scripts/lib/any-patterns.ts`), so the number printed
 * here is the number CI enforces. It used to be a second implementation with
 * its own regexes and its own walk, which is how `as any` came to be counted
 * one way by the gate and another way by the guardrail — see #1526.
 *
 * Was `scripts/count-any.js` (CommonJS, run with bare `node`). It is `.ts` run
 * through `tsx` now for one reason: so it can import the shared module, the
 * same shape as `scripts/generate-route-inventory.ts` importing
 * `scripts/lib/api-routes.ts`.
 */
import { ANY_PATTERNS, countAll } from './lib/any-patterns';

console.log('=== any / ts-ignore Usage Report ===\n');

const { totals, filesScanned } = countAll();

let totalAll = 0;
for (const { label } of ANY_PATTERNS) {
    console.log(`  ${label.padEnd(20)} ${String(totals[label]).padStart(4)}`);
    totalAll += totals[label];
}

console.log(`  ${'─'.repeat(25)}`);
console.log(`  ${'TOTAL'.padEnd(20)} ${String(totalAll).padStart(4)}`);
console.log(`\nScanned ${filesScanned} files in src/`);
console.log('Tip: This count should decrease over time as DTOs replace any.\n');
