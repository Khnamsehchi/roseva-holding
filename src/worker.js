import { confirmSubscription, configResponse, json, routeApi, unsubscribe } from "./handlers.js";
import { processOutbox } from "./mail.js";

export { listSubscribedRecipients, processOutbox } from "./mail.js";

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return jsonResponseForConfig(env);
    }
    if (url.pathname.startsWith("/api/")) {
      const api = await routeApi(request, env, ctx);
      if (api) {
        return api;
      }
      return json({ error: "Not found" }, 404);
    }
    if (url.pathname === "/unsubscribe") {
      return unsubscribe(request, env);
    }
    if (url.pathname === "/subscribe/confirm") {
      return confirmSubscription(request, env, ctx);
    }
    if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response("Not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  } catch {
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
}

function jsonResponseForConfig(env) {
  return configResponse(env);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processOutbox(env).catch(() => null));
  }
};
