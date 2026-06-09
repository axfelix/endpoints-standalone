/**
 * Static renderer. Produces a fully self-contained `out/`:
 *   - openapi.<slug>.json  (one generated spec per view, also downloadable)
 *   - scalar.standalone.js (vendored from @scalar/api-reference, MIT)
 *   - index.html           (loads the local bundle, points it at the specs)
 *
 * No CLI, no SaaS, no runtime calls to a hosted service. Open `out/index.html`
 * over http (e.g. `npx serve out`) — file:// won't fetch the local JSON.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { VIEWS } from "../endpoints.config";

const require = createRequire(import.meta.url);
const OUT = resolve(process.cwd(), "out");

// Each view's generated document, surfaced to Scalar as a `sources` switcher.
const specFile = (slug: string) => `openapi.${slug}.json`;

// Resolve the vendored Scalar standalone browser bundle. The package `exports`
// map blocks deep imports, so resolve the main entry (dist/index.js) and derive
// the sibling browser bundle from its directory.
const scalarMain = require.resolve("@scalar/api-reference");
const scalarStandalone = resolve(dirname(scalarMain), "browser/standalone.js");

// `sources` array literal injected into the page. The first entry is the default
// document; `slug` keys each document's URL hash (and the Introduction's
// cross-links), `title` labels it in the switcher dropdown.
const sources = VIEWS.map((v, i) => ({
  slug: v.slug,
  title: v.title,
  url: `./${specFile(v.slug)}`,
  ...(i === 0 ? { default: true } : {}),
}));

// slug -> title, used by the in-page cross-link interceptor below to find the
// matching switcher option.
const viewTitles: Record<string, string> = Object.fromEntries(
  VIEWS.map((v) => [v.slug, v.title]),
);

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Bluesky HTTP API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="app"></div>
    <script src="./scalar.standalone.js"></script>
    <script>
      Scalar.createApiReference('#app', {
        // Multiple documents (Bluesky App / Bluesky DMs / Ozone Moderation),
        // rendered with a switcher dropdown in the top left. The config props
        // below are shared and merged into every source.
        sources: ${JSON.stringify(sources)},
        // Omit the catch-all "Models" section — component schemas still render
        // inline within each endpoint's request/response.
        hideModels: true,
        // Follow the spec's tag / x-tagGroups order (app.bsky, com.atproto, ...).
        tagsSorter: 'default',
        // Hide every auto-generated httpsnippet client. Each operation supplies
        // its own TS/Go/curl snippets via x-codeSamples; with no clientOptions,
        // Scalar also drops the otherwise-empty "Client Libraries" intro card.
        hiddenClients: true,
        // The spec declares the Bearer scheme in components.securitySchemes
        // and attaches it per-operation only on endpoints requiresAuth flags
        // (see build-openapi.ts). Pre-select Bearer in the intro Auth panel so
        // a token entered there is applied to every test request.
        authentication: { preferredSecurityScheme: 'Bearer' },
        // Rename the intro server card's "Server" title-bar label to
        // "Demo Server" so it's obvious the host picker only powers in-page
        // test requests. Scalar hard-codes "Server" in ServerSelector.vue.
        // The title-bar label carries .bg-b-2.rounded-t-xl (other labels
        // inside the card — e.g. the host variable input's label — don't),
        // so this selector hits only the title bar.
        //
        // Also: hide the per-operation "Ask AI" inputs that Scalar renders in
        // each operation's footer (.agent-button-container). The sidebar
        // "Ask AI" button is replaced with a Docs link in the script below.
        customCss: \`
          .scalar-reference-intro-server label.bg-b-2.rounded-t-xl { font-size: 0; }
          .scalar-reference-intro-server label.bg-b-2.rounded-t-xl::before {
            content: 'Demo Server';
            font-size: 0.875rem;
            font-weight: 500;
          }
          .agent-button-container { display: none !important; }
        \`,
      })
    </script>
    <script>
      // (1) Replace Scalar's "Ask AI" button in the sidebar header with a
      //     "Docs" link back to docs.bsky.app. Scalar has no first-class hook
      //     for adding a custom button to the sidebar header, so we patch the
      //     DOM after each render. The per-operation Ask AI form is hidden
      //     separately via customCss above. (We don't run our own AI flow off
      //     this site, so Scalar's chat would just confuse readers.)
      //
      // (2) Hide Scalar's "Test Request" button on operations that require
      //     auth. The spec encodes this per-operation as a Bearer security
      //     requirement (see build-openapi.ts); Scalar in turn renders a
      //     SecurityRequirementBadge (.security-requirement-badge) in those
      //     operations. We use that badge's presence as the trigger: any
      //     operation <section> containing the badge has its test button
      //     hidden, because there isn't a clean way to drive an authed call
      //     from this static page (the user would need to manually mint a
      //     PDS-issued bearer token via createSession first).
      (function () {
        var DOCS_URL = 'https://docs.bsky.app';

        function swapAskAiButton() {
          // Single button anywhere in the chrome (the per-operation Ask AI is a
          // form with an input + send icon, not a button literally labeled
          // "Ask AI", so this exact-text match is specific enough for both
          // modern and classic layouts).
          var buttons = document.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            if (b.textContent.trim() !== 'Ask AI') continue;
            var a = document.createElement('a');
            a.href = DOCS_URL;
            a.target = '_blank';
            a.rel = 'noopener';
            a.className = b.className;
            a.textContent = 'Docs';
            a.setAttribute('aria-label', 'docs.bsky.app (opens in new tab)');
            b.replaceWith(a);
          }
        }

        function hideAuthTestButtons(root) {
          var sections = (root || document).querySelectorAll('section.section');
          for (var i = 0; i < sections.length; i++) {
            var section = sections[i];
            var btn = section.querySelector('.show-api-client-button');
            if (!btn) continue;
            var hasBadge = !!section.querySelector('.security-requirement-badge');
            btn.style.display = hasBadge ? 'none' : '';
          }
        }

        function tick() {
          swapAskAiButton();
          hideAuthTestButtons();
        }

        // Scalar mounts the sidebar and operations asynchronously and may
        // re-render on document switches; a MutationObserver keeps both
        // patches stable across those transitions.
        var observer = new MutationObserver(tick);
        observer.observe(document.body, { childList: true, subtree: true });
        tick();
      })();
    </script>
    <script>
      // Make the Introduction's cross-links (e.g. "Bluesky DMs",
      // "Ozone Moderation") switch documents. Scalar deep-links a document only
      // on a fresh page load, not on a plain in-page hashchange — so clicking
      // such a link otherwise just updates the URL without switching. We instead
      // drive the same headlessui listbox the switcher dropdown uses (clicking
      // its option switches smoothly, no reload); if that listbox can't be
      // found we fall back to a hash navigation + reload, which Scalar honors.
      (function () {
        var VIEW_TITLES = ${JSON.stringify(viewTitles)};
        var TITLES = Object.keys(VIEW_TITLES).map(function (k) { return VIEW_TITLES[k]; });

        function activeSlug() {
          var m = location.hash.match(/^#([a-z0-9-]+)/);
          return m ? m[1] : null;
        }
        function hardNav(slug) {
          location.hash = slug + '/description/introduction';
          location.reload();
        }
        function findOption(title) {
          return Array.prototype.find.call(
            document.querySelectorAll('[role="option"]'),
            function (el) { return el.textContent.trim() === title; },
          );
        }
        function switchDocument(slug) {
          var title = VIEW_TITLES[slug];
          var opt = findOption(title);
          if (opt) { opt.click(); return; }
          // headlessui mounts the options only while the listbox is open, so
          // open the switcher button first, then click the matching option.
          var btn = Array.prototype.find.call(
            document.querySelectorAll('button[aria-haspopup="listbox"]'),
            function (b) { return TITLES.indexOf(b.textContent.trim()) !== -1; },
          );
          if (!btn) { hardNav(slug); return; }
          btn.click();
          var tries = 0;
          var iv = setInterval(function () {
            var o = findOption(title);
            if (o) { clearInterval(iv); o.click(); }
            else if (++tries > 30) { clearInterval(iv); hardNav(slug); }
          }, 16);
        }

        document.addEventListener('click', function (e) {
          var a = e.target && e.target.closest && e.target.closest('a[href]');
          if (!a) return;
          var m = (a.getAttribute('href') || '').match(/^#([a-z0-9-]+)\\/description\\/introduction$/);
          if (!m) return;
          var slug = m[1];
          if (!VIEW_TITLES[slug]) return;     // not a known view link
          if (slug === activeSlug()) return;  // same document — let Scalar scroll
          e.preventDefault();
          switchDocument(slug);
        }, true);
      })();
    </script>
  </body>
</html>
`;

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const v of VIEWS) {
    await copyFile(resolve(process.cwd(), specFile(v.slug)), resolve(OUT, specFile(v.slug)));
  }
  await copyFile(scalarStandalone, resolve(OUT, "scalar.standalone.js"));
  await writeFile(resolve(OUT, "index.html"), HTML);
  const specs = VIEWS.map((v) => specFile(v.slug)).join(", ");
  console.log(`Wrote static site to ${OUT} (index.html, ${specs}, scalar.standalone.js).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
