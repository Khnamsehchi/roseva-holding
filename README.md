# Roseva Group website

Plain HTML, CSS, and JavaScript in `public/`. The Worker in `src/` serves those files and handles newsletter, contact, and unsubscribe requests. There is no frontend build step. The supplied logo in `public/assets/` is unchanged.

## Preview

From this folder:

```powershell
npm run dev
```

Wrangler serves the site, usually at `http://127.0.0.1:8787/`. The draft notice is at `privacy-policy.html`.

Forms stay disabled until Turnstile is configured. See `SETUP.md` for the remaining Cloudflare settings. Do not treat a saved submission as proof that an email was delivered.

## Still needed before launch

- Turnstile site key and secret, and the remote D1 migration (`SETUP.md`)
- Official RosevaFX and Roseva Motors logos (they are not in `assets/`; the page uses styled names until the logos are supplied)
- LinkedIn and Instagram URLs (the icons are labeled “Coming soon” and are not links)
- Final privacy policy text, including the operating entity, contact details, and data practices
