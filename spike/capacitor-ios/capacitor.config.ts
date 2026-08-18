import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the THROWAWAY iOS spike.
 *
 * `server.url` mode is FORCED, not chosen. The app cannot be statically
 * exported (no `output` key in next.config.js; 30/69 tenant pages resolve
 * tenant context server-side via getTenantCtx; 27/69 are force-dynamic;
 * 41/69 are async server components), so Capacitor's usual
 * bundle-and-serve-from-capacitor:// model would require re-architecting
 * ~30 server components — most of a rewrite.
 *
 * Consequence to measure, not to paper over: nothing is bundled locally, so
 * an offline cold launch has no local shell to fall back on. Whether the
 * existing service worker rescues that is the sharpest question in the spike.
 */
const SERVER_URL = process.env.SPIKE_SERVER_URL ?? 'https://35-187-80-26.sslip.io';

const config: CapacitorConfig = {
    appId: 'bg.agrent.spike',
    appName: 'Agrent Spike',

    // Nothing is served from here in server.url mode. The CLI requires the
    // directory to exist; it is deliberately not the Next build output,
    // because bundling the app is exactly the option unavailable to us.
    webDir: 'webdir-placeholder',

    server: {
        url: SERVER_URL,
        // https only. The auth test is meaningless against http: NextAuth's
        // cookies are Secure by framework default, so a cleartext origin
        // would silently drop the session and we would "discover" a bug that
        // only exists in the test rig.
        cleartext: false,

        // REQUIRED for sign-in, and the reason is a finding in its own right.
        // Production sets AUTH_CREDENTIALS_UI_HIDDEN=1, so the email/password
        // form is hidden and real operators sign in with Google or Microsoft
        // Entra. Those navigations leave the app's origin, and Capacitor
        // blocks off-origin navigation unless it is listed here.
        //
        // Listing them is necessary but may not be sufficient — see the
        // "Predicted failure: OAuth in an embedded webview" section of
        // README.md before spending device time on this.
        allowNavigation: [
            'accounts.google.com',
            'login.microsoftonline.com',
            'login.live.com',
        ],
    },

    ios: {
        // The app has its own safe-area handling in AppShell; letting the
        // webview also inset would double-pad every screen and would be
        // mistaken for a layout bug in the web app.
        contentInset: 'never',
    },
};

export default config;
