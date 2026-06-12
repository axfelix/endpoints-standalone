/**
 * Probe Bluesky's live services for `com.atproto` endpoints that are *specced* but
 * not actually *implemented*, and record them so `build-openapi` can unlist them.
 *
 * Why this exists: the reference enumerates every `com.atproto` query/procedure the
 * schema authorities publish, but the live AppView/PDS/relay don't necessarily serve
 * all of them (e.g. the `com.atproto.identity` GET methods `resolveDid`,
 * `resolveIdentity`, `refreshIdentity` return `501 MethodNotImplemented`). Listing a
 * card for an endpoint nobody answers is misleading, so we prune them.
 *
 * How it decides — see the long note on `PROBE_*` in `endpoints.config.ts`. In short:
 * each method has a home service and every host `501`s methods that aren't its own,
 * so we probe a panel of hosts and an endpoint is "unimplemented" only if the
 * authoritative (authenticated) PDS returns `501 MethodNotImplemented` and no host
 * serves it. `appview`/`relay` contribute positive ("served here") signals only.
 *
 * Only QUERIES are probed — we never send a procedure (write) to the live network.
 *
 * Run: `npm run probe`. For the authoritative PDS check set:
 *   BSKY_PROBE_IDENTIFIER     handle or DID (e.g. probe-bot.bsky.social)
 *   BSKY_PROBE_APP_PASSWORD   an app password (the probe only sends GETs, so it never
 *                             writes — prefer a throwaway/secondary account regardless)
 *   BSKY_PROBE_PDS            optional; defaults to PROBE_HOSTS.pds
 * Without credentials the probe runs in a safe no-op mode (unlists nothing, warns).
 *
 * Output: `UNIMPLEMENTED_MANIFEST` (committed; an input to the deterministic build,
 * like `lexicons.json`). Re-runnable.
 */
import dns from "node:dns";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fg from "fast-glob";

import { loadLexicon } from "../src/lib/utils";
import {
  PROBE_NAMESPACE,
  PROBE_HOSTS,
  UNIMPLEMENTED_MANIFEST,
} from "../endpoints.config";

// Same Windows loopback-only DNS workaround as seed-allowlist / lex.mjs
// (nodejs/node#62347). No-op on healthy systems, including Linux CI.
if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) {
  dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
}

const WORKSPACE = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LEXICONS_DIR = resolve(WORKSPACE, "lexicons");
const MANIFEST = resolve(WORKSPACE, UNIMPLEMENTED_MANIFEST);

const PDS = (process.env.BSKY_PROBE_PDS ?? PROBE_HOSTS.pds).replace(/\/$/, "");
const IDENTIFIER = process.env.BSKY_PROBE_IDENTIFIER;
const APP_PASSWORD = process.env.BSKY_PROBE_APP_PASSWORD;

const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;

type Signal = "implemented" | "unimplemented" | "inconclusive";

interface HostResult {
  host: string;
  status: number | null; // null = network error / timeout
  error?: string; // XRPC error name from the JSON body, when present
  signal: Signal;
}

interface EndpointResult {
  nsid: string;
  decision: "keep" | "unlist" | "inconclusive";
  hosts: HostResult[];
}

/** Enumerate the installed `com.atproto` QUERY NSIDs from the local lexicons. */
async function enumerateQueries(): Promise<string[]> {
  const files = await fg("**/*.json", { cwd: LEXICONS_DIR, absolute: true });
  const nsids: string[] = [];
  for (const file of files.sort()) {
    const doc = await loadLexicon(file);
    const id = doc.id as string;
    if (!id.startsWith(PROBE_NAMESPACE)) continue;
    const main = (doc.defs as Record<string, any>)?.main;
    if (main?.type === "query") nsids.push(id);
  }
  return nsids;
}

/** One unauthenticated/authenticated XRPC GET. Never throws. */
async function xrpcGet(
  base: string,
  nsid: string,
  token?: string,
): Promise<{ status: number | null; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/xrpc/${nsid}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: ctrl.signal,
    });
    let error: string | undefined;
    try {
      const body: any = await res.json();
      if (body && typeof body.error === "string") error = body.error;
    } catch {
      /* non-JSON body; status alone is enough */
    }
    return { status: res.status, error };
  } catch {
    return { status: null };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Map an HTTP response to a signal. The distinction that matters is *did a method
 * handler run* (→ implemented) vs *did the request never reach one* (→ no signal):
 *
 * - `501 MethodNotImplemented` is the definitive "not served" answer, but only the
 *   authoritative PDS may assert it; for positive-only hosts (AppView/relay) it just
 *   means "not my method".
 * - `401` is the entryway auth gate, which runs *before* method resolution, so it
 *   tells us nothing about whether the method exists.
 * - A bare `404 Not Found` (or any 404/5xx without a method-level error) is a routing
 *   miss — the host simply doesn't expose this path. The relay does this for non-`sync`
 *   methods, so it must NOT be read as "implemented".
 * - Everything else came from a running handler: `200`, `400 InvalidRequest/BadRequest`,
 *   `403`, or a method-level `404` (`HostNotFound`, `RecordNotFound`, …) ⇒ implemented.
 */
function classify(
  status: number | null,
  error: string | undefined,
  authoritative: boolean,
): Signal {
  if (status === null) return "inconclusive";
  const err = error?.toLowerCase();

  if (status === 501 && err === "methodnotimplemented") {
    return authoritative ? "unimplemented" : "inconclusive";
  }
  if (status === 401) return "inconclusive"; // auth gate / admin-only; pre-method
  if (status === 429) return "inconclusive"; // rate limited; retry, don't conclude
  // Generic routing miss (no method-level XRPC error in the body).
  if (status === 404 && (!err || err === "not found" || err === "notfound")) {
    return "inconclusive";
  }
  if (status >= 500) return "inconclusive"; // 5xx (incl. non-MNI 501) — gateway/transient
  return "implemented";
}

async function probeEndpoint(
  nsid: string,
  token: string | undefined,
): Promise<EndpointResult> {
  const targets: { host: string; base: string; authoritative: boolean; auth?: string }[] = [
    { host: "appview", base: PROBE_HOSTS.appview, authoritative: false },
    { host: "relay", base: PROBE_HOSTS.relay, authoritative: false },
    { host: "pds", base: PDS, authoritative: true, auth: token },
  ];

  const hosts: HostResult[] = [];
  for (const tgt of targets) {
    const { status, error } = await xrpcGet(tgt.base, nsid, tgt.auth);
    hosts.push({
      host: tgt.host,
      status,
      error,
      signal: classify(status, error, tgt.authoritative),
    });
  }

  const pds = hosts.find((h) => h.host === "pds")!;
  let decision: EndpointResult["decision"];
  if (hosts.some((h) => h.signal === "implemented")) {
    decision = "keep";
  } else if (pds.signal === "unimplemented") {
    decision = "unlist";
  } else {
    decision = "inconclusive"; // no positive signal and PDS couldn't be reached/authed
  }
  return { nsid, decision, hosts };
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function createSession(): Promise<string | undefined> {
  if (!IDENTIFIER || !APP_PASSWORD) return undefined;
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: IDENTIFIER, password: APP_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `createSession failed on ${PDS} (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const { accessJwt } = await res.json();
  if (!accessJwt) throw new Error("createSession returned no accessJwt");
  return accessJwt;
}

function fmtHost(h: HostResult): string {
  const code = h.status === null ? "ERR" : String(h.status);
  const tag =
    h.signal === "implemented" ? "✓" : h.signal === "unimplemented" ? "✗" : "·";
  return `${h.host}=${code}${h.error ? `/${h.error}` : ""}${tag}`;
}

async function main() {
  const nsids = await enumerateQueries();
  if (nsids.length === 0) {
    throw new Error(
      `No com.atproto queries found in ${LEXICONS_DIR}. Run \`npm run install-lexicons\` first.`,
    );
  }

  let token: string | undefined;
  try {
    token = await createSession();
  } catch (err) {
    console.error(`\n[probe] ${(err as Error).message}`);
    console.error("[probe] Continuing unauthenticated (will unlist nothing).\n");
  }
  const authenticated = Boolean(token);
  if (!authenticated) {
    console.warn(
      "[probe] No BSKY_PROBE_IDENTIFIER / BSKY_PROBE_APP_PASSWORD — running\n" +
        "        unauthenticated. The PDS auth-gates before method resolution, so\n" +
        "        auth-gated endpoints can't be evaluated and will be KEPT. Set the\n" +
        "        credentials (an app password; the probe only sends GETs) for the real check.\n",
    );
  }

  console.log(
    `[probe] Probing ${nsids.length} com.atproto queries against ` +
      `appview/relay + PDS ${PDS} (${authenticated ? "authenticated" : "unauthenticated"})…\n`,
  );

  const results = await mapLimit(nsids, CONCURRENCY, (nsid) =>
    probeEndpoint(nsid, token),
  );

  const unimplemented: string[] = [];
  const inconclusive: string[] = [];
  for (const r of results.sort((a, b) => a.nsid.localeCompare(b.nsid))) {
    const mark =
      r.decision === "unlist" ? "UNLIST" : r.decision === "keep" ? "keep  " : "?     ";
    console.log(`  ${mark}  ${r.nsid.padEnd(48)} ${r.hosts.map(fmtHost).join("  ")}`);
    if (r.decision === "unlist") unimplemented.push(r.nsid);
    if (r.decision === "inconclusive") inconclusive.push(r.nsid);
  }
  unimplemented.sort();

  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        $generated:
          "scripts/probe-implemented.ts (npm run probe) — com.atproto queries the live network answers with 501 MethodNotImplemented. Do not edit by hand.",
        probedAt: new Date().toISOString(),
        pds: PDS,
        authenticated,
        unimplemented,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `\n[probe] ${unimplemented.length} unimplemented, ${inconclusive.length} inconclusive, ` +
      `${results.length - unimplemented.length - inconclusive.length} implemented.`,
  );
  if (inconclusive.length && !authenticated) {
    console.log(
      `[probe] ${inconclusive.length} endpoints were inconclusive (auth-gated). ` +
        `Re-run with credentials to evaluate them.`,
    );
  }
  console.log(`[probe] Wrote ${MANIFEST}. Rebuild with \`npm run build:openapi\`.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
