import { keychainSecret } from './secrets.mjs';

const USER_AGENT = 'Useful-Tech-Manager-Phase2/1.0';

/** Retrieves a short-lived Sandbox access token from the dedicated encrypted OAuth worker. */
export function sandboxAccessTokenProvider(config, fetcher = fetch) {
  const { oauthWorkerUrl, controlKeychainService, controlKeychainAccount } = config.tiktokSandbox;
  if (!oauthWorkerUrl || !controlKeychainService || !controlKeychainAccount) throw new Error('TikTok Sandbox OAuth worker is not configured');
  const endpoint = new URL('/internal/access-token', oauthWorkerUrl).toString();
  return async () => {
    const proof = keychainSecret(controlKeychainService, controlKeychainAccount);
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ proof }),
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) throw new Error(`TikTok Sandbox token retrieval failed (${response.status})`);
    return payload.access_token;
  };
}
