import { escapeHtml, randomToken, sha256Hex } from "./security.js";

const FROM = "Rozeva Group <support@roseva.com>";
const SUPPORT = "support@roseva.com";
const MAX_ATTEMPTS = 5;
const LOCK_MS = 2 * 60 * 1000;
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];

export const SUBSCRIBED_RECIPIENTS_SQL =
  "SELECT email FROM subscribers WHERE status = 'subscribed' ORDER BY email";

export function changesOf(result) {
  if (!result || result.success === false || !result.meta) {
    throw new Error("database write failed");
  }
  return Number(result.meta.changes || 0);
}

function outboxSelect(existsSql) {
  return `INSERT INTO email_outbox (
      kind, recipient, reply_to, subject, html, text_body, headers_json,
      status, attempt_count, idempotency_key, next_retry_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?
    WHERE EXISTS (${existsSql})
      AND NOT EXISTS (SELECT 1 FROM email_outbox WHERE idempotency_key = ?)`;
}

export function queueStatement(existsSql, job, existsBindings) {
  const bindings = [
    job.kind,
    job.recipient,
    job.replyTo,
    job.subject,
    job.html,
    job.text,
    JSON.stringify(job.headers || {}),
    job.idempotencyKey,
    job.nextRetryAt,
    job.createdAt,
    job.createdAt,
    ...existsBindings,
    job.idempotencyKey
  ];
  return { sql: outboxSelect(existsSql), bindings };
}

export async function listSubscribedRecipients(db) {
  const result = await db.prepare(SUBSCRIBED_RECIPIENTS_SQL).all();
  return (result.results || []).map((row) => row.email);
}

export function unsubscribeUrl(origin, token) {
  return `${origin}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function confirmUrl(origin, token) {
  return `${origin}/subscribe/confirm?token=${encodeURIComponent(token)}`;
}

function brandedHtml(origin, title, paragraphs, action) {
  const logo = escapeHtml(`${origin}/assets/roseva-logo.svg`);
  const body = paragraphs.map((paragraph) => `<p style="margin:0 0 16px;">${paragraph}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#c10505;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;">${escapeHtml(action.label)}</a></p>`
    : "";
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;background:#080808;color:#f5f5f5;font-family:Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080808;">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td>
            <img src="${logo}" alt="Rozeva Group" width="45" height="48">
            <p style="margin:12px 0;color:#f20606;letter-spacing:0.16em;font-size:12px;">ROZEVA GROUP</p>
            <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#ffffff;">${escapeHtml(title)}</h1>
            ${body}
            ${button}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

export async function newUnsubscribeCredential() {
  const token = randomToken();
  return { token, hash: await sha256Hex(token) };
}

export function welcomeJob(origin, email, token, consentAt) {
  const url = unsubscribeUrl(origin, token);
  const text = `Thank you for subscribing.\n\nYou\u2019re now subscribed to Rozeva Group news and updates.\n\nUnsubscribe: ${url}`;
  return {
    kind: "welcome",
    recipient: email,
    replyTo: SUPPORT,
    subject: "You\u2019re subscribed to Rozeva Group",
    html: brandedHtml(origin, "Thank you for subscribing", ["You\u2019re now subscribed to Rozeva Group news and updates."], {
      href: url,
      label: "Unsubscribe"
    }),
    text,
    headers: {
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    },
    idempotencyKey: `welcome:${email}:${consentAt}`,
    nextRetryAt: consentAt,
    createdAt: consentAt
  };
}

export function reactivationJob(origin, email, token, tokenHash, now) {
  const url = confirmUrl(origin, token);
  return {
    kind: "reactivation",
    recipient: email,
    replyTo: SUPPORT,
    subject: "Confirm your Rozeva Group subscription",
    html: brandedHtml(
      origin,
      "Confirm your subscription",
      ["This address was unsubscribed. It will not be subscribed again until you confirm."],
      { href: url, label: "Confirm subscription" }
    ),
    text: `This address was unsubscribed. Confirm before it is subscribed again:\n${url}`,
    headers: {},
    idempotencyKey: `reactivation:${email}:${tokenHash}`,
    nextRetryAt: now,
    createdAt: now
  };
}

export function contactJobs(message, now) {
  const safe = {
    firstName: escapeHtml(message.firstName),
    lastName: escapeHtml(message.lastName),
    email: escapeHtml(message.email),
    mobile: escapeHtml(message.mobile),
    company: escapeHtml(message.company || ""),
    body: escapeHtml(message.message || "").replace(/\n/g, "<br>")
  };
  const ackText = [
    `Dear ${message.firstName},`,
    "Thank you for contacting Rozeva Group. We\u2019ve received your message,",
    "and the relevant department will contact you within the next 24 hours.",
    "Best regards,",
    "Rozeva Group"
  ].join("\n");
  const internalText = [
    "A visitor sent a message from the Rozeva Group website.",
    `Name: ${message.firstName} ${message.lastName}`,
    `Email: ${message.email}`,
    `Mobile: ${message.mobile}`,
    `Company: ${message.company || ""}`,
    `Message: ${message.message || ""}`,
    `Request: ${message.requestId}`
  ].join("\n");
  return [
    {
      kind: "contact_internal",
      recipient: SUPPORT,
      replyTo: message.email,
      subject: "New message from the Rozeva Group website",
      html: brandedHtml(message.origin || "https://roseva.com", "New website message", [
        `${safe.firstName} ${safe.lastName}`,
        `Email: ${safe.email}`,
        `Mobile: ${safe.mobile}`,
        `Company: ${safe.company}`,
        safe.body || "No message text was provided."
      ]),
      text: internalText,
      headers: {},
      idempotencyKey: `contact-internal:${message.requestId}`,
      nextRetryAt: now,
      createdAt: now
    },
    {
      kind: "contact_ack",
      recipient: message.email,
      replyTo: SUPPORT,
      subject: "We received your message",
      html: brandedHtml(message.origin || "https://roseva.com", "We received your message", [
        `Dear ${safe.firstName},`,
        "Thank you for contacting Rozeva Group. We\u2019ve received your message,<br>and the relevant department will contact you within the next 24 hours.",
        "Best regards,<br>Rozeva Group"
      ]),
      text: ackText,
      headers: {},
      idempotencyKey: `contact-ack:${message.requestId}`,
      nextRetryAt: now,
      createdAt: now
    }
  ];
}

function permanentStatus(status) {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

async function sendJob(env, job) {
  if (!env.RESEND_API_KEY) {
    return { type: "unconfigured" };
  }
  let headers = {};
  try {
    headers = JSON.parse(job.headers_json || "{}");
  } catch {
    headers = {};
  }
  const payload = {
    from: FROM,
    to: [job.recipient],
    subject: job.subject,
    html: job.html,
    text: job.text_body,
    reply_to: job.reply_to || SUPPORT
  };
  if (headers && Object.keys(headers).length) {
    payload.headers = headers;
  }
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": job.idempotency_key
      },
      body: JSON.stringify(payload)
    });
  } catch {
    return { type: "transient", code: "network" };
  }
  if (response.ok) {
    const data = await response.json().catch(() => ({}));
    return { type: "accepted", id: typeof data.id === "string" ? data.id.slice(0, 128) : "" };
  }
  if (permanentStatus(response.status)) {
    return { type: "permanent", code: `provider_${response.status}` };
  }
  return { type: "transient", code: `provider_${response.status}` };
}

export async function processOutbox(env, options = {}) {
  if (!env || !env.DB || !env.RESEND_API_KEY) {
    return { processed: 0 };
  }
  const now = options.now || Date.now();
  const ready = await env.DB.prepare(
    `SELECT id FROM email_outbox
     WHERE status = 'pending' AND next_retry_at <= ? AND (locked_until IS NULL OR locked_until <= ?)
     ORDER BY next_retry_at ASC
     LIMIT 10`
  )
    .bind(now, now)
    .all();
  let processed = 0;
  for (const candidate of ready.results || []) {
    const claim = randomToken();
    const locked = await env.DB.prepare(
      `UPDATE email_outbox
       SET claim_token = ?, locked_until = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until <= ?)`
    )
      .bind(claim, now + LOCK_MS, now, candidate.id, now)
      .run();
    if (!changesOf(locked)) {
      continue;
    }
    const job = await env.DB.prepare("SELECT * FROM email_outbox WHERE id = ? AND claim_token = ?")
      .bind(candidate.id, claim)
      .first();
    if (!job) {
      continue;
    }
    const result = await sendJob(env, job);
    processed += 1;
    if (result.type === "unconfigured") {
      await env.DB.prepare(
        "UPDATE email_outbox SET claim_token = NULL, locked_until = NULL, updated_at = ? WHERE id = ? AND claim_token = ?"
      )
        .bind(now, job.id, claim)
        .run();
      continue;
    }
    if (result.type === "accepted") {
      await env.DB.prepare(
        `UPDATE email_outbox
         SET status = 'sent', provider_message_id = ?, claim_token = NULL, locked_until = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND claim_token = ?`
      )
        .bind(result.id, now, job.id, claim)
        .run();
      continue;
    }
    const attempts = Number(job.attempt_count) + 1;
    const giveUp = result.type === "permanent" || attempts >= MAX_ATTEMPTS;
    const nextRetry = now + (BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] || BACKOFF_MS[BACKOFF_MS.length - 1]);
    await env.DB.prepare(
      `UPDATE email_outbox
       SET status = ?, attempt_count = ?, next_retry_at = ?, claim_token = NULL, locked_until = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND claim_token = ?`
    )
      .bind(giveUp ? "failed" : "pending", attempts, nextRetry, result.code || "failed", now, job.id, claim)
      .run();
  }
  return { processed };
}

export { FROM, SUPPORT };
