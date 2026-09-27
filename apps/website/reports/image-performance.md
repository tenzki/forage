# Botanical SVG performance experiment

Measured 2026-09-27T07:03:38.406Z on Apple M3 (darwin arm64, Node v26.8.1, Sharp 0.34.5).

All four botanical images are reconstructed from individual SVG rounded squares, with position, size and color estimated from the original marks. The original PNGs remain untouched. The site loads external, hashed SVG files through img/picture, preserving lazy loading and desktop/mobile footer art. SVGs are generated ahead of time; Python and Pillow are not needed for site builds.

## Transfer sizes

SVG compression uses gzip level 6 and Brotli quality 6. These are potential response sizes **only if the host enables SVG compression**. WebP sizes are the binary payloads at the previous Astro widths and quality settings. Headers, fonts, HTML and CSS are excluded.

| Asset | Squares | SVG raw KiB | gzip KiB | Brotli KiB | Previous WebP KiB (width → size) |
| --- | ---: | ---: | ---: | ---: | --- |
| lavender-square-dot-01 | 2331 | 137.9 | 21.6 | 20.9 | 400 → 14.5, 600 → 28.5, 1100 → 76.8 |
| elderflower-square-dot-01 | 5505 | 325.5 | 51.3 | 49.8 | 164 → 7.4, 328 → 25.8, 560 → 64.5 |
| footer-border-desktop-01 | 5593 | 326.9 | 44.3 | 42.7 | 1440 → 40.3, 1944 → 64.7 |
| footer-border-mobile-01 | 3324 | 197.8 | 27.3 | 26.2 | 390 → 16.0, 780 → 50.9 |

## Whole-page illustration payload

Each scenario counts lavender, elderflower and **one** footer image after scrolling through the page. Footer and elderflower remain lazy loaded. Mobile assumes a 390px viewport and 342px hero slot; desktop assumes a 1440px viewport and 548px hero slot. Width selections are the first available candidate meeting the target pixel width, capped at the largest existing WebP. Actual browser selection can vary.

| Scenario | WebP KiB | SVG raw KiB | SVG gzip KiB | SVG Brotli KiB | Brotli / WebP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mobile, 1× | 37.9 | 661.2 | 100.2 | 97.0 | 2.6× |
| Mobile, 2× | 153.5 | 661.2 | 100.2 | 97.0 | 0.6× |
| Desktop, 1× | 94.6 | 790.3 | 117.2 | 113.4 | 1.2× |
| Desktop, 2× | 206.1 | 790.3 | 117.2 | 113.4 | 0.6× |

## Local decode / rasterization CPU proxy

Median of 20 sequential runs after 3 warmups, file bytes already in memory, Sharp cache disabled and one worker thread. SVG uses target density before rasterizing; WebP is decoded at its native delivered dimensions. Both produce uncompressed RGB pixels. These numbers measure libvips/librsvg, **not browser paint time, frame rate, Lighthouse or LCP**. Browser testing has not been performed.

| Asset | Width px | WebP decode ms | SVG rasterize ms | Ratio |
| --- | ---: | ---: | ---: | ---: |
| lavender-square-dot-01 | 400 | 2.08 | 25.21 | 12.1× |
| lavender-square-dot-01 | 600 | 3.66 | 26.22 | 7.2× |
| lavender-square-dot-01 | 1100 | 8.67 | 30.40 | 3.5× |
| elderflower-square-dot-01 | 164 | 0.89 | 57.27 | 64.2× |
| elderflower-square-dot-01 | 328 | 2.39 | 59.14 | 24.8× |
| elderflower-square-dot-01 | 560 | 5.10 | 60.58 | 11.9× |
| footer-border-desktop-01 | 1440 | 5.93 | 63.61 | 10.7× |
| footer-border-desktop-01 | 1944 | 9.20 | 65.34 | 7.1× |
| footer-border-mobile-01 | 390 | 2.97 | 35.09 | 11.8× |
| footer-border-mobile-01 | 780 | 8.33 | 40.44 | 4.9× |

## Reproduce

Run `pnpm --filter @forage/website benchmark:images`. This recreates WebP baselines from the original PNGs and rewrites this report and its JSON data. Run `pnpm --filter @forage/website vectorize:images` to regenerate optimized SVGs (requires Python with Pillow 12.1.1).

The SVG experiment is active as requested. Judge its shipping suitability using both appearance and the transfer/CPU results; vector format alone does not imply better performance. For a browser follow-up, compare cold and warm loads at the same mobile/desktop viewport, device scale, CPU/network throttle and compression settings, including a scroll to the footer.
