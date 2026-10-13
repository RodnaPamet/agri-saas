/**
 * Would installing this app change whether the browser keeps unsent work?
 *
 * The same question `installingWouldPersist()` answers, asked from a component
 * without an effect.
 *
 * ## Why this is not `useState` + `useEffect`
 *
 * Both callers had:
 *
 * ```tsx
 * // Post-mount: `navigator.userAgent` and `matchMedia` are client-only, and
 * // reading either during render would mismatch the server's markup.
 * const [showInstallHint, setShowInstallHint] = useState(false);
 * useEffect(() => { setShowInstallHint(installingWouldPersist()); }, []);
 * ```
 *
 * That comment is correct and is the reason the effect existed — this hook
 * does not overturn it. What it changes is the mechanism: `react-hooks/
 * set-state-in-effect` flags `setState` in an effect body because it causes a
 * cascading render, and `useSyncExternalStore` is what React added for exactly
 * this case. It reads `getServerSnapshot` while hydrating and `getSnapshot`
 * after, so the server/client difference is handled by the hook rather than by
 * a render the component triggers on itself.
 *
 * Same visible outcome, one fewer render, and no `setState` during an effect.
 * Refs #1471.
 *
 * ## The no-op `subscribe`, stated rather than hidden
 *
 * `useSyncExternalStore`'s first argument exists to re-read a store that
 * changes. This value cannot change within a session: `isIos()` reads a
 * user-agent string, and `isStandalone()` reads `(display-mode: standalone)`,
 * which on iOS is decided at launch — a Home Screen app starts standalone and
 * a tab stays a tab. So there is nothing to subscribe to and `subscribe`
 * returns a no-op unsubscribe.
 *
 * Subscribing to the media query would be the more impressive implementation
 * and would never fire. It is left out deliberately so the next reader does
 * not assume reactivity that was never there.
 *
 * ## Why the server snapshot is `false`
 *
 * The server has no user agent and no display mode, so it cannot answer. The
 * honest server answer is "do not claim iOS", which renders no install hint —
 * exactly what the `useState(false)` initial value did.
 */
import { useSyncExternalStore } from 'react';

import { installingWouldPersist } from './display-mode';

/** Nothing to subscribe to — see the docblock. */
const subscribe = (): (() => void) => () => {};

/** The server cannot know, so it must not claim iOS. */
const getServerSnapshot = (): boolean => false;

export function useInstallingWouldPersist(): boolean {
    return useSyncExternalStore(subscribe, installingWouldPersist, getServerSnapshot);
}
