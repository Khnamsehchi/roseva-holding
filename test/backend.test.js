import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { sha256Hex } from "../src/security.js";
import worker, { handleRequest, listSubscribedRecipients, processOutbox } from "../src/worker.js";

const ORIGIN = "http://127.0.0.1:8787";
const SITE = "https://roseva.com";

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    const next = new Statement(this.db, this.sql);
    next.params = params;
    return next;
  }

  _run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) }
    };
  }

  run() {
    return Promise.resolve(this._run());
  }

  first() {
    return Promise.resolve(this.db.prepare(this.sql).get(...this.params) || null);
  }

  all() {
    return Promise.resolve({ results: this.db.prepare(this.sql).all(...this.params), success: true });
  }
}

class TestDatabase {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    this.failNextBatch = false;
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("database unavailable");
    }
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement._run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function createEnv(db, overrides = {}) {
  return Object.assign(
    {
      DB: db,
      TURNSTILE_SITE_KEY: "site-key",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      RESEND_API_KEY: "test-resend-key",
      PUBLIC_SITE_URL: SITE
    },
    overrides
  );
}

function tracker() {
  const jobs = [];
  return {
    jobs,
    waitUntil(promise) {
      jobs.push(promise);
    }
  };
}

async function settle(ctx) {
  if (ctx) {
    await Promise.all(ctx.jobs);
  }
}

let restoreFetch = null;

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

function installFetch(send) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.includes("/turnstile/v0/siteverify")) {
      const params = new URLSearchParams(init.body);
      const token = params.get("response");
      const action = token === "valid-subscribe" ? "subscribe" : token === "valid-contact" ? "contact" : "";
      if (params.get("secret") !== "turnstile-secret" || !action) {
        return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
      }
      return Response.json({ success: true, action, hostname: "127.0.0.1" });
    }
    if (href === "https://api.resend.com/emails") {
      return send(init, calls);
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
  return calls;
}

function resendCalls(calls) {
  return calls.filter((call) => call.url === "https://api.resend.com/emails");
}

function header(init, name) {
  return new Headers(init.headers).get(name);
}

function payload(init) {
  return JSON.parse(init.body);
}

async function post(path, fields, env, ctx, headers = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  const request = new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Accept: "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      ...headers
    },
    body: form
  });
  return handleRequest(request, env, ctx);
}

async function readJson(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const contactFields = {
  firstName: "<Ada>",
  lastName: "Lovelace",
  email: "Ada@Example.com",
  mobile: "+971 50 123 4567",
  company: 'Roseva "Motors"',
  message: "Hello\n<script>",
  requestId: "request-1234",
  "cf-turnstile-response": "valid-contact"
};

describe("newsletter, contact, and outbox", () => {
  it("rejects invalid details, a bad origin, a honeypot, and an oversized body", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    installFetch(() => Response.json({ id: "msg_unused" }));
    const invalid = await readJson(await post("/api/subscribe", { email: "not-an-email", "cf-turnstile-response": "valid-subscribe" }, env));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.fields.email, "Enter a valid email address.");
    const forbidden = await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, null, {
      Origin: "https://evil.example"
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("access-control-allow-origin"), null);
    const badToken = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "not-valid" }, env)
    );
    assert.equal(badToken.status, 400);
    assert.match(badToken.body.error, /verification/);
    const honeypot = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", company_website: "https://spam.example", "cf-turnstile-response": "valid-subscribe" }, env)
    );
    assert.equal(honeypot.status, 400);
    const oversized = await handleRequest(
      new Request(`${ORIGIN}/api/contact`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a".repeat(40000) })
      }),
      env
    );
    assert.equal(oversized.status, 413);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM subscribers").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM contact_messages").first()).n, 0);
  });

  it("subscribes once, keeps the saved copy, and does not claim delivery", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    const calls = installFetch(() => Response.json({ id: "msg_welcome" }));
    const ctx = tracker();
    const first = await readJson(
      await post(
        "/api/subscribe",
        { email: "Ada@Example.com", url: "https://evil.example/phish", "cf-turnstile-response": "valid-subscribe" },
        env,
        ctx,
        { "X-Forwarded-Host": "evil.example" }
      )
    );
    await settle(ctx);
    assert.equal(first.status, 200);
    assert.equal(first.body.result, "subscribed");
    assert.equal(JSON.stringify(first.body).includes("delivered"), false);
    assert.equal(first.headers.get("access-control-allow-origin"), ORIGIN);
    const second = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, tracker())
    );
    assert.equal(second.body.result, "already_subscribed");
    const jobs = await db.prepare("SELECT * FROM email_outbox").all();
    assert.equal(jobs.results.length, 1);
    const job = jobs.results[0];
    assert.equal(job.status, "sent");
    assert.equal(job.provider_message_id, "msg_welcome");
    assert.equal(job.recipient, "ada@example.com");
    assert.equal(job.html.includes("ada@example.com"), false);
    assert.equal(job.html.includes("evil.example"), false);
    assert.match(job.html, /https:\/\/roseva\.com\/unsubscribe\?token=/);
    assert.match(job.html, />Unsubscribe</);
    const headers = JSON.parse(job.headers_json);
    assert.match(headers["List-Unsubscribe"], /^<https:\/\/roseva\.com\/unsubscribe\?token=/);
    assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    const token = decodeURIComponent(job.html.match(/token=([^"]+)/)[1]);
    const row = await db.prepare("SELECT * FROM subscribers").first();
    assert.equal(row.status, "subscribed");
    assert.equal(row.unsubscribe_token_hash, await sha256Hex(token));
    assert.equal(JSON.stringify(row).includes(token), false);
    const sent = resendCalls(calls)[0];
    assert.equal(header(sent.init, "Idempotency-Key"), job.idempotency_key);
    assert.equal(header(sent.init, "Authorization"), "Bearer test-resend-key");
    assert.equal(payload(sent.init).from, "Roseva <support@roseva.com>");
    assert.equal(payload(sent.init).reply_to, "support@roseva.com");
  });

  it("requires confirmation before an unsubscribed address is active again", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    installFetch(() => Response.json({ id: "msg_1" }));
    const ctx = tracker();
    await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, ctx);
    await settle(ctx);
    const welcome = await db.prepare("SELECT html FROM email_outbox WHERE kind = 'welcome'").first();
    const token = decodeURIComponent(welcome.html.match(/token=([^"]+)/)[1]);
    const before = await handleRequest(new Request(`${ORIGIN}/unsubscribe?token=${encodeURIComponent(token)}`), env);
    assert.equal(before.status, 200);
    assert.match(await before.text(), /Confirm that you no longer want/);
    assert.equal((await db.prepare("SELECT status FROM subscribers").first()).status, "subscribed");
    const confirmed = await handleRequest(
      new Request(`${ORIGIN}/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: new URLSearchParams({ token })
      }),
      env
    );
    assert.equal(confirmed.status, 200);
    assert.match(await confirmed.text(), /You are unsubscribed/);
    const again = await handleRequest(
      new Request(`${ORIGIN}/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token })
      }),
      env
    );
    assert.equal(again.status, 200);
    assert.deepEqual(await listSubscribedRecipients(db), []);
    const reactivation = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, tracker())
    );
    assert.equal(reactivation.body.result, "confirmation_required");
    assert.equal((await db.prepare("SELECT status FROM subscribers").first()).status, "unsubscribed");
    const repeat = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, tracker())
    );
    assert.equal(repeat.body.result, "confirmation_required");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'reactivation'").first()).n, 1);
    const confirmation = await db.prepare("SELECT html FROM email_outbox WHERE kind = 'reactivation'").first();
    const confirmToken = decodeURIComponent(confirmation.html.match(/token=([^"]+)/)[1]);
    const preview = await handleRequest(new Request(`${SITE}/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`), env);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /Confirm if you want Roseva news/);
    assert.equal((await db.prepare("SELECT status FROM subscribers").first()).status, "unsubscribed");
    const confirmCtx = tracker();
    const accepted = await handleRequest(
      new Request(`${SITE}/subscribe/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: confirmToken })
      }),
      env,
      confirmCtx
    );
    await settle(confirmCtx);
    assert.match(await accepted.text(), /You\u2019re now subscribed/);
    assert.equal((await db.prepare("SELECT status FROM subscribers").first()).status, "subscribed");
    const used = await handleRequest(
      new Request(`${SITE}/subscribe/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: confirmToken })
      }),
      env,
      tracker()
    );
    assert.equal(used.status, 400);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'welcome'").first()).n, 2);
    assert.deepEqual(await listSubscribedRecipients(db), ["ada@example.com"]);
  });

  it("honors one-click unsubscribe without putting the email in the URL", async () => {
    const db = new TestDatabase();
    const env = createEnv(db, { PUBLIC_SITE_URL: "" });
    installFetch(() => Response.json({ id: "msg_click" }));
    const ctx = tracker();
    await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, ctx);
    await settle(ctx);
    const job = await db.prepare("SELECT html, headers_json FROM email_outbox").first();
    assert.equal(job.html.includes("email="), false);
    assert.match(job.html, /^[\s\S]*http:\/\/127\.0\.0\.1:8787\/unsubscribe\?token=/);
    const token = decodeURIComponent(job.html.match(/token=([^"]+)/)[1]);
    const clicked = await handleRequest(
      new Request(`${ORIGIN}/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.20" },
        body: "List-Unsubscribe=One-Click"
      }),
      env
    );
    assert.equal(clicked.status, 200);
    assert.equal(await clicked.text(), "");
    assert.equal((await db.prepare("SELECT status FROM subscribers").first()).status, "unsubscribed");
    const repeated = await handleRequest(
      new Request(`${ORIGIN}/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click"
      }),
      env
    );
    assert.equal(repeated.status, 200);
  });

  it("stores a contact message once and queues both emails", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    const calls = installFetch(() => Response.json({ id: "msg_contact" }));
    const ctx = tracker();
    const created = await readJson(await post("/api/contact", contactFields, env, ctx));
    await settle(ctx);
    assert.equal(created.status, 200);
    assert.equal(created.body.result, "received");
    assert.equal(JSON.stringify(created.body).includes("delivered"), false);
    const changed = await readJson(
      await post("/api/contact", { ...contactFields, message: "A different message", "cf-turnstile-response": "valid-contact" }, env, tracker())
    );
    assert.equal(changed.body.result, "received");
    const messages = await db.prepare("SELECT * FROM contact_messages").all();
    assert.equal(messages.results.length, 1);
    assert.equal(messages.results[0].email, "ada@example.com");
    assert.equal(messages.results[0].mobile, "+971501234567");
    assert.equal(messages.results[0].message, "Hello\n<script>");
    const jobs = await db.prepare("SELECT kind, html, text_body, reply_to FROM email_outbox ORDER BY id").all();
    assert.deepEqual(jobs.results.map((job) => job.kind), ["contact_internal", "contact_ack"]);
    assert.equal(jobs.results[0].html.includes("<script>"), false);
    assert.match(jobs.results[0].html, /&lt;script&gt;/);
    assert.match(jobs.results[0].html, /&quot;Motors&quot;/);
    assert.equal(jobs.results[0].reply_to, "ada@example.com");
    assert.match(jobs.results[1].text_body, /Dear <Ada>,/);
    assert.match(jobs.results[1].text_body, /We\u2019ve received your message,/);
    assert.match(jobs.results[1].text_body, /within the next 24 hours\./);
    assert.match(jobs.results[1].text_body, /Roseva Team/);
    assert.equal(jobs.results[1].reply_to, "support@roseva.com");
    const sent = resendCalls(calls).map((call) => payload(call.init));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].reply_to, "ada@example.com");
    assert.deepEqual(sent[0].to, ["support@roseva.com"]);
    assert.equal(sent[1].reply_to, "support@roseva.com");
    assert.deepEqual(sent[1].to, ["ada@example.com"]);
    const missing = await readJson(
      await post("/api/contact", { ...contactFields, firstName: "", requestId: "request-5678", "cf-turnstile-response": "valid-contact" }, env)
    );
    assert.equal(missing.status, 400);
    assert.equal(missing.body.fields.firstName, "Enter your first name.");
    const phone = await readJson(
      await post(
        "/api/contact",
        { ...contactFields, mobile: "0501234567", requestId: "request-6789", "cf-turnstile-response": "valid-contact" },
        env
      )
    );
    assert.equal(phone.status, 400);
    assert.match(phone.body.fields.mobile, /country code/);
  });

  it("does not report success when the database write fails", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    installFetch(() => Response.json({ id: "msg_should_not_send" }));
    db.failNextBatch = true;
    const ctx = tracker();
    const response = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, ctx)
    );
    assert.equal(response.status, 500);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /Nothing was confirmed as saved/);
    assert.equal(ctx.jobs.length, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM subscribers").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM email_outbox").first()).n, 0);
  });

  it("retries transient email failures and stops permanent ones", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    let mode = "down";
    const calls = installFetch(() => {
      if (mode === "down") {
        return new Response("unavailable", { status: 503 });
      }
      if (mode === "rejected") {
        return new Response("rejected", { status: 422 });
      }
      return Response.json({ id: "msg_retried" });
    });
    const ctx = tracker();
    await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env, ctx);
    await settle(ctx);
    let job = await db.prepare("SELECT * FROM email_outbox").first();
    assert.equal(job.status, "pending");
    assert.equal(job.attempt_count, 1);
    assert.ok(job.next_retry_at > Date.now());
    const key = header(resendCalls(calls)[0].init, "Idempotency-Key");
    await processOutbox(env, { now: job.next_retry_at - 1 });
    assert.equal(resendCalls(calls).length, 1);
    mode = "up";
    const cron = tracker();
    await worker.scheduled({}, env, cron);
    await settle(cron);
    await processOutbox(env, { now: job.next_retry_at });
    job = await db.prepare("SELECT * FROM email_outbox").first();
    assert.equal(job.status, "sent");
    assert.equal(job.provider_message_id, "msg_retried");
    assert.equal(header(resendCalls(calls).at(-1).init, "Idempotency-Key"), key);
    mode = "rejected";
    await db.prepare("UPDATE email_outbox SET status = 'pending', attempt_count = 0, next_retry_at = 0, provider_message_id = NULL").run();
    await processOutbox(env, { now: Date.now() });
    job = await db.prepare("SELECT status, attempt_count FROM email_outbox").first();
    assert.equal(job.status, "failed");
    const sentBefore = resendCalls(calls).length;
    await processOutbox(env, { now: Date.now() + 86_400_000 });
    assert.equal(resendCalls(calls).length, sentBefore);
  });

  it("lets only one worker claim an outbox job", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    installFetch(() => Response.json({ id: "msg_locked" }));
    await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, env);
    const row = await db.prepare("SELECT id FROM email_outbox").first();
    const now = Date.now();
    const sql =
      "UPDATE email_outbox SET claim_token = ?, locked_until = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until <= ?)";
    const first = await db.prepare(sql).bind("worker-a", now + 60_000, now, row.id, now).run();
    const second = await db.prepare(sql).bind("worker-b", now + 60_000, now, row.id, now).run();
    assert.equal(first.meta.changes, 1);
    assert.equal(second.meta.changes, 0);
    await processOutbox(env, { now });
    assert.equal((await db.prepare("SELECT status, claim_token FROM email_outbox").first()).claim_token, "worker-a");
  });

  it("keeps submissions disabled and mail queued when configuration is missing", async () => {
    const db = new TestDatabase();
    const disabled = createEnv(db, { TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });
    const config = await (await handleRequest(new Request(`${ORIGIN}/api/config`), disabled)).json();
    assert.equal(config.submissionsEnabled, false);
    assert.equal(config.turnstileSiteKey, null);
    assert.equal(JSON.stringify(config).includes("turnstile-secret"), false);
    const rejected = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, disabled)
    );
    assert.equal(rejected.status, 503);
    assert.match(rejected.body.error, /temporarily unavailable/);
    const secretOnly = createEnv(db, { TURNSTILE_SITE_KEY: "" });
    assert.equal((await (await handleRequest(new Request(`${ORIGIN}/api/config`), secretOnly)).json()).submissionsEnabled, false);
    const calls = installFetch(() => {
      throw new Error("mail should stay queued");
    });
    const unsent = createEnv(db, { RESEND_API_KEY: "" });
    const ctx = tracker();
    const saved = await readJson(
      await post("/api/subscribe", { email: "ada@example.com", "cf-turnstile-response": "valid-subscribe" }, unsent, ctx)
    );
    await settle(ctx);
    assert.equal(saved.body.result, "subscribed");
    assert.equal(resendCalls(calls).length, 0);
    assert.equal((await db.prepare("SELECT status, attempt_count FROM email_outbox").first()).status, "pending");
    const health = await (await handleRequest(new Request(`${ORIGIN}/api/health`))).json();
    assert.deepEqual(health, { ok: true });
    const missing = await handleRequest(new Request(`${ORIGIN}/api/subscribers`), unsent);
    assert.equal(missing.status, 404);
  });

  it("rate limits repeated form posts", async () => {
    const db = new TestDatabase();
    const env = createEnv(db);
    installFetch(() => Response.json({ id: "msg_rate" }));
    let last = null;
    for (let index = 0; index < 9; index += 1) {
      last = await readJson(
        await post(
          "/api/subscribe",
          { email: `person${index}@example.com`, "cf-turnstile-response": "valid-subscribe" },
          env,
          tracker()
        )
      );
    }
    assert.equal(last.status, 429);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM subscribers").first()).n, 8);
  });

  it("rolls a failed batch back and keeps the public copy in the frontend", async () => {
    const db = new TestDatabase();
    await assert.rejects(() =>
      db.batch([db.prepare("CREATE TABLE rollback_probe (id INTEGER)"), db.prepare("INSERT INTO missing_table (id) VALUES (1)")])
    );
    assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'rollback_probe'").first(), null);
    const script = readFileSync(new URL("../public/script.js", import.meta.url), "utf8");
    const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    assert.match(script, /Thank you for subscribing! You\\u2019re now subscribed to Roseva news and updates\./);
    assert.match(script, /Thank you! Your message has been received\. The relevant department will contact you within 24 hours\./);
    assert.equal(script.includes("PREVIEW_ONLY"), false);
    assert.equal(page.includes("Preview only"), false);
    assert.match(page, /assets\/roseva-logo\.svg/);
    for (const file of readdirSync(new URL("../src/", import.meta.url))) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      assert.equal(source.includes("console."), false);
      assert.equal(source.includes("re_"), false);
    }
  });
});
