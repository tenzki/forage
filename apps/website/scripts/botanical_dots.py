"""Detect botanical dot regions for rounded-square reconstruction (Pillow 12.1.1)."""

import heapq
from pathlib import Path

from PIL import Image, ImageFilter


def detect_regions(source: Path, window=5, minimum_core=3):
    image = Image.open(source).convert("RGB")
    width, height = image.size
    pixels = list(image.get_flattened_data())
    paper = (245, 242, 232)
    contrast = [max(paper[c] - p[c] for c in range(3)) for p in pixels]

    def neighbors(index):
        x = index % width
        if x:
            yield index - 1
        if x < width - 1:
            yield index + 1
        if index >= width:
            yield index - width
        if index < width * (height - 1):
            yield index + width

    values = Image.new("L", image.size)
    values.putdata([max(0, value) for value in contrast])
    local = list(values.filter(ImageFilter.MaxFilter(window)).get_flattened_data())
    active = bytearray(value > 20 and value >= local[i] * .82 for i, value in enumerate(contrast))
    regions = []
    for seed in range(width * height):
        if not active[seed]:
            continue
        active[seed] = 0
        queue, region = [seed], []
        while queue:
            index = queue.pop()
            region.append(index)
            for neighbor in neighbors(index):
                if active[neighbor]:
                    active[neighbor] = 0
                    queue.append(neighbor)
        if len(region) >= minimum_core:
            regions.append(region)

    # Grow each center toward its lighter edge, stopping when regions meet.
    labels = [-1] * (width * height)
    peaks = [max(contrast[i] for i in region) for region in regions]
    heap = []
    for label, region in enumerate(regions):
        for index in region:
            labels[index] = label
            heapq.heappush(heap, (-contrast[index], index, label))
    while heap:
        _, index, label = heapq.heappop(heap)
        for neighbor in neighbors(index):
            if labels[neighbor] < 0 and contrast[neighbor] > max(15, peaks[label] * .35):
                labels[neighbor] = label
                regions[label].append(neighbor)
                heapq.heappush(heap, (-contrast[neighbor], neighbor, label))

    return width, height, pixels, contrast, regions
