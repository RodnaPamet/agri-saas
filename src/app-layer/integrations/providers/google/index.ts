/**
 * Google integration barrel — #2005.
 *
 * Mirrors `providers/sharepoint/index.ts`: routes and usecases import from
 * here rather than reaching into the module files, so the connect flow's
 * surface is one place to read.
 */
export {
    GOOGLE_PROVIDER,
    GOOGLE_CONNECTION_NAME,
    GOOGLE_SCOPES,
    GOOGLE_DRIVE_SCOPE,
    GOOGLE_CALENDAR_SCOPE,
    buildGoogleAuthorizeUrl,
    exchangeCodeForGoogleToken,
    resolveGoogleAccessToken,
    grantedProducts,
    type GoogleSecret,
} from './token';

export {
    GOOGLE_INTEGRATION_FLAG,
    completeGoogleConnect,
    resolveGoogleConnectionToken,
    listGoogleConnections,
    disconnectGoogle,
    type GoogleConfigJson,
} from './service';
