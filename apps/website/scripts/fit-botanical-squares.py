"""Reconstruct the source's small marks as individual SVG rounded squares.

Uses detected dot regions only to estimate position, area and core color.
No traced contours, leaf silhouettes, repeated fill patterns or embedded PNGs.
"""

import argparse
import math
from pathlib import Path
from statistics import median

from PIL import Image

from botanical_dots import detect_regions


def reconstruct(source, destination, fine=False):
    width, height, pixels, contrast, regions = detect_regions(source, window=3 if fine else 5, minimum_core=1 if fine else 3)
    regions = [region for region in regions if len(region) >= 3 and max(contrast[i] for i in region) >= 24]
    nominal = median(math.sqrt(len(region)) for region in regions if len(region) >= 6)
    separated = []
    for region in regions:
        xs, ys = [i % width for i in region], [i // width for i in region]
        left, top = min(xs), min(ys)
        span_x, span_y = max(xs) - left + 1, max(ys) - top + 1
        if len(region) > nominal * nominal * 2.4:
            # A few touching dots become one detected region. Subdivide only
            # those large regions into locally positioned square-sized cells.
            columns, rows = max(1, round(span_x / nominal)), max(1, round(span_y / nominal))
            cells = {}
            for i in region:
                key = (min(columns - 1, int((i % width - left) / span_x * columns)),
                       min(rows - 1, int((i // width - top) / span_y * rows)))
                cells.setdefault(key, []).append(i)
            separated.extend(cell for cell in cells.values() if len(cell) >= 3)
        else:
            separated.append(region)

    squares, colors = [], []
    for region in separated:
        peak = max(contrast[i] for i in region)
        core = [i for i in region if contrast[i] >= peak * .75]
        color = tuple(round(sum(pixels[i][c] for i in core) / len(core)) for c in range(3))
        center_x = sum(i % width + .5 for i in region) / len(region)
        center_y = sum(i // width + .5 for i in region) / len(region)
        # Area correction accounts for the rounded corners. Every foreground
        # mark is a true square, with a gentle limit on exceptional large ones.
        side = min(nominal * 1.38, math.sqrt(len(region) / .94))
        squares.append((round(center_x - side / 2, 1), round(center_y - side / 2, 1), round(side, 1)))
        colors.append(color)

    # Sample a shared palette from the dots, preserving light florets as well
    # as foliage; quantization is only applied to color, never to positions.
    swatch = Image.new('RGB', (len(colors), 1))
    swatch.putdata(colors)
    quantized = swatch.quantize(colors=96, dither=Image.Dither.NONE).convert('RGB')
    groups = {}
    for square, color in zip(squares, quantized.get_flattened_data()):
        groups.setdefault(color, []).append(square)

    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">']
    for color, group in groups.items():
        fill = '#' + ''.join(f'{c:02x}' for c in color)
        svg.append(f'<g fill="{fill}">')
        for x, y, side in group:
            radius = round(side * .16, 1)
            svg.append(f'<rect x="{x:g}" y="{y:g}" width="{side:g}" height="{side:g}" rx="{radius:g}"/>')
        svg.append('</g>')
    svg.append('</svg>')
    destination.write_text(''.join(svg))
    print(f'{len(squares)} rounded squares; typical side {nominal:.1f}px')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--fine', action='store_true', help='Smaller dot detector for footer source images')
    args = parser.parse_args()
    reconstruct(args.source, args.destination, args.fine)
