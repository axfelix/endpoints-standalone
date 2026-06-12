/**
 * Lexicon -> OpenAPI converter.
 *
 * Node/TS port of the original Deno `atproto-openapi-types/main.ts`. Reads the
 * lexicon JSON installed by `@atproto/lex` (`lexicons/**​/*.json`), converts each
 * query/procedure into an OpenAPI path and each schema def into a component.
 * Endpoints are partitioned by namespace into the views in `VIEWS`, and one
 * `openapi.<slug>.json` document is written per view. The rendered reference
 * (Scalar) loads them as a multi-source switcher.
 */
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";
import type { OpenAPIV3_1 } from "openapi-types";

import { calculateTag, loadLexicon } from "./lib/utils";
import { codeSamplesFor } from "./lib/codesamples";

/**
 * Heuristic: does this operation require an authenticated session?
 *
 * Lexicons mark some endpoints with "Requires auth" in the description but the
 * convention is incomplete (e.g. `chat.bsky.*` and `tools.ozone.*` rarely use
 * it). We additionally treat the following as auth-required:
 *   - everything proxied via PDS to chat/Ozone backends
 *   - every write under `app.bsky.*` and `com.atproto.repo.*`
 *
 * `com.atproto.server.*` procedures are deliberately *not* auto-flagged: that's
 * where unauthenticated bootstrap endpoints live (createSession, createAccount,
 * requestPasswordReset, ...). The few server endpoints that do require auth
 * (deleteAccount, refreshSession, ...) already say so in their description.
 *
 * The flag is surfaced to Scalar as a per-operation `security: [{ Bearer: [] }]`
 * — that drives the "Auth Required" badge and lets the renderer hide the
 * misleading test-request button.
 */
function requiresAuth(id: string, def: any): boolean {
  if (id.startsWith("chat.bsky.") || id.startsWith("tools.ozone.")) return true;
  if (def.type === "procedure") {
    if (id.startsWith("app.bsky.") || id.startsWith("com.atproto.repo.")) return true;
  }
  const desc = String(def.description ?? "").toLowerCase();
  return desc.includes("requires auth");
}

/**
 * For chat.bsky.* and tools.ozone.*, the PDS needs an `atproto-proxy` header
 * naming the backend to forward to. We surface this as an OpenAPI header
 * parameter with a `default`, so Scalar's test-request panel pre-fills the
 * usual value and users don't have to remember the DID.
 */
function atprotoProxyParameter(id: string): OpenAPIV3_1.ParameterObject | null {
  if (id.startsWith("chat.bsky.")) {
    return {
      name: "atproto-proxy",
      in: "header",
      required: true,
      description: "Service DID for the central Bluesky chat service. Don't change this.",
      schema: { type: "string", default: "did:web:api.bsky.chat#bsky_chat" },
    };
  }
  if (id.startsWith("tools.ozone.")) {
    return {
      name: "atproto-proxy",
      in: "header",
      required: true,
      description:
        "Service DID for the target Ozone instance. The default points at Bluesky's moderation service; replace it with a different DID for self-hosted Ozone.",
      schema: { type: "string", default: "did:plc:ar7c4by46qjdydhdevvrndac#atproto_labeler" },
    };
  }
  return null;
}

function injectProxyHeader(
  op: OpenAPIV3_1.OperationObject,
  id: string,
): void {
  const param = atprotoProxyParameter(id);
  if (!param) return;
  op.parameters = [...(op.parameters ?? []), param];
}

function injectSecurity(
  op: OpenAPIV3_1.OperationObject,
  id: string,
  def: any,
): void {
  if (requiresAuth(id, def)) {
    op.security = [{ Bearer: [] }];
  }
}
import {
  convertArray,
  convertObject,
  convertProcedure,
  convertQuery,
  convertRecord,
  convertString,
  convertToken,
} from "./lib/converters/mod";
import {
  INCLUDE_PREFIXES,
  NAMESPACE_ORDER,
  VIEWS,
  UNIMPLEMENTED_MANIFEST,
  type View,
} from "../endpoints.config";

const LEXICONS_DIR = resolve(process.cwd(), "lexicons");

/**
 * Endpoints the live network answers with `501 MethodNotImplemented`, discovered by
 * `npm run probe` (see `scripts/probe-implemented.ts`). They're specced but not
 * served, so we don't list cards for them — same treatment as unspecced/deprecated.
 * Absent/unreadable manifest ⇒ no boundary (build stays self-contained for CI).
 */
const UNIMPLEMENTED: Set<string> = (() => {
  const path = resolve(process.cwd(), UNIMPLEMENTED_MANIFEST);
  if (!existsSync(path)) return new Set<string>();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Set<string>(data.unimplemented ?? []);
  } catch {
    return new Set<string>();
  }
})();

/** Per-view file written next to this config: `openapi.<slug>.json`. */
function outputFor(slug: string): string {
  return resolve(process.cwd(), `openapi.${slug}.json`);
}

/**
 * Shared Introduction (`info.description`), rendered as the first sidebar item in
 * every view. The cross-links in the routing bullet point at the per-view hash
 * slugs from `VIEWS` — keep them in sync.
 */
const SHARED_DESCRIPTION = [
  "This is the HTTP API reference for Bluesky. It covers the `app.bsky.*`, `com.atproto.*`, `chat.bsky.*`, and `tools.ozone.*` Lexicon namespaces — the Lexicons implemented by the Bluesky application, its related services (DMs, Ozone moderation), and the AT Protocol [PDS](https://atproto.com/guides/the-at-stack#pds) those services build on. Use the document switcher in the top left to move between endpoints.",
  "The wider AT Protocol Lexicon ecosystem is open and any service can publish its own Lexicons. For an index of community Lexicons see [lexicon.garden](https://lexicon.garden/), and for the schema language itself see the [Lexicon guide](https://atproto.com/guides/lexicon).",
  "## Authentication and request routing",
  "These endpoints don't all live on the same host, and where a request should be sent depends on whether the caller is authenticated:",
  [
    "- **Most `app.bsky.*` `GET`s are public** and can be called without authentication against the Bluesky AppView at `https://public.api.bsky.app`. `POST`s (writes) and any endpoint that returns account-private data require auth.",
    "- **Authenticated requests should be sent to the user's own PDS**. The PDS validates the session and, if needed, proxies the request to the correct backend. Proxied requests should [include an `atproto-proxy` header](https://atproto.com/specs/xrpc#service-proxying). [Bluesky DMs](#bluesky-dms/description/introduction) and [Ozone Moderation](#ozone-moderation/description/introduction) requests always require proxying.",
  ].join("\n"),
  "For client libraries that handle session management and proxying for you, see the [AT Protocol SDKs](https://atproto.com/sdks).",
].join("\n\n");

/** Schema components are shared across views (cross-namespace `$ref`s are common). */
const components: OpenAPIV3_1.ComponentsObject = {
  schemas: {},
  securitySchemes: {
    Bearer: { type: "http", scheme: "bearer" },
  },
};

/** Endpoint paths and sidebar tags, accumulated per view (keyed by slug). */
const viewPaths: Record<string, OpenAPIV3_1.PathsObject> = {};
const viewTags: Record<string, Set<string>> = {};
for (const v of VIEWS) {
  viewPaths[v.slug] = {};
  viewTags[v.slug] = new Set<string>();
}

/** First view whose prefixes match this NSID (where the endpoint is filed). */
function viewForId(id: string): View | undefined {
  return VIEWS.find((v) => v.prefixes.some((p) => id.startsWith(p)));
}

/** Flag a (non-`$ref`) component schema as deprecated, in place. */
function markDeprecated(
  schema: OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject,
  deprecated: boolean,
): OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject {
  if (deprecated && schema && !("$ref" in schema)) {
    (schema as OpenAPIV3_1.SchemaObject).deprecated = true;
  }
  return schema;
}

/** Order tags by NAMESPACE_ORDER first, then alphabetically. */
function namespaceRank(id: string): number {
  const i = NAMESPACE_ORDER.findIndex((p) => id.startsWith(p));
  return i === -1 ? NAMESPACE_ORDER.length : i;
}

function sortedTags(tagNames: Set<string>): string[] {
  return Array.from(tagNames).sort((a, b) => {
    const ra = namespaceRank(a);
    const rb = namespaceRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

/** Build Scalar/Redoc `x-tagGroups` so app.bsky.* and com.atproto.* lead. */
function tagGroups(tags: string[]): { name: string; tags: string[] }[] {
  const groups: { name: string; tags: string[] }[] = [];
  const used = new Set<string>();

  for (const prefix of NAMESPACE_ORDER) {
    const name = prefix.replace(/\.$/, "");
    const groupTags = tags.filter((t) => t.startsWith(prefix));
    groupTags.forEach((t) => used.add(t));
    if (groupTags.length) groups.push({ name, tags: groupTags });
  }

  const other = tags.filter((t) => !used.has(t));
  if (other.length) groups.push({ name: "Other", tags: other });

  return groups;
}

async function main() {
  const entries = await fg("**/*.json", {
    cwd: LEXICONS_DIR,
    absolute: true,
  });

  if (entries.length === 0) {
    throw new Error(
      `No lexicon JSON found in ${LEXICONS_DIR}. Run \`npm run install-lexicons\` first.`,
    );
  }

  for (const entry of entries.sort()) {
    const doc = await loadLexicon(entry);
    const id = doc.id;
    const defs = doc.defs as Record<string, any>;

    // Endpoints are only emitted for the curated namespaces. Schemas (defs)
    // outside them may still be present as transitive `$ref` targets — those
    // become components but never get a path or a sidebar tag.
    const isEndpointNamespace = INCLUDE_PREFIXES.some((p) => id.startsWith(p));

    for (const [name, def] of Object.entries(defs)) {
      const identifier = name === "main" ? id : `${id}.${name}`;
      const isEndpoint = def.type === "query" || def.type === "procedure";

      const containsUnspecced =
        identifier.toLowerCase().includes("unspecced") ||
        identifier.toLowerCase().includes(".temp.");
      const isDeprecated =
        def.description?.toLowerCase().startsWith("deprecated") ?? false;

      // Endpoints: skip unspecced/temp/deprecated entirely — we don't want cards
      // for them. Schema defs: always emit, because they may be `$ref` targets;
      // dropping a referenced schema would leave a dangling pointer. Deprecated
      // schema defs are emitted but flagged via `deprecated: true`.
      if (isEndpoint && (containsUnspecced || isDeprecated)) {
        continue;
      }

      switch (def.type) {
        case "array":
          components.schemas![identifier] = markDeprecated(
            convertArray(id, name, def),
            isDeprecated,
          );
          break;
        case "object":
          components.schemas![identifier] = markDeprecated(
            convertObject(id, name, def),
            isDeprecated,
          );
          break;
        case "procedure": {
          if (!isEndpointNamespace) break;
          const view = viewForId(id);
          if (!view) break;
          const post = convertProcedure(id, name, def);
          if (post) {
            (post as any)["x-codeSamples"] = codeSamplesFor(id, def);
            injectProxyHeader(post, id);
            injectSecurity(post, id, def);
            // @ts-ignore method-keyed PathItem
            viewPaths[view.slug][`/xrpc/${id}`] = { post };
            viewTags[view.slug].add(calculateTag(id));
          }
          break;
        }
        case "query": {
          if (!isEndpointNamespace) break;
          // Specced but unimplemented upstream (probe found 501 MethodNotImplemented):
          // keep the schema as a possible `$ref` target, but emit no endpoint card.
          if (UNIMPLEMENTED.has(identifier)) break;
          const view = viewForId(id);
          if (!view) break;
          const get = convertQuery(id, name, def);
          if (get) {
            (get as any)["x-codeSamples"] = codeSamplesFor(id, def);
            injectProxyHeader(get, id);
            injectSecurity(get, id, def);
            // @ts-ignore method-keyed PathItem
            viewPaths[view.slug][`/xrpc/${id}`] = { get };
            viewTags[view.slug].add(calculateTag(id));
          }
          break;
        }
        case "record":
          components.schemas![identifier] = markDeprecated(
            convertRecord(id, name, def),
            isDeprecated,
          );
          break;
        case "string":
          components.schemas![identifier] = markDeprecated(
            convertString(id, name, def),
            isDeprecated,
          );
          break;
        case "subscription":
          // Event-stream subscriptions can't be represented in OpenAPI; skip.
          break;
        case "permission-set":
          // No OpenAPI representation; skip.
          break;
        case "token":
          components.schemas![identifier] = markDeprecated(
            convertToken(id, name, def),
            isDeprecated,
          );
          break;
        default:
          throw new Error(`Unknown type: ${def.type} (${identifier})`);
      }
    }
  }

  const servers: OpenAPIV3_1.ServerObject[] = [
    {
      url: "https://public.api.bsky.app",
      description: "Public Bluesky AppView. Use this for unauthenticated `app.bsky.*` reads — no token required.",
    },
    {
      url: "https://{host}",
      description:
        "Provide your PDS hostname. Use `bsky.social` if your account is hosted by Bluesky; replace it with your own PDS hostname (e.g. `pds.example.com`) if you're self-hosted. The PDS handles auth and proxies `app.bsky` / `chat.bsky` / `tools.ozone` calls onward. To get a token to make requests from this page, call `com.atproto.server.createSession` with your handle and an [app password](https://bsky.app/settings/app-passwords), and paste the returned `accessJwt` into the **Authentication** panel below. The token is then attached to every test request automatically.",
      variables: {
        host: { default: "bsky.social" },
      },
    },
  ];

  // One OpenAPI document per view; the renderer surfaces them as a switcher
  // dropdown. They share the Introduction (`info.description`), servers, and the
  // full component set (cross-namespace `$ref`s are common, and bundling every
  // schema in each document keeps those pointers from dangling).
  for (const view of VIEWS) {
    const tags = sortedTags(viewTags[view.slug]);
    const paths = viewPaths[view.slug];

    const api: OpenAPIV3_1.Document & { "x-tagGroups"?: unknown } = {
      openapi: "3.1.0",
      info: {
        title: `Bluesky HTTP API Reference — ${view.title}`,
        summary: "HTTP/XRPC endpoint reference for Bluesky and AT Protocol lexicons.",
        description: SHARED_DESCRIPTION,
        // We don't version this HTTP reference list, so leave it empty: Scalar's
        // InfoVersion badge renders nothing for a falsy version string (a real
        // "0.0.0" would otherwise show a meaningless "v0.0.0" badge by the title).
        version: "",
      },
      servers,
      // No document-level `security` array — we only declare it per-operation
      // (via `injectSecurity`) on endpoints flagged by `requiresAuth`. That way
      // Scalar stamps an accurate "Auth Required" badge on the writes/proxied
      // endpoints it applies to, and stays silent on the public reads. The
      // renderer uses the badge's presence to hide the test-request button on
      // those operations — see render.ts.
      paths,
      components,
      tags: tags.map((name) => ({ name })),
      "x-tagGroups": tagGroups(tags),
    };

    const output = outputFor(view.slug);
    await writeFile(output, JSON.stringify(api, null, 2) + "\n");
    console.log(
      `Wrote ${output}: ${Object.keys(paths).length} endpoints, ` +
        `${Object.keys(components.schemas!).length} schemas, ${tags.length} tags.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
