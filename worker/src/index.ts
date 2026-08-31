import { managerAppPage } from "./app-page";

interface Env {
  DB: D1Database;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

const TIKTOK_API = "https://open.tiktokapis.com";
const OAUTH_SCOPES = ["user.info.basic", "user.info.stats", "video.list", "video.upload", "video.publish"];
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
      if (request.method === "GET" && url.pathname === "/") return Response.redirect(new URL("/app", url), 302);
      if (request.method === "GET" && url.pathname === "/app") return html(managerAppPage());
      if (request.method === "GET" && url.pathname === "/auth/tiktok/start") return beginOAuth(request, env);
      if (request.method === "GET" && url.pathname === "/auth/tiktok/callback") return finishOAuth(request, env);
      if (request.method === "GET" && url.pathname === "/api/dashboard") return dashboard(request, env);
      if (request.method === "POST" && url.pathname === "/api/creator-info") return creatorInfo(request, env);
      if (request.method === "POST" && url.pathname === "/api/publish") return publishVideo(request, env);
      if (request.method === "GET" && url.pathname === "/api/publish/status") return postStatus(request, env, url);
      if (request.method === "POST" && url.pathname === "/api/disconnect") return disconnect(request, env);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      return json({ error: error instanceof AppError ? error.message : "Unexpected server error" }, status);
    }
  }
};

class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function now(): number { return Math.floor(Date.now() / 1000); }
function redirectUri(request: Request): string { return `${new URL(request.url).origin}/auth/tiktok/callback`; }
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: secureHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }) });
}
function html(body: string): Response {
  return new Response(body, { headers: secureHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }) });
}
function secureHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return headers;
}
function randomUrl(bytes = 32): string { return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes))); }
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function hash(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function getCookie(request: Request, name: string): string | null {
  const value = request.headers.get("cookie") || "";
  return value.split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}
function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
function expireCookie(name: string): string { return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`; }
function requireConfigured(env: Env): void {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) throw new AppError("TikTok connection is not configured yet.", 503);
}

async function beginOAuth(request: Request, env: Env): Promise<Response> {
  requireConfigured(env);
  const state = randomUrl();
  const verifier = randomUrl();
  await env.DB.prepare("DELETE FROM auth_transactions WHERE expires_at <= ?").bind(now()).run();
  await env.DB.prepare("INSERT INTO auth_transactions (state_hash, cookie_hash, requested_scopes, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hash(state), await hash(verifier), OAUTH_SCOPES.join(","), now() + OAUTH_SECONDS).run();
  const auth = new URL("https://www.tiktok.com/v2/auth/authorize/");
  auth.searchParams.set("client_key", env.TIKTOK_CLIENT_KEY);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", OAUTH_SCOPES.join(","));
  auth.searchParams.set("redirect_uri", redirectUri(request));
  auth.searchParams.set("state", state);
  const headers = new Headers({ location: auth.toString() });
  headers.set("set-cookie", cookie("__Host-utm_oauth", verifier, OAUTH_SECONDS));
  return new Response(null, { status: 302, headers });
}

async function finishOAuth(request: Request, env: Env): Promise<Response> {
  requireConfigured(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const verifier = getCookie(request, "__Host-utm_oauth");
  if (!state || !code || !verifier) throw new AppError("TikTok authorization could not be verified. Please return to the app and try again.", 400);
  const consumed = await env.DB.prepare("DELETE FROM auth_transactions WHERE state_hash = ? AND cookie_hash = ? AND expires_at > ?")
    .bind(await hash(state), await hash(verifier), now()).run();
  if (!consumed.meta.changes) throw new AppError("TikTok authorization could not be verified. Please return to the app and try again.", 400);
  const form = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(request)
  });
  const token = await tokenRequest(form);
  if (!token.open_id || !token.access_token || !token.refresh_token) throw new AppError("TikTok returned an incomplete authorization response.", 502);
  await saveTokens(env, token.open_id, token);
  const session = randomUrl();
  const csrf = randomUrl();
  await env.DB.prepare("INSERT INTO sessions (session_hash, open_id, csrf_token, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await hash(session), token.open_id, csrf, await hash(csrf), now() + SESSION_SECONDS).run();
  const headers = new Headers({ location: new URL("/app#connected", request.url).toString() });
  headers.append("set-cookie", expireCookie("__Host-utm_oauth"));
  headers.append("set-cookie", cookie("__Host-utm_session", session, SESSION_SECONDS));
  return new Response(null, { status: 302, headers });
}

async function tokenRequest(form: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(`${TIKTOK_API}/v2/oauth/token/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new AppError("TikTok token exchange failed. Please try connecting again.", 502);
  const data = await response.json<Record<string, unknown>>();
  if (data.error) throw new AppError("TikTok token exchange was not accepted.", 502);
  return data;
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = base64UrlToBytes(env.TOKEN_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new AppError("Secure token storage is not configured correctly.", 503);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(env: Env, value: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await encryptionKey(env), new TextEncoder().encode(value)));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(cipher)}`;
}
async function decrypt(env: Env, value: string, aad: string): Promise<string> {
  const [iv, cipher] = value.split(".");
  if (!iv || !cipher) throw new AppError("Stored TikTok connection is invalid. Please reconnect.", 401);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: new TextEncoder().encode(aad) }, await encryptionKey(env), base64UrlToBytes(cipher)));
}
async function saveTokens(env: Env, openId: string, token: Record<string, unknown>, previous?: TokenRow): Promise<void> {
  const access = String(token.access_token || "");
  const refresh = String(token.refresh_token || previous?.refresh_token || "");
  if (!access || !refresh) throw new AppError("TikTok did not return a usable connection token.", 502);
  const expires = Math.max(60, Number(token.expires_in || 86400));
  const refreshExpires = Math.max(60, Number(token.refresh_expires_in || 31536000));
  await env.DB.prepare("INSERT INTO oauth_tokens (open_id, access_ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, granted_scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(open_id) DO UPDATE SET access_ciphertext=excluded.access_ciphertext, refresh_ciphertext=excluded.refresh_ciphertext, access_expires_at=excluded.access_expires_at, refresh_expires_at=excluded.refresh_expires_at, granted_scopes=excluded.granted_scopes, updated_at=excluded.updated_at")
    .bind(openId, await encrypt(env, access, `access:${openId}`), await encrypt(env, refresh, `refresh:${openId}`), now() + expires, now() + refreshExpires, String(token.scope || previous?.granted_scopes || ""), now()).run();
}

interface TokenRow { open_id: string; access_ciphertext: string; refresh_ciphertext: string; access_expires_at: number; refresh_expires_at: number; granted_scopes: string; refresh_token?: string; }
async function accessToken(env: Env, openId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT open_id, access_ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, granted_scopes FROM oauth_tokens WHERE open_id = ?").bind(openId).first<TokenRow>();
  if (!row) throw new AppError("No TikTok connection found. Please connect TikTok again.", 401);
  if (row.access_expires_at > now() + 60) return decrypt(env, row.access_ciphertext, `access:${openId}`);
  if (row.refresh_expires_at <= now()) throw new AppError("Your TikTok connection has expired. Please connect again.", 401);
  const refresh = await decrypt(env, row.refresh_ciphertext, `refresh:${openId}`);
  const renewed = await tokenRequest(new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refresh }));
  await saveTokens(env, openId, renewed, { ...row, refresh_token: refresh });
  return String(renewed.access_token);
}

interface SessionRow { session_hash: string; open_id: string; csrf_token: string; csrf_hash: string; expires_at: number; }
async function session(request: Request, env: Env, mutation = false): Promise<SessionRow> {
  const id = getCookie(request, "__Host-utm_session");
  if (!id) throw new AppError("Please connect TikTok first.", 401);
  const row = await env.DB.prepare("SELECT session_hash, open_id, csrf_token, csrf_hash, expires_at FROM sessions WHERE session_hash = ? AND expires_at > ?").bind(await hash(id), now()).first<SessionRow>();
  if (!row) throw new AppError("Your session expired. Please connect TikTok again.", 401);
  if (mutation) {
    const token = request.headers.get("x-csrf-token");
    if (!token || (await hash(token)) !== row.csrf_hash) throw new AppError("Request verification failed. Refresh the page and try again.", 403);
  }
  return row;
}
async function tikTokJson(path: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json; charset=UTF-8");
  const response = await fetch(`${TIKTOK_API}${path}`, { ...init, headers });
  const payload = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok || (payload.error && (payload.error as Record<string, unknown>).code !== "ok")) throw new AppError("TikTok API request could not be completed.", 502);
  return payload;
}

async function dashboard(request: Request, env: Env): Promise<Response> {
  const active = await session(request, env);
  const token = await accessToken(env, active.open_id);
  const [profile, videos] = await Promise.all([
    tikTokJson("/v2/user/info/?fields=open_id,display_name,avatar_url,profile_deep_link,follower_count,following_count,likes_count,video_count", token),
    tikTokJson("/v2/video/list/?fields=id,title,cover_image_url,create_time,share_url,video_description,duration,like_count,comment_count,share_count,view_count", token, { method: "POST", body: JSON.stringify({ max_count: 20 }) })
  ]);
  return json({ csrf: active.csrf_token, profile: profile.data || {}, videos: (videos.data as Record<string, unknown>)?.videos || [] });
}

async function creatorInfo(request: Request, env: Env): Promise<Response> {
  const active = await session(request, env, true);
  const token = await accessToken(env, active.open_id);
  const info = await tikTokJson("/v2/post/publish/creator_info/query/", token, { method: "POST", body: "{}" });
  const data = (info.data || {}) as Record<string, unknown>;
  return json({ creator: { creator_username: data.creator_username, creator_nickname: data.creator_nickname, privacy_level_options: data.privacy_level_options, comment_disabled: data.comment_disabled, duet_disabled: data.duet_disabled, stitch_disabled: data.stitch_disabled, max_video_post_duration_sec: data.max_video_post_duration_sec } });
}

function isMp4(file: File, header: Uint8Array): boolean {
  const hasFtyp = header.length > 8 && new TextDecoder().decode(header.slice(4, 8)) === "ftyp";
  return (file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4")) && hasFtyp;
}
async function publishVideo(request: Request, env: Env): Promise<Response> {
  const active = await session(request, env, true);
  const form = await request.formData();
  const file = form.get("file");
  const caption = String(form.get("caption") || "").trim();
  const consent = String(form.get("approval") || "");
  const mode = String(form.get("mode") || "direct");
  if (!(file instanceof File) || !file.size || file.size > MAX_VIDEO_BYTES) throw new AppError("Choose an MP4 video under 64 MB.");
  if (!isMp4(file, new Uint8Array(await file.slice(0, 16).arrayBuffer()))) throw new AppError("Choose a valid MP4 video.");
  if (caption.length > 2200) throw new AppError("Caption is too long.");
  if (consent !== "approved") throw new AppError("Creator approval is required before TikTok can receive a video.", 422);
  if (mode !== "direct" && mode !== "inbox") throw new AppError("Choose a valid TikTok delivery option.", 422);
  const token = await accessToken(env, active.open_id);
  if (mode === "direct") {
    const creator = await tikTokJson("/v2/post/publish/creator_info/query/", token, { method: "POST", body: "{}" });
    const options = ((creator.data as Record<string, unknown>)?.privacy_level_options || []) as string[];
    if (!options.includes("SELF_ONLY")) throw new AppError("TikTok did not make private posting available for this test account.", 422);
  }
  const chunkSize = file.size < 5 * 1024 * 1024 ? file.size : 10 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const initialized = await tikTokJson(mode === "direct" ? "/v2/post/publish/video/init/" : "/v2/post/publish/inbox/video/init/", token, {
    method: "POST",
    body: JSON.stringify({
      ...(mode === "direct" ? { post_info: { title: caption, privacy_level: "SELF_ONLY", disable_duet: true, disable_comment: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false } } : {}),
      source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: chunkSize, total_chunk_count: totalChunks }
    })
  });
  const data = (initialized.data || {}) as Record<string, unknown>;
  const uploadUrl = String(data.upload_url || "");
  const publishId = String(data.publish_id || "");
  if (!uploadUrl || !publishId) throw new AppError("TikTok did not initialize the private upload.", 502);
  for (let start = 0; start < file.size; start += chunkSize) {
    const end = Math.min(file.size, start + chunkSize);
    const body = await file.slice(start, end).arrayBuffer();
    const upload = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(end - start), "content-range": `bytes ${start}-${end - 1}/${file.size}` }, body });
    if (!(upload.status === 201 || upload.status === 206)) throw new AppError("TikTok could not receive the private test video.", 502);
  }
  const id = randomUrl(18);
  await env.DB.prepare("INSERT INTO content_posts (id, open_id, publish_id, post_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, active.open_id, publishId, mode, "PROCESSING", now(), now()).run();
  return json({ id, status: "PROCESSING", delivery: mode === "direct" ? "SELF_ONLY" : "INBOX_DRAFT" });
}

async function postStatus(request: Request, env: Env, url: URL): Promise<Response> {
  const active = await session(request, env);
  const id = url.searchParams.get("id");
  if (!id || !/^[A-Za-z0-9_-]{12,64}$/.test(id)) throw new AppError("Unknown post.", 404);
  const saved = await env.DB.prepare("SELECT publish_id, post_mode, status FROM content_posts WHERE id = ? AND open_id = ?").bind(id, active.open_id).first<{ publish_id: string; post_mode: "direct" | "inbox"; status: string }>();
  if (!saved) throw new AppError("Unknown post.", 404);
  const payload = await tikTokJson("/v2/post/publish/status/fetch/", await accessToken(env, active.open_id), { method: "POST", body: JSON.stringify({ publish_id: saved.publish_id }) });
  const data = (payload.data || {}) as Record<string, unknown>;
  const status = String(data.status || saved.status);
  await env.DB.prepare("UPDATE content_posts SET status = ?, updated_at = ? WHERE id = ? AND open_id = ?").bind(status, now(), id, active.open_id).run();
  return json({ status, delivery: saved.post_mode === "direct" ? "SELF_ONLY" : "INBOX_DRAFT", fail_reason: data.fail_reason || null, publicaly_available_post_id: data.publicaly_available_post_id || null });
}

async function disconnect(request: Request, env: Env): Promise<Response> {
  const active = await session(request, env, true);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE open_id = ?").bind(active.open_id),
    env.DB.prepare("DELETE FROM sessions WHERE open_id = ?").bind(active.open_id)
  ]);
  const response = json({ ok: true });
  response.headers.set("set-cookie", expireCookie("__Host-utm_session"));
  return response;
}

function appPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Useful Tech Manager</title><meta name="description" content="Creator-approved TikTok content management."><style>
*{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#172033;font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit}.shell{width:min(1080px,calc(100% - 36px));margin:auto}.top{padding:22px 0;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:flex;align-items:center;gap:11px;font-weight:750;text-decoration:none}.brand img{width:40px;height:40px;border-radius:12px;box-shadow:0 4px 18px #25446d2a}.pill{font-size:13px;color:#335175;background:#eaf1f8;border-radius:999px;padding:6px 10px}.hero{padding:38px 0 30px;display:grid;grid-template-columns:1.1fr .9fr;gap:28px;align-items:center}.hero h1{font-size:clamp(38px,6vw,64px);letter-spacing:-.055em;line-height:1.02;margin:0 0 18px}.hero p{font-size:19px;max-width:600px;margin:0 0 24px;color:#536177}.cta,.button{background:#192f4b;color:white;border:0;border-radius:14px;font:inherit;font-weight:700;padding:14px 19px;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}.cta:hover,.button:hover{background:#224264}.card{background:white;border:1px solid #e3e9f1;border-radius:22px;padding:22px;box-shadow:0 15px 38px #1f355c0b}.notice{color:#536177;font-size:14px}.logo-card{min-height:250px;display:grid;place-items:center;background:linear-gradient(145deg,#eff6ff,#fff)}.logo-card img{width:155px;border-radius:36px;box-shadow:0 22px 48px #19375d2e}.app{display:none;padding-bottom:48px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric strong{display:block;font-size:28px;letter-spacing:-.04em}.metric span{font-size:13px;color:#62728a}.profile{display:flex;align-items:center;gap:14px;margin-bottom:18px}.profile img{width:52px;height:52px;border-radius:50%;background:#e9edf3}.profile h2{font-size:21px;margin:0}.profile p{margin:2px 0 0;color:#62728a;font-size:14px}.section{margin-top:18px}.section h3{margin:0 0 12px;font-size:18px}.videos{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.video{overflow:hidden;padding:0}.cover{width:100%;height:140px;background:#e9eef5;object-fit:cover;display:block}.video p{margin:9px 11px 12px;font-size:13px;min-height:38px}.composer{display:grid;grid-template-columns:1fr 1fr;gap:14px}.upload{border:1.5px dashed #afc0d2;border-radius:16px;padding:18px;text-align:center;background:#fbfdff}.upload input{max-width:100%}.preview{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:14px;background:#e9eef5;display:none;max-height:350px}.field{display:grid;gap:7px;margin-bottom:13px;font-size:14px;font-weight:650}.field textarea,.field select{font:inherit;border:1px solid #cbd7e4;border-radius:12px;padding:11px;background:white;min-height:48px}.field textarea{resize:vertical;min-height:84px}.confirm{font-size:14px;display:flex;gap:9px;align-items:flex-start;color:#44556c}.status{margin-top:12px;font-size:14px;color:#345472;min-height:20px}.error{color:#a83939}.foot{padding:28px 0;color:#64748b;font-size:13px}@media(max-width:760px){.hero,.composer{grid-template-columns:1fr}.logo-card{display:none}.grid{grid-template-columns:repeat(2,1fr)}.videos{grid-template-columns:repeat(2,1fr)}.top .pill{display:none}.shell{width:min(100% - 28px,1080px)}}
</style></head><body><main class="shell"><header class="top"><a class="brand" href="/app"><img src="https://ahmad9077.github.io/useful-tech-manager/Useful_Tech_Manager_App_Icon_1024.png" alt="Useful Tech Manager logo">Useful Tech Manager</a><span class="pill">Creator-approved publishing</span></header><section id="signed-out" class="hero"><div><h1>Prepare. Review.<br>Publish with approval.</h1><p>Useful Tech Manager helps creators review short-form technology content, view TikTok performance, and send approved videos to TikTok.</p><a class="cta" href="/auth/tiktok/start">Connect TikTok</a><p class="notice">TikTok passwords are never collected. You approve every post before it is sent.</p></div><div class="card logo-card"><img src="https://ahmad9077.github.io/useful-tech-manager/Useful_Tech_Manager_App_Icon_1024.png" alt="Useful Tech Manager"></div></section><section id="app" class="app"><div class="card profile"><img id="avatar" alt=""><div><h2 id="name">Connected TikTok account</h2><p id="handle">Loading authorized account data…</p></div></div><section class="section"><h3>Account analytics</h3><div class="grid"><div class="card metric"><strong id="followers">—</strong><span>Followers</span></div><div class="card metric"><strong id="following">—</strong><span>Following</span></div><div class="card metric"><strong id="likes">—</strong><span>Likes</span></div><div class="card metric"><strong id="video-count">—</strong><span>Videos</span></div></div></section><section class="section"><h3>Recent TikTok videos</h3><div id="videos" class="videos"><p class="notice">Loading videos…</p></div></section><section class="section"><h3>Prepare a private test post</h3><div class="card composer"><div class="upload"><input id="file" type="file" accept="video/mp4,.mp4"><p class="notice">MP4, up to 64 MB. The video is only sent after you confirm below.</p><video id="preview" class="preview" controls muted playsinline></video></div><div><label class="field">Caption<textarea id="caption" maxlength="2200" placeholder="Describe this test video"></textarea></label><label class="field">Privacy<select id="privacy" disabled><option>Private test post (SELF_ONLY)</option></select></label><label class="confirm"><input id="approval" type="checkbox">I approve sending this selected video to TikTok as a private test post.</label><button id="publish" class="button" type="button">Publish Test</button><div id="status" class="status" role="status"></div></div></div></section><section class="section"><button id="disconnect" class="button" type="button" style="background:#6c7481">Disconnect TikTok</button></section></section><footer class="foot">Useful Tech Manager is an independent service and is not affiliated with or endorsed by TikTok.</footer></main><script>
const out=document.getElementById('signed-out'),app=document.getElementById('app'),status=document.getElementById('status');let csrf='';const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const n=(v)=>new Intl.NumberFormat().format(Number(v||0));async function api(path,init={}){const r=await fetch(path,init);const d=await r.json().catch(()=>({error:'Request failed'}));if(!r.ok)throw new Error(d.error||'Request failed');return d}async function load(){try{const d=await api('/api/dashboard');csrf=d.csrf;out.style.display='none';app.style.display='block';const p=d.profile||{};document.getElementById('name').textContent=p.display_name||'Connected TikTok account';document.getElementById('handle').textContent='Authorized via TikTok';document.getElementById('avatar').src=p.avatar_url||'';document.getElementById('followers').textContent=n(p.follower_count);document.getElementById('following').textContent=n(p.following_count);document.getElementById('likes').textContent=n(p.likes_count);document.getElementById('video-count').textContent=n(p.video_count);const list=document.getElementById('videos');list.innerHTML='';for(const v of d.videos||[]){const a=document.createElement('a');a.className='card video';a.href=v.share_url||'#';a.target='_blank';a.rel='noreferrer';a.innerHTML=(v.cover_image_url?'<img class="cover" src="'+esc(v.cover_image_url)+'" alt="">':'<div class="cover"></div>')+'<p>'+esc(v.title||v.video_description||'TikTok video')+'</p>';list.append(a)}if(!list.children.length)list.innerHTML='<p class="notice">No videos were returned by TikTok.</p>'}catch(e){if(location.hash==='#connected'){status.textContent=e.message;status.className='status error'}else{out.style.display='grid'}}}document.getElementById('file').addEventListener('change',e=>{const f=e.target.files[0],v=document.getElementById('preview');if(!f)return;v.src=URL.createObjectURL(f);v.style.display='block'});document.getElementById('publish').addEventListener('click',async()=>{const file=document.getElementById('file').files[0];if(!file)return show('Choose a test MP4 first.',true);if(!document.getElementById('approval').checked)return show('Tick the approval box before publishing.',true);if(!confirm('Send this video to TikTok as a private SELF_ONLY test post?'))return;const form=new FormData();form.set('file',file);form.set('caption',document.getElementById('caption').value);form.set('approval','approved');show('Sending the approved private test video…');try{const d=await api('/api/publish',{method:'POST',headers:{'x-csrf-token':csrf},body:form});show('Private upload started. Checking status…');const check=async()=>{const s=await api('/api/publish/status?id='+encodeURIComponent(d.id));show('TikTok status: '+s.status+' · Private (SELF_ONLY)');if(s.status==='PROCESSING')setTimeout(check,3500)};check()}catch(e){show(e.message,true)}});document.getElementById('disconnect').addEventListener('click',async()=>{if(!confirm('Disconnect this TikTok account from Useful Tech Manager?'))return;try{await api('/api/disconnect',{method:'POST',headers:{'x-csrf-token':csrf}});location.href='/app'}catch(e){show(e.message,true)}});function show(m,error=false){status.textContent=m;status.className='status'+(error?' error':'')}load();
</script></body></html>`;
}
