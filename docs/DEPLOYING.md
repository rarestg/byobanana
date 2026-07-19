# Deploying

This guide is for deploying **your own** copy of BYOBanana to Cloudflare. It has no backend, so
"deploy" means uploading the static build (`dist/`) to Cloudflare's edge.

> **`byobanana.com` is the original author's deployment and domain.** A fork configures its own
> `SITE_URL` (below), its own domain and routes, and (optionally) its own Worker name. None of the
> author's infrastructure is shared: Worker names are scoped to a Cloudflare account, so on your own
> account you can keep `nano-banana-web` or pick any other name freely (see
> [Worker name](#worker-name)).

## Prerequisites

- A **Cloudflare account** (the free plan is enough for static assets).
- **Wrangler**, Cloudflare's CLI. It ships as a dev dependency, so `npm ci` installs it; commands
  below use it via `npx wrangler` or the npm scripts.
- Authentication. Either `npx wrangler login` (interactive) or a **`CLOUDFLARE_API_TOKEN`**
  environment variable (a token with Workers Scripts + Workers Routes permissions for your account;
  add zone permissions too if you bind a custom domain).

## `SITE_URL`: ship your own canonical URLs (read this first)

The committed source bakes the author's origin (`https://byobanana.com`) into the canonical / Open
Graph / JSON-LD URLs, `sitemap.xml`, and `robots.txt`.

So if you deploy **either** path without configuring your origin, your fork ships canonical +
sitemap URLs pointing at **the author's** site (search engines would then treat the author's site as
the canonical version of your pages). On top of that, the **generated-Worker** path treats the baked
origin as the one crawlable host and adds `X-Robots-Tag: noindex` to every other host, so an
unconfigured generated-Worker deploy also **noindexes itself**.

Fix both by setting `SITE_URL` to your own origin at deploy time (a bare `https://host` origin: no
path, query, or trailing slash):

```sh
SITE_URL=https://yourdomain.com npm run deploy         # native path
SITE_URL=https://yourdomain.com npm run deploy:worker  # generated-Worker path
```

`SITE_URL` is applied as a post-build rewrite over `dist/` (see `scripts/site-url.mjs`): it swaps
the baked origin in the built HTML/xml/txt and derives the Worker's production host (for the noindex
and canonicalization logic) from it. When `SITE_URL` is unset it defaults to `https://byobanana.com`
and the rewrite is a byte-for-byte no-op. It does **not** rewrite your Worker name or routes: those
are separate edits below.

## Default path: native Workers Static Assets

This is the intended, simplest path. `wrangler.jsonc` declares an assets-only Worker (no code) that
serves `dist/` straight from the edge, applying the `public/_headers` CSP and security headers.

```sh
SITE_URL=https://yourdomain.com npm run deploy
# = npm run build && wrangler deploy   (npm run build applies the SITE_URL rewrite to dist/)
```

This uploads to a `*.workers.dev` preview URL. To serve it on your own domain, add your zone to the
same Cloudflare account and bind routes (see [Custom domain](#custom-domain)).

## Fallback path: the generated Worker

Some environments cannot use the native Static Assets upload flow. It needs a per-session upload
JWT, and any setup that rewrites the Cloudflare API request (for example a corporate or CI proxy
that injects the account token on every request) can clobber that JWT and return `401` on
`/workers/assets/upload`. For those environments there is a fallback: `scripts/build-worker.mjs`
embeds the built files into a tiny Worker **script** (which uploads fine) that serves them and
applies the **same** `public/_headers`.

> **Before you run this, edit `scripts/build-worker.mjs`.** Its `wranglerConfig` template ships the
> **author's** `routes` (`byobanana.com`, `www.byobanana.com`) uncommented; deploying them as-is on
> your account will fail (you do not own that zone). Replace them with your own routes (see
> [Custom domain](#custom-domain)) or remove the block, and set `PREVIEW_REDIRECT` appropriately (see
> [Preview redirect](#preview-redirect)). You may also change the Worker `name` there.

```sh
SITE_URL=https://yourdomain.com npm run deploy:worker
# = npm run build && node scripts/build-worker.mjs && wrangler deploy --config worker-dist/wrangler.jsonc
```

The two paths are **not** behaviorally identical. The generated Worker adds request handling the
native path does not:

- host canonicalization: `www.<host>` -> apex, `http` -> `https`, `/index.html` -> `/`, directory
  paths -> trailing slash, all in a single redirect hop;
- `X-Robots-Tag: noindex` on every host **except** your `SITE_URL` host, so a preview host stays
  unindexed while your production host is crawlable;
- `Cache-Control: no-cache` on the non-hashed root assets (hashed `/assets/*` stay immutable);
- `Allow` / `400` / `405` method-and-malformed-URL hardening.

Prefer the native `npm run deploy` unless your environment forces the fallback or you specifically
want that extra host/robots logic.

## Worker name

Worker names are scoped to a Cloudflare account, so there is no global collision with the author's
Worker: on your own account you can keep `"name": "nano-banana-web"` or pick any other name. It is
set in `wrangler.jsonc` (native path) and in the `wranglerConfig` template near the bottom of
`scripts/build-worker.mjs` (generated path); change it in whichever path you deploy if you prefer a
different name. (`ARCHITECTURE.md` lists the Worker name among "frozen identifiers": that is about
not renaming an **existing live** deployment, because the custom domains bind to the name. It does
not constrain a fresh fork.)

## Custom domain

Serve on your own domain by binding routes on **your** Cloudflare zone (a domain you have added to
your account):

- **Native path:** add a `routes` block to `wrangler.jsonc`, or attach a custom domain in the
  Cloudflare dashboard (Workers -> your Worker -> Domains & Routes).
- **Generated path:** in `scripts/build-worker.mjs`, edit the `routes` array in the `wranglerConfig`
  template to your own patterns, for example:

  ```jsonc
  "routes": [
    { "pattern": "yourdomain.com", "custom_domain": true },
    { "pattern": "www.yourdomain.com", "custom_domain": true }
  ]
  ```

  Then `SITE_URL=https://yourdomain.com npm run deploy:worker`. Wrangler creates the proxied DNS
  records and requests the edge certificate; a brand-new custom domain can return a TLS handshake
  error for a few minutes until the certificate issues.

Set `SITE_URL` to the same apex so canonicals, the sitemap, and the noindex logic all agree.

## Preview redirect

The generated Worker has a `PREVIEW_REDIRECT` constant (in the `worker` template in
`scripts/build-worker.mjs`). When `true`, any non-production host (the `*.workers.dev` preview,
localhost) `301`-redirects to your production apex in a single hop, so a preview can never serve a
duplicate of your live site or compete with it in search. When `false`, non-production hosts serve
`200` with the `noindex` tag instead.

**The committed source ships `PREVIEW_REDIRECT = true`** (it reflects the author's live apex). For a
fork, set it to `false` until your own apex is actually live, otherwise every preview/localhost hit
will redirect to a `SITE_URL` that is not yet serving. Once your apex is live, set it back to `true`
and redeploy.

## Rollback

```sh
npx wrangler rollback                                   # native path
npx wrangler rollback --config worker-dist/wrangler.jsonc   # generated path
```

Rolling back reverts the Worker version; any attached custom domains stay bound.
