# Roseva Group website

Frontend preview for the Roseva holding company site. Plain HTML, CSS, and JavaScript. No build step. The supplied files in `assets/` are unchanged.

## Preview

Open `index.html` in a browser, or from this folder start a static server and visit the local address:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080/`. The draft notice is at `privacy-policy.html`. JavaScript is used for the mobile menu, field checks, and the preview message.

The site is set up as static files so it can later be served as Cloudflare Workers Static Assets.

## Still needed before launch

- Backend for `POST /api/subscribe` and `POST /api/contact` (`script.js` keeps `PREVIEW_ONLY` on, so those addresses are not called)
- Email provider for newsletter delivery and contact messages
- Unsubscribe flow
- Official RosevaFX and Roseva Motors logos (they are not in `assets/`; the page uses styled names until the logos are supplied)
- LinkedIn and Instagram URLs (the icons are labeled “Coming soon” and are not links)
- Final privacy policy text, including the operating entity, contact details, and data practices

Do not launch the forms or `privacy-policy.html` until those items are in place. The forms are a preview only. They do not send or save personal information.
