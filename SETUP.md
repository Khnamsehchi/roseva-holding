# Roseva setup checklist

The Worker name is `roseva-holding`. Frontend files stay in `public/`. Backend source stays in `src/`. Do not put secret values in this file, in `wrangler.jsonc`, or in the frontend.

## Already set

- D1 binding `DB`
- D1 database name `roseva-holding-db`
- D1 database id `4105b7c1-03a9-4e6c-9e27-3e334fcb4b25`
- `RESEND_API_KEY` exists on the deployed Worker. Do not print or replace it unless you intend to rotate it.

## Still required before real submissions work

1. Apply the database migration to the remote D1 database:

   ```sh
   npx wrangler d1 migrations apply roseva-holding-db --remote
   ```

2. Create a Cloudflare Turnstile widget for the production hostname. Then set the two keys:

   - `TURNSTILE_SECRET_KEY` as a Worker secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`
   - `TURNSTILE_SITE_KEY` as a public Worker variable, not as a secret

   Both must be present. If either one is missing, both forms stay disabled and the API returns “temporarily unavailable”. Verification is never skipped.

3. Confirm `support@roseva.com` is allowed to send through Resend. The sender is `Rozeva Group <support@roseva.com>`.

4. Set `PUBLIC_SITE_URL` to the public site origin, such as `https://roseva.com`, before relying on links in email. Unsubscribe and confirmation links use that origin when it is set. They otherwise use the Worker request origin. They never use a URL submitted with the form.

## Local checks

```sh
npx wrangler d1 migrations apply roseva-holding-db --local
npm test
npx wrangler deploy --dry-run
```

`npm test` uses a local database and mocked Resend and Turnstile calls. It does not send email. Do not run the remote migration, deploy, or push until the checklist above is done.
