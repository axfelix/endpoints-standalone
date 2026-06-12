# Bluesky HTTP API endpoint reference

A standalone, OpenAPI-driven static reference for Bluesky's HTTP/XRPC endpoints,
generated from the canonical on-network lexicon schemas. This replaces the old
`docs/api` reference that was embedded in (and slowed down) the Docusaurus build.

## How it works

```
endpoints.config.ts (INCLUDE_PREFIXES + SCHEMA_AUTHORITIES)
      │  scripts/seed-allowlist.ts  (enumerate every query/procedure NSID)
      ▼
lexicons.json (allowlist, CID-pinned)
      │  @atproto/lex  (resolves NSIDs via DNS, fetches + transitive defs)
      ▼
lexicons/**/*.json  (committed lexicon documents)
      │  scripts/probe-implemented.ts  (live-probe com.atproto queries)
      ▼
unimplemented.json (com.atproto endpoints the network 501s; build input)
      │  src/build-openapi.ts  (lexicon -> OpenAPI converter, one doc per view)
      ▼
openapi.<view>.json  (Bluesky App / Bluesky DMs / Ozone Moderation)
      │  src/render.ts  (vendors Scalar's MIT standalone bundle)
      ▼
out/  (index.html + openapi.<view>.json + scalar.standalone.js — fully self-contained)
```

- **Scope is by namespace, endpoints are auto-discovered.** `INCLUDE_PREFIXES` in
  `endpoints.config.ts` defines which namespaces the reference covers
  (`app.bsky.*`, `com.atproto.*`, `chat.bsky.*`, `tools.ozone.*`). `npm run seed`
  enumerates *every* query/procedure NSID published in them (from the canonical
  accounts in `SCHEMA_AUTHORITIES`), skipping unspecced/temp/deprecated and
  anything in `EXCLUDE`, and writes the result to `lexicons.json`.
- **Only endpoints get cards.** The converter emits a path (and sidebar tag) only
  for query/procedure defs in the included namespaces. Referenced schema defs
  (`*.defs`, records, tokens) become OpenAPI components — needed for `$ref`s — but
  never appear as empty endpoint cards. Deprecated schema defs are kept (so refs
  don't dangle) but flagged `deprecated`.
- **Unimplemented `com.atproto` endpoints are unlisted.** The schema authorities
  publish every *specced* `com.atproto` endpoint, but Bluesky's live services don't
  serve all of them (e.g. `com.atproto.identity.resolveDid` / `resolveIdentity`
  currently return `501 MethodNotImplemented`). `npm run probe`
  (`scripts/probe-implemented.ts`) calls each `com.atproto` **query** against the
  canonical hosts, records the ones nobody answers in `unimplemented.json`, and the
  converter drops those cards — same treatment as deprecated/unspecced. Routing is
  the trick: every host `501`s methods that aren't its own, so AppView/relay are
  used as positive ("served here") signals only and an **authenticated** PDS is the
  authority (the entryway auth-gates before method resolution, so unauthenticated
  every method returns `401`). Only queries are probed — procedures (writes) are
  never fired at the live network. See the `PROBE_*` note in `endpoints.config.ts`.
- **Split into views.** `VIEWS` in `endpoints.config.ts` partitions the namespaces
  into separate OpenAPI documents — Bluesky App (`app.bsky.*` + `com.atproto.*`),
  Bluesky DMs (`chat.bsky.*`), and Ozone Moderation (`tools.ozone.*`) — each written
  as `openapi.<slug>.json`. The renderer surfaces them via Scalar's multi-source
  switcher (the dropdown in the top left). All views share the same Introduction.
- **Bluesky-first ordering:** within each view, `NAMESPACE_ORDER` biases
  `app.bsky.*` and `com.atproto.*` ahead of the rest (rendered via OpenAPI
  `x-tagGroups`). Shared auth/proxy guidance lives in the OpenAPI `info.description`
  rendered as each view's Introduction (`SHARED_DESCRIPTION` in `build-openapi.ts`).

## Commands

```bash
npm install                  # one-time
npm run seed                 # enumerate endpoints in INCLUDE_PREFIXES -> lexicons.json + fetch
npm run probe                # live-probe com.atproto queries -> unimplemented.json
npm run build                # install-lexicons:ci -> build:openapi -> build:site
npm run build:openapi        # lexicons/ -> openapi.<view>.json (one per VIEW)
npm run build:site           # openapi.<view>.json -> out/
npx serve out                # preview (use http; file:// won't fetch the JSON)
```

Changing scope: edit `INCLUDE_PREFIXES` / `EXCLUDE` in `endpoints.config.ts`, run
`npm run seed`, then commit `lexicons.json` + `lexicons/`. The refresh CI runs
`npm run seed` weekly and opens a PR when the published endpoints change.

Refreshing the implementation boundary: `npm run probe` regenerates
`unimplemented.json`; commit it and rebuild. For the authoritative check, give it an
[app password](https://bsky.app/settings/app-passwords). Bluesky app passwords carry
full account access (there's no read-only kind), but the probe only ever sends `GET`s
— it never writes — so a throwaway/secondary account's app password is plenty:

```bash
BSKY_PROBE_IDENTIFIER=you.bsky.social \
BSKY_PROBE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
npm run probe                # BSKY_PROBE_PDS overrides the PDS host if self-hosted
```

Without credentials the probe is a safe no-op: it can't get past the PDS auth gate,
so it unlists nothing and reports the auth-gated endpoints as inconclusive. To keep
the boundary fresh automatically, run `npm run probe` in the weekly refresh workflow
with the app password stored as a CI secret.

## CI

- `.github/workflows/endpoints-build.yml` — verifies pinned lexicons, builds the
  spec + site, uploads the artifact (deploy step deferred to the host).
- `.github/workflows/endpoints-refresh-lexicons.yml` — weekly `lex install
  --update`; opens a PR when canonical schemas change.

## Notes

- `scripts/lex.mjs` wraps the `@atproto/lex` CLI to work around
  [nodejs/node#62347](https://github.com/nodejs/node/issues/62347) (Windows-only
  loopback-DNS bug that breaks `lex`'s `_lexicon.*` TXT lookups). It is a no-op on
  healthy systems, including Linux CI.
- `openapi.*.json` and `out/` are git-ignored; they are regenerated from the
  committed `lexicons/` + `lexicons.json`.
