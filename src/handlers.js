import {
  changesOf,
  contactJobs,
  newUnsubscribeCredential,
  processOutbox,
  queueStatement,
  reactivationJob,
  welcomeJob
} from "./mail.js";
import {
  allowRequest,
  escapeHtml,
  honeypotTripped,
  isAllowedOrigin,
  readForm,
  sha256Hex,
  siteOrigin,
  submissionsConfigured,
  verifyTurnstile
} from "./security.js";
import { validateContact, validateSubscribe } from "./validate.js";

const REACTIVATION_REUSE_MS = 15 * 60 * 1000;
const SAVED_ERROR = "We couldn\u2019t save your submission. Nothing was confirmed as saved. Please try again.";
const UNAVAILABLE = "Submissions are temporarily unavailable. Please try again later.";

function json(data, status = 200, extra = {}) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function withCors(request, env, response) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedOrigin(request, env)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function htmlPage(title, main, status = 200) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} — Roseva</title>
  <link rel="icon" href="/assets/roseva-logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="page">
    <header class="site-header">
      <div class="wrap header-inner">
        <a class="brand" href="/">
          <img src="/assets/roseva-logo.svg" alt="" width="45" height="48">
          <span class="brand__name">Roseva</span>
        </a>
      </div>
    </header>
    <main class="section" id="main" tabindex="-1">
      <div class="wrap wrap--narrow">
        ${main}
      </div>
    </main>
  </div>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex"
    }
  });
}

function isUniqueError(error) {
  const code = String(error && error.code ? error.code : "");
  const message = String(error && error.message ? error.message : "");
  return code.includes("CONSTRAINT") || message.includes("UNIQUE");
}

function validToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(token);
}

function tokenFrom(url, form) {
  const queryToken = url.searchParams.get("token") || "";
  const bodyToken = form ? String(form.get("token") || "") : "";
  if (queryToken && bodyToken && queryToken !== bodyToken) {
    return "";
  }
  return bodyToken || queryToken;
}

function savedFailure() {
  return json({ ok: false, error: SAVED_ERROR }, 500);
}

async function requireDatabase(env) {
  if (!env || !env.DB) {
    return savedFailure();
  }
  return null;
}

export function configResponse(env) {
  const enabled = submissionsConfigured(env);
  return json({
    submissionsEnabled: enabled,
    turnstileSiteKey: enabled ? env.TURNSTILE_SITE_KEY : null
  });
}

async function prepareSubmission(request, env, expectedAction) {
  const unavailable = await requireDatabase(env);
  if (unavailable) {
    return { response: unavailable };
  }
  if (!submissionsConfigured(env)) {
    return { response: json({ ok: false, error: UNAVAILABLE }, 503) };
  }
  const parsed = await readForm(request);
  if (parsed.error === "too_large") {
    return { response: json({ ok: false, error: "The submission is too large." }, 413) };
  }
  if (parsed.error) {
    return { response: json({ ok: false, error: "The submission could not be read." }, 400) };
  }
  if (honeypotTripped(parsed.form)) {
    return { response: json({ ok: false, error: "This submission could not be processed." }, 400) };
  }
  return { form: parsed.form, expectedAction };
}

async function finishChecks(request, env, form, endpoint, expectedAction) {
  if (!(await allowRequest(env.DB, request, endpoint))) {
    return json({ ok: false, error: "Too many requests. Please try again later." }, 429);
  }
  const turnstile = await verifyTurnstile(env, form.get("cf-turnstile-response") || "", request, expectedAction);
  if (turnstile.missing) {
    return json({ ok: false, error: UNAVAILABLE }, 503);
  }
  if (!turnstile.ok) {
    return json({ ok: false, error: "Complete the verification check before submitting." }, 400);
  }
  return null;
}

function queueSend(ctx, env) {
  if (!ctx || typeof ctx.waitUntil !== "function") {
    return;
  }
  ctx.waitUntil(processOutbox(env).catch(() => null));
}

export async function subscribe(request, env, ctx) {
  const prepared = await prepareSubmission(request, env, "subscribe");
  if (prepared.response) {
    return prepared.response;
  }
  const validation = validateSubscribe(prepared.form);
  if (!validation.ok) {
    return json({ ok: false, error: "Check the highlighted fields.", fields: validation.fields }, 400);
  }
  const blocked = await finishChecks(request, env, prepared.form, "subscribe", "subscribe");
  if (blocked) {
    return blocked;
  }
  const existing = await env.DB.prepare("SELECT email, status, reactivation_token_hash, updated_at FROM subscribers WHERE email = ?")
    .bind(validation.email)
    .first();
  if (existing && existing.status === "subscribed") {
    return json({ ok: true, result: "already_subscribed" });
  }
  if (existing && existing.status === "unsubscribed") {
    return reactivate(request, env, ctx, existing);
  }
  const now = Date.now();
  const credential = await newUnsubscribeCredential();
  const origin = siteOrigin(request, env);
  const job = welcomeJob(origin, validation.email, credential.token, now);
  const queued = queueStatement(
    "SELECT 1 FROM subscribers WHERE email = ? AND status = 'subscribed' AND unsubscribe_token_hash = ?",
    job,
    [validation.email, credential.hash]
  );
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO subscribers (email, status, consent_at, unsubscribe_token_hash, created_at, updated_at) VALUES (?, 'subscribed', ?, ?, ?, ?)"
      ).bind(validation.email, now, credential.hash, now, now),
      env.DB.prepare(queued.sql).bind(...queued.bindings)
    ]);
    if (!changesOf(results[0]) || !changesOf(results[1])) {
      return savedFailure();
    }
  } catch (error) {
    if (!isUniqueError(error)) {
      return savedFailure();
    }
    const again = await env.DB.prepare(
      "SELECT email, status, reactivation_token_hash, updated_at FROM subscribers WHERE email = ?"
    )
      .bind(validation.email)
      .first();
    if (again && again.status === "subscribed") {
      return json({ ok: true, result: "already_subscribed" });
    }
    if (again && again.status === "unsubscribed") {
      return reactivate(request, env, ctx, again);
    }
    return savedFailure();
  }
  queueSend(ctx, env);
  return json({ ok: true, result: "subscribed" });
}

async function reactivate(request, env, ctx, existing) {
  const now = Date.now();
  if (existing.reactivation_token_hash && now - Number(existing.updated_at) < REACTIVATION_REUSE_MS) {
    const pending = await env.DB.prepare(
      "SELECT status FROM email_outbox WHERE idempotency_key = ? AND status IN ('pending', 'sent')"
    )
      .bind(`reactivation:${existing.email}:${existing.reactivation_token_hash}`)
      .first();
    if (pending) {
      return json({ ok: true, result: "confirmation_required" });
    }
  }
  const credential = await newUnsubscribeCredential();
  const job = reactivationJob(siteOrigin(request, env), existing.email, credential.token, credential.hash, now);
  const queued = queueStatement(
    "SELECT 1 FROM subscribers WHERE email = ? AND status = 'unsubscribed' AND reactivation_token_hash = ?",
    job,
    [existing.email, credential.hash]
  );
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE subscribers SET reactivation_token_hash = ?, updated_at = ? WHERE email = ? AND status = 'unsubscribed'"
      ).bind(credential.hash, now, existing.email),
      env.DB.prepare(queued.sql).bind(...queued.bindings)
    ]);
    if (!changesOf(results[0]) || !changesOf(results[1])) {
      const again = await env.DB.prepare("SELECT status FROM subscribers WHERE email = ?").bind(existing.email).first();
      if (again && again.status === "subscribed") {
        return json({ ok: true, result: "already_subscribed" });
      }
      return json({ ok: true, result: "confirmation_required" });
    }
  } catch {
    return savedFailure();
  }
  queueSend(ctx, env);
  return json({ ok: true, result: "confirmation_required" });
}

export async function contact(request, env, ctx) {
  const prepared = await prepareSubmission(request, env, "contact");
  if (prepared.response) {
    return prepared.response;
  }
  const validation = validateContact(prepared.form);
  if (!validation.ok) {
    return json({ ok: false, error: "Check the highlighted fields.", fields: validation.fields }, 400);
  }
  const blocked = await finishChecks(request, env, prepared.form, "contact", "contact");
  if (blocked) {
    return blocked;
  }
  const existing = await env.DB.prepare("SELECT id FROM contact_messages WHERE request_id = ?")
    .bind(validation.requestId)
    .first();
  if (existing) {
    return json({ ok: true, result: "received" });
  }
  const now = Date.now();
  const jobs = contactJobs({ ...validation, origin: siteOrigin(request, env) }, now);
  const statements = [
    env.DB.prepare(
      "INSERT INTO contact_messages (request_id, first_name, last_name, email, mobile, company, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      validation.requestId,
      validation.firstName,
      validation.lastName,
      validation.email,
      validation.mobile,
      validation.company,
      validation.message,
      now
    )
  ];
  for (const job of jobs) {
    const queued = queueStatement("SELECT 1 FROM contact_messages WHERE request_id = ?", job, [validation.requestId]);
    statements.push(env.DB.prepare(queued.sql).bind(...queued.bindings));
  }
  try {
    const results = await env.DB.batch(statements);
    if (results.some((result) => !changesOf(result))) {
      return savedFailure();
    }
  } catch (error) {
    if (isUniqueError(error)) {
      const again = await env.DB.prepare("SELECT id FROM contact_messages WHERE request_id = ?")
        .bind(validation.requestId)
        .first();
      if (again) {
        return json({ ok: true, result: "received" });
      }
    }
    return savedFailure();
  }
  queueSend(ctx, env);
  return json({ ok: true, result: "received" });
}

async function markUnsubscribed(env, token) {
  if (!validToken(token)) {
    return { ok: false };
  }
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT status FROM subscribers WHERE unsubscribe_token_hash = ?").bind(hash).first();
  if (!row) {
    return { ok: false };
  }
  await env.DB.prepare(
    "UPDATE subscribers SET status = 'unsubscribed', reactivation_token_hash = NULL, updated_at = ? WHERE unsubscribe_token_hash = ?"
  )
    .bind(Date.now(), hash)
    .run();
  return { ok: true };
}

function unsubscribeForm(token, heading, text) {
  return `<h1>${heading}</h1>
    <p>${text}</p>
    <form method="post" action="/unsubscribe">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button class="button button--primary" type="submit">Unsubscribe</button>
    </form>`;
}

export async function unsubscribe(request, env) {
  const failure = await requireDatabase(env);
  if (failure) {
    return htmlPage("Unavailable", `<h1>Temporarily unavailable</h1><p>${SAVED_ERROR}</p>`, 500);
  }
  const url = new URL(request.url);
  if (request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!validToken(token)) {
      return htmlPage("Unsubscribe", "<h1>Unsubscribe</h1><p>This unsubscribe link is not valid.</p>", 400);
    }
    const row = await env.DB.prepare("SELECT status FROM subscribers WHERE unsubscribe_token_hash = ?")
      .bind(await sha256Hex(token))
      .first();
    if (!row) {
      return htmlPage("Unsubscribe", "<h1>Unsubscribe</h1><p>This unsubscribe link is not valid.</p>", 400);
    }
    if (row.status === "unsubscribed") {
      return htmlPage("Unsubscribe", "<h1>You are unsubscribed</h1><p>This address will no longer receive Roseva news and updates.</p>");
    }
    return htmlPage(
      "Unsubscribe",
      unsubscribeForm(token, "Unsubscribe", "Confirm that you no longer want news and updates from Roseva.")
    );
  }
  if (request.method !== "POST") {
    return htmlPage("Unsubscribe", "<h1>Unsubscribe</h1><p>This unsubscribe link is not valid.</p>", 405);
  }
  if (!(await allowRequest(env.DB, request, "unsubscribe", 30))) {
    return htmlPage("Unsubscribe", "<h1>Unsubscribe</h1><p>Too many requests. Please try again later.</p>", 429);
  }
  const parsed = await readForm(request);
  const form = parsed.form || new Map();
  const oneClick = form.get("List-Unsubscribe") === "One-Click";
  if (parsed.error && !url.searchParams.get("token")) {
    return oneClick
      ? new Response(null, { status: 400, headers: { "cache-control": "no-store" } })
      : htmlPage("Unsubscribe", "<h1>Unsubscribe</h1><p>This unsubscribe link is not valid.</p>", 400);
  }
  const outcome = await markUnsubscribed(env, tokenFrom(url, form));
  if (oneClick) {
    return new Response(null, { status: outcome.ok ? 200 : 400, headers: { "cache-control": "no-store" } });
  }
  if (!outcome.ok) {
    return htmlPage("Unsubscribe", "<h1>Unsubscribe</h1><p>This unsubscribe link is not valid.</p>", 400);
  }
  return htmlPage("Unsubscribed", "<h1>You are unsubscribed</h1><p>This address will no longer receive Roseva news and updates.</p>");
}

export async function confirmSubscription(request, env, ctx) {
  const failure = await requireDatabase(env);
  if (failure) {
    return htmlPage("Unavailable", `<h1>Temporarily unavailable</h1><p>${SAVED_ERROR}</p>`, 500);
  }
  const url = new URL(request.url);
  if (request.method === "GET") {
    return renderConfirm(env, url.searchParams.get("token") || "");
  }
  if (request.method !== "POST") {
    return htmlPage("Confirm subscription", "<h1>Confirm subscription</h1><p>This confirmation link is not valid.</p>", 405);
  }
  if (!(await allowRequest(env.DB, request, "confirm", 30))) {
    return htmlPage("Confirm subscription", "<h1>Confirm subscription</h1><p>Too many requests. Please try again later.</p>", 429);
  }
  const parsed = await readForm(request);
  const token = tokenFrom(url, parsed.form || new Map());
  let activated;
  try {
    activated = await activateSubscriber(request, env, ctx, token);
  } catch {
    return htmlPage("Unavailable", `<h1>Temporarily unavailable</h1><p>${SAVED_ERROR}</p>`, 500);
  }
  if (!activated.ok) {
    return htmlPage(
      "Confirm subscription",
      "<h1>Confirm subscription</h1><p>This confirmation link is not valid or has already been used.</p>",
      400
    );
  }
  return htmlPage(
    "Subscribed",
    "<h1>Thank you for subscribing</h1><p>You\u2019re now subscribed to Roseva news and updates.</p>"
  );
}

async function renderConfirm(env, token) {
  if (!validToken(token)) {
    return htmlPage("Confirm subscription", "<h1>Confirm subscription</h1><p>This confirmation link is not valid.</p>", 400);
  }
  const row = await env.DB.prepare("SELECT status FROM subscribers WHERE reactivation_token_hash = ?")
    .bind(await sha256Hex(token))
    .first();
  if (!row || row.status !== "unsubscribed") {
    return htmlPage(
      "Confirm subscription",
      "<h1>Confirm subscription</h1><p>This confirmation link is not valid or has already been used.</p>",
      400
    );
  }
  return htmlPage(
    "Confirm subscription",
    `<h1>Confirm your subscription</h1>
     <p>This address was unsubscribed. Confirm if you want Roseva news and updates again.</p>
     <form method="post" action="/subscribe/confirm">
       <input type="hidden" name="token" value="${escapeHtml(token)}">
       <button class="button button--primary" type="submit">Confirm subscription</button>
     </form>`
  );
}

async function activateSubscriber(request, env, ctx, token) {
  if (!validToken(token)) {
    return { ok: false };
  }
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT email, status FROM subscribers WHERE reactivation_token_hash = ?")
    .bind(hash)
    .first();
  if (!row || row.status !== "unsubscribed") {
    return { ok: false };
  }
  const now = Date.now();
  const credential = await newUnsubscribeCredential();
  const job = welcomeJob(siteOrigin(request, env), row.email, credential.token, now);
  const queued = queueStatement(
    "SELECT 1 FROM subscribers WHERE email = ? AND status = 'subscribed' AND unsubscribe_token_hash = ?",
    job,
    [row.email, credential.hash]
  );
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE subscribers
       SET status = 'subscribed', consent_at = ?, unsubscribe_token_hash = ?, reactivation_token_hash = NULL, updated_at = ?
       WHERE reactivation_token_hash = ? AND status = 'unsubscribed'`
    ).bind(now, credential.hash, now, hash),
    env.DB.prepare(queued.sql).bind(...queued.bindings)
  ]);
  if (!changesOf(results[0]) || !changesOf(results[1])) {
    return { ok: false };
  }
  queueSend(ctx, env);
  return { ok: true };
}

export async function routeApi(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    if (!isAllowedOrigin(request, env)) {
      return json({ ok: false, error: "This submission was rejected." }, 403);
    }
    return withCors(request, env, new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
  }
  if (url.pathname === "/api/subscribe" && request.method === "POST") {
    if (!isAllowedOrigin(request, env)) {
      return json({ ok: false, error: "This submission was rejected." }, 403);
    }
    return withCors(request, env, await subscribe(request, env, ctx));
  }
  if (url.pathname === "/api/contact" && request.method === "POST") {
    if (!isAllowedOrigin(request, env)) {
      return json({ ok: false, error: "This submission was rejected." }, 403);
    }
    return withCors(request, env, await contact(request, env, ctx));
  }
  return null;
}

export { json, withCors };
