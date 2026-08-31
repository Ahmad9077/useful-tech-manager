interface Env {
  DB: D1Database;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  PHASE2_CONTROL_SECRET: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

interface TokenRow {
  open_id: string;
  access_ciphertext: string;
  refresh_ciphertext: string;
  access_expires_at: number;
  refresh_expires_at: number;
  granted_scopes: string;
}

const TIKTOK_API = "https://open.tiktokapis.com";
const SCOPES = ["user.info.basic", "user.info.stats", "video.list", "video.upload", "video.publish"];
const AUTH_TTL_SECONDS = 10 * 60;
const TOKEN_TIMEOUT_MS = 25_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
      if (request.method === "GET" && url.pathname === "/auth/tiktok/start") return await beginOAuth(request, env);
      if (request.method === "GET" && url.pathname === "/auth/tiktok/callback") return await finishOAuth(request, env);
      if (request.method === "POST" && url.pathname === "/internal/access-token") return await currentAccessToken(request, env);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const known = error as { status?: unknown; message?: unknown };
      return json({ error: typeof known.message === "string" ? known.message : "Unexpected server error" }, typeof known.status === "number" ? known.status : 500);
    }
  }
};

class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function now(): number { return Math.floor(Date.now() / 1000); }
function origin(request: Request): string { return new URL(request.url).origin; }
function callbackUri(request: Request): string { return `${origin(request)}/auth/tiktok/callback`; }
function secureHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return headers;
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: secureHeaders({ "content-type": "application/json; charset=utf-8" }) }); }
function html(value: string): Response { return new Response(value, { headers: secureHeaders({ "content-type": "text/html; charset=utf-8" }) }); }
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}
function randomUrl(bytes = 32): string { return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes))); }
async function digest(value: string): Promise<string> { return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function cookie(name: string, value: string, maxAge: number): string { return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`; }
function expireCookie(name: string): string { return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`; }
function getCookie(request: Request, name: string): string | null { return (request.headers.get("cookie") || "").split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || null; }
function requireConfigured(env: Env): void { if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.PHASE2_CONTROL_SECRET) throw new AppError("Sandbox OAuth is not configured.", 503); }

async function beginOAuth(request: Request, env: Env): Promise<Response> {
  requireConfigured(env);
  const state = randomUrl();
  const verifier = randomUrl();
  await env.DB.prepare("DELETE FROM auth_transactions WHERE expires_at <= ?").bind(now()).run();
  await env.DB.prepare("INSERT INTO auth_transactions (state_hash, cookie_hash, expires_at) VALUES (?, ?, ?)").bind(await digest(state), await digest(verifier), now() + AUTH_TTL_SECONDS).run();
  const auth = new URL("https://www.tiktok.com/v2/auth/authorize/");
  auth.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPES.join(","));
  auth.searchParams.set("redirect_uri", callbackUri(request));
  auth.searchParams.set("state", state);
  const headers = secureHeaders({ location: auth.toString() });
  headers.set("set-cookie", cookie("__Host-utm-phase2-oauth", verifier, AUTH_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

async function finishOAuth(request: Request, env: Env): Promise<Response> {
  requireConfigured(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const verifier = getCookie(request, "__Host-utm-phase2-oauth");
  if (!state || !code || !verifier) throw new AppError("TikTok authorization could not be verified.", 400);
  const consumed = await env.DB.prepare("DELETE FROM auth_transactions WHERE state_hash = ? AND cookie_hash = ? AND expires_at > ?").bind(await digest(state), await digest(verifier), now()).run();
  if (!consumed.meta.changes) throw new AppError("TikTok authorization has expired or was already used.", 400);
  const token = await tokenRequest(new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: callbackUri(request) }));
  if (!token.open_id || !token.access_token || !token.refresh_token) throw new AppError("TikTok returned an incomplete authorization response.", 502);
  await saveTokens(env, String(token.open_id), token);
  const headers = secureHeaders({ "set-cookie": expireCookie("__Host-utm-phase2-oauth") });
  return new Response("<!doctype html><meta charset=\"utf-8\"><title>Useful Tech Manager</title><p>TikTok Sandbox connected. You can return to Useful Tech Manager.</p>", { headers });
}

async function currentAccessToken(request: Request, env: Env): Promise<Response> {
  requireConfigured(env);
  const payload = await request.json<{ proof?: unknown }>().catch(() => ({}));
  const supplied = typeof payload.proof === "string" ? payload.proof : "";
  if (!supplied || !(await controlSecretMatches(supplied, env.PHASE2_CONTROL_SECRET))) throw new AppError("Unauthorized", 401);
  const row = await env.DB.prepare("SELECT open_id, access_ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, granted_scopes FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1").first<TokenRow>();
  if (!row) throw new AppError("TikTok Sandbox authorization is required.", 401);
  const token = await accessToken(env, row);
  return json({ open_id: row.open_id, access_token: token, scopes: row.granted_scopes.split(",").filter(Boolean) });
}

async function controlSecretMatches(supplied: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}
async function tokenRequest(form: URLSearchParams): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(`${TIKTOK_API}/v2/oauth/token/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: controller.signal });
    const payload = await response.json<Record<string, unknown>>().catch(() => ({}));
    if (!response.ok || payload.error) throw new AppError("TikTok token exchange was not accepted.", 502);
    return payload;
  } finally { clearTimeout(timeout); }
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(env.TOKEN_ENCRYPTION_KEY);
  if (bytes.byteLength !== 32) throw new AppError("Secure token storage is not configured correctly.", 503);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(env: Env, value: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await encryptionKey(env), new TextEncoder().encode(value)));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(cipher)}`;
}
async function decrypt(env: Env, encoded: string, aad: string): Promise<string> {
  const [iv, cipher] = encoded.split(".");
  if (!iv || !cipher) throw new AppError("Stored TikTok connection is invalid.", 401);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: new TextEncoder().encode(aad) }, await encryptionKey(env), base64UrlToBytes(cipher)));
}
async function saveTokens(env: Env, openId: string, token: Record<string, unknown>, previous?: TokenRow): Promise<void> {
  const access = String(token.access_token || "");
  const refresh = String(token.refresh_token || "");
  if (!access || !refresh) throw new AppError("TikTok returned unusable tokens.", 502);
  const expires = Math.max(60, Number(token.expires_in || 86400));
  const refreshExpires = Math.max(60, Number(token.refresh_expires_in || 31536000));
  await env.DB.prepare("INSERT INTO oauth_tokens (open_id, access_ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, granted_scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(open_id) DO UPDATE SET access_ciphertext=excluded.access_ciphertext, refresh_ciphertext=excluded.refresh_ciphertext, access_expires_at=excluded.access_expires_at, refresh_expires_at=excluded.refresh_expires_at, granted_scopes=excluded.granted_scopes, updated_at=excluded.updated_at")
    .bind(openId, await encrypt(env, access, `access:${openId}`), await encrypt(env, refresh, `refresh:${openId}`), now() + expires, now() + refreshExpires, String(token.scope || previous?.granted_scopes || ""), now()).run();
}
async function accessToken(env: Env, row: TokenRow): Promise<string> {
  if (row.access_expires_at > now() + 60) return decrypt(env, row.access_ciphertext, `access:${row.open_id}`);
  if (row.refresh_expires_at <= now()) throw new AppError("TikTok Sandbox authorization has expired. Reconnect it in the Sandbox.", 401);
  const refresh = await decrypt(env, row.refresh_ciphertext, `refresh:${row.open_id}`);
  const renewed = await tokenRequest(new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refresh }));
  await saveTokens(env, row.open_id, { ...renewed, refresh_token: renewed.refresh_token || refresh }, { ...row, refresh_ciphertext: row.refresh_ciphertext });
  return String(renewed.access_token);
}
