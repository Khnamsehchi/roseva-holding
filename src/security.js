const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function configuredOrigin(env) {
  if (!env || !env.PUBLIC_SITE_URL) {
    return "";
  }
  try {
    const url = new URL(env.PUBLIC_SITE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

export function allowedOrigins(request, env) {
  const origins = new Set([new URL(request.url).origin]);
  const configured = configuredOrigin(env);
  if (configured) {
    origins.add(configured);
  }
  return origins;
}

export function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return false;
  }
  return allowedOrigins(request, env).has(origin);
}

export function siteOrigin(request, env) {
  return configuredOrigin(env) || new URL(request.url).origin;
}

export function submissionsConfigured(env) {
  return Boolean(
    env &&
      typeof env.TURNSTILE_SITE_KEY === "string" &&
      env.TURNSTILE_SITE_KEY.trim() &&
      typeof env.TURNSTILE_SECRET_KEY === "string" &&
      env.TURNSTILE_SECRET_KEY.trim()
  );
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function clientAddress(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export async function allowRequest(db, request, endpoint, limit = RATE_LIMIT) {
  const now = Date.now();
  const bucket = await sha256Hex(`${endpoint}:${clientAddress(request)}`);
  const row = await db.prepare(
    `INSERT INTO rate_limits (bucket, hits, window_start)
     VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       hits = CASE
         WHEN excluded.window_start - rate_limits.window_start >= ? THEN 1
         ELSE rate_limits.hits + 1
       END,
       window_start = CASE
         WHEN excluded.window_start - rate_limits.window_start >= ? THEN excluded.window_start
         ELSE rate_limits.window_start
       END
     RETURNING hits`
  )
    .bind(bucket, now, RATE_WINDOW_MS, RATE_WINDOW_MS)
    .first();
  return Boolean(row) && Number(row.hits) <= limit;
}

export async function verifyTurnstile(env, token, request, expectedAction) {
  if (!submissionsConfigured(env)) {
    return { ok: false, missing: true };
  }
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
    return { ok: false };
  }
  const body = new URLSearchParams();
  body.set("secret", env.TURNSTILE_SECRET_KEY);
  body.set("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) {
    body.set("remoteip", ip);
  }
  let response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false };
  }
  const result = await response.json();
  const hostname = new URL(request.url).hostname;
  const configuredHost = configuredOrigin(env) ? new URL(configuredOrigin(env)).hostname : "";
  const hostAllowed = !result.hostname || result.hostname === hostname || result.hostname === configuredHost;
  if (result.success !== true || result.action !== expectedAction || !hostAllowed) {
    return { ok: false };
  }
  return { ok: true };
}

export async function readForm(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { error: "too_large" };
  }
  const contentType = request.headers.get("Content-Type") || "";
  try {
    if (contentType.includes("application/json")) {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return { error: "too_large" };
      }
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { error: "invalid" };
      }
      const form = new Map();
      for (const [key, value] of Object.entries(data)) {
        if (typeof value !== "string") {
          return { error: "invalid" };
        }
        form.set(key, value);
      }
      return { form };
    }
    const formData = await request.formData();
    const form = new Map();
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string") {
        return { error: "invalid" };
      }
      if (value.length > MAX_BODY_BYTES) {
        return { error: "too_large" };
      }
      form.set(key, value);
    }
    return { form };
  } catch {
    return { error: "invalid" };
  }
}

export function honeypotTripped(form) {
  return Boolean(form.get("company_website") && String(form.get("company_website")).trim());
}
