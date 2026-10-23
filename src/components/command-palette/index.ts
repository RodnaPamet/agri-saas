/**
 * ## Do NOT import this barrel from the app shell — #2225
 *
 * It re-exports `CommandPalette`, which pulls `cmdk`,
 * `@radix-ui/react-dialog` and `@radix-ui/react-visually-hidden`, alongside
 * `CommandPaletteProvider`, which imports only `react` and the shortcut hook.
 * So importing it for the PROVIDER drags the heavy module into the importer's
 * chunk — and when the importer was `src/app/providers.tsx`, into the ROOT
 * LAYOUT's chunk, which ships to `/f/{handle}`: a page a stranger opens from a
 * shared link, which never renders the palette at all.
 *
 * Measured on a real public-farm page load: `cmdk` arrived in
 * `layout-<hash>.js` itself. `providers.tsx` now imports the provider from its
 * own module and the palette through `next/dynamic`.
 *
 * This barrel remains for the three rendered suites that import both halves
 * together, where a single chunk is exactly what is wanted.
 */
export { CommandPalette } from './command-palette';
export {
    CommandPaletteProvider,
    useCommandPalette,
    type CommandPaletteApi,
} from './command-palette-provider';
