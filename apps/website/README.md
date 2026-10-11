# Forage marketing website

Static Astro + TypeScript + Tailwind implementation of `docs/marketing.pen`.

```sh
pnpm install
pnpm --filter @forage/website dev
pnpm --filter @forage/website build
pnpm --filter @forage/website preview
```

Development and preview listen on `http://127.0.0.1:4321`. Build runs Astro's
TypeScript checks, generates `dist/`, bundles the illustrations, and checks the
resulting HTML's anchors and local asset references. The site requires no server
runtime after building; serve `dist/` from any static host.

When working in Herdr, start persistent dev/preview commands in a dedicated pane
as described in the repository's agent instructions.

## Content and links

Edit `src/data/site.ts` for download/documentation destinations, workflow steps,
skill examples, and extensions. Adding another item to `extensions` creates an
additional card; the layout adjusts automatically and retains the future slot.
Downloads and release notes currently point to the repository's Releases page.

Set `WEBSITE_URL` to the final public origin when building to emit canonical and
Open Graph URL metadata. The default deliberately does not invent a public domain.

## Design and assets

`src/styles/global.css` defines Tailwind brand tokens. Apfel Grotezk is sourced
from `docs/ApfelGrotezk-Regular.otf`; IBM Plex Mono is bundled through Fontsource.
All fonts are self-hosted. Original botanical PNGs remain in
`docs/branding-assets/`; the site uses individual rounded-square SVGs in
`src/assets/botanicals/`. They load as external, hashed image URLs, preserving
browser caching without adding thousands of shapes to the page DOM.

`pnpm --filter @forage/website benchmark:images` compares transfer sizes and a
local rendering CPU proxy against the previous responsive WebP settings. See
[the measured report](reports/image-performance.md) for results and limitations.
This does not measure browser LCP or paint performance.

To regenerate all four SVGs, install `Pillow==12.1.1` in your Python environment
and run `pnpm --filter @forage/website vectorize:images`. Set `PYTHON` to select a
different Python executable. Normal site builds use the committed SVGs and do
not require Python. The conversion estimates each mark's position, area and core
color, then fits a rounded square. Every foreground shape remains a `rect` with
equal width and height. A sampled 96-color palette and one-decimal coordinates
reduce size. All four SVG backgrounds are transparent. Enable SVG gzip/Brotli compression
on the production host; the report includes uncompressed sizes as well.

`pnpm --filter @forage/website prototype:squares` generates source comparisons
and enlarged square details in the ignored `reports/square-botanicals/` directory.
These optional review artifacts can be deleted and regenerated as needed.
`vectorize:images` updates the site's actual assets. Both commands share the dot
detector in `scripts/botanical_dots.py` and the rounded-square fitter.

The footer uses separate desktop and mobile art through `<picture>`. Keep the
elderflower in the workflow section and the closing invitation free of imagery.
The product preview is an accessible HTML/CSS illustration, not a live editor.
Navigation is the only client-side script; the menu also works without JavaScript.

This package uses Astro 5 to stay compatible with the workspace's Vite 6
override. A scoped `astro>zod` override preserves Astro's Zod 3 dependency while
the rest of the workspace continues using Zod 4.
