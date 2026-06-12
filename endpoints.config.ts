/**
 * Source-of-truth configuration for the standalone endpoints reference.
 *
 * The reference covers exactly the namespaces in `INCLUDE_PREFIXES`. The set of
 * endpoints is derived automatically: `scripts/seed-allowlist.ts` enumerates every
 * query/procedure NSID published in those namespaces (skipping unspecced/temp/
 * deprecated and anything in `EXCLUDE`), writes them to `lexicons.json`, and
 * `@atproto/lex` fetches them plus any transitively-referenced schema defs. The
 * defs are needed for `$ref`s but are never listed as endpoints.
 *
 * - `INCLUDE_PREFIXES` — the curated namespaces. This is the one place to widen or
 *   narrow scope. Editing it changes what `seed-allowlist` pulls in and what the
 *   converter is willing to emit a path for.
 * - `NAMESPACE_ORDER` biases grouping/order in the rendered reference.
 */

/** Namespaces this reference covers (and the only ones converted to endpoints). */
export const INCLUDE_PREFIXES: string[] = [
  "app.bsky.",
  "com.atproto.",
  "chat.bsky.",
  "tools.ozone.",
];

/**
 * Canonical accounts that publish the `com.atproto.lexicon.schema` records for the
 * namespaces above. Used by `seed-allowlist` to ENUMERATE every endpoint: DNS
 * resolves an individual NSID's authority, but only listing a repo enumerates a
 * whole namespace. These are stable; each can be re-derived from the `_lexicon.*`
 * TXT records (e.g. did:plc:4v4y5r3... is `bsky-lexicons.bsky.social`).
 */
export const SCHEMA_AUTHORITIES: string[] = [
  "did:plc:4v4y5r3lwsbtmsxhile2ljac", // app.bsky.*, chat.bsky.*
  "did:plc:6msi3pj7krzih5qxqtryxlzw", // com.atproto.*
  "did:plc:33dt5kftu3jq2h5h4jjlqezt", // tools.ozone.*
];

/** Exact NSIDs to drop even though they are query/procedure endpoints. */
export const EXCLUDE: string[] = [];

/**
 * Live-implementation boundary (`scripts/probe-implemented.ts` → `npm run probe`).
 *
 * The schema authorities publish every *specced* `com.atproto` endpoint, but
 * Bluesky's live services don't necessarily serve all of them yet — e.g. the newer
 * `com.atproto.identity` GET methods (`resolveDid`, `resolveIdentity`,
 * `refreshIdentity`) currently return `501 MethodNotImplemented`. The probe calls
 * each enumerated `com.atproto` **query** against the canonical Bluesky hosts and
 * records the ones that aren't served anywhere into `UNIMPLEMENTED_MANIFEST`;
 * `build-openapi` then unlists those (no path, no sidebar tag), exactly like
 * deprecated/unspecced endpoints. Only queries are probed — we never fire
 * procedures (writes) at the live network.
 *
 * Routing is the whole trick. Each method has a *home* service, and every host
 * returns `501 MethodNotImplemented` for methods that aren't its own, so a single
 * host can't tell "unimplemented" from "lives elsewhere". We probe a panel:
 *   - `appview` / `relay` are POSITIVE-only signals: a non-501 there means "served
 *     here, keep it" (this is what rescues `identity.resolveHandle`, `repo.getRecord`,
 *     `sync.*`); their 501 means nothing.
 *   - `pds` is the AUTHORITATIVE signal, but only once authenticated. The entryway
 *     auth-gates *before* method resolution, so unauthenticated every method — real
 *     or not — returns `401`. Set `BSKY_PROBE_IDENTIFIER` + `BSKY_PROBE_APP_PASSWORD`
 *     (any account's app password works — the probe only sends GETs, so it never
 *     writes despite the password's full scope) to get
 *     a real `501`-vs-`200/400` answer. Override the host with `BSKY_PROBE_PDS` if
 *     self-hosted. Without credentials the probe is a safe no-op: it can't reach the
 *     true handler, so it unlists nothing and warns.
 *
 * The decision per endpoint: keep if any host says implemented; unlist only if the
 * authoritative PDS says `501 MethodNotImplemented`; otherwise keep (inconclusive).
 */
export const PROBE_NAMESPACE = "com.atproto.";
export const PROBE_HOSTS = {
  appview: "https://public.api.bsky.app",
  relay: "https://relay1.us-west.bsky.network",
  pds: "https://bsky.social",
};
export const UNIMPLEMENTED_MANIFEST = "unimplemented.json";

/**
 * Group/sort bias: namespaces matching earlier prefixes render first. Anything not
 * matched falls to the end in lexical order. Used to build OpenAPI `x-tagGroups`
 * and to sort the `tags` array.
 */
export const NAMESPACE_ORDER: string[] = [
  "app.bsky.",
  "com.atproto.",
  "chat.bsky.",
  "tools.ozone.",
];

/**
 * The reference is split into several documents, surfaced as a switcher dropdown
 * in the rendered site (Scalar's multi-source `sources`). Each view owns a subset
 * of the covered namespaces; an endpoint lands in the first view whose `prefixes`
 * match its NSID. Every view shares the same Introduction (`info.description`).
 *
 * `slug` is the document's URL key — it appears in the hash (e.g.
 * `#bluesky-dms/description/introduction`) and is what the Introduction's
 * cross-links point at, so keep these in sync with `SHARED_DESCRIPTION`.
 */
export interface View {
  slug: string;
  title: string;
  prefixes: string[];
}

export const VIEWS: View[] = [
  { slug: "bluesky-app", title: "Bluesky App", prefixes: ["app.bsky.", "com.atproto."] },
  { slug: "bluesky-dms", title: "Bluesky DMs", prefixes: ["chat.bsky."] },
  { slug: "ozone-moderation", title: "Ozone Moderation", prefixes: ["tools.ozone."] },
];

