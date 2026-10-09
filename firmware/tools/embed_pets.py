"""Compile assets/pets into C tables for pet.c. Requires Pillow.

Each animation frame becomes palette indices (index 0 is transparent). The first frame of
an animation is stored whole; later frames store only the rectangle that changed since the
previous frame, and identical rectangles are stored once. Every frame is checked by
replaying the animations.
"""
from pathlib import Path
import json
import sys
import zlib
from PIL import Image, ImageChops

STATES = ['working', 'waiting', 'done', 'idle', 'stopped', 'offline', 'error']  # pet_pack.h order
root, output = map(Path, sys.argv[1:])
registry = json.loads((root / 'index.json').read_text())
order = [registry['default']] + [pet for pet in registry['pets'] if pet != registry['default']]
assert registry['default'] in registry['pets']


def indexed(cells):
    """Map RGBA cells to palette index images, keeping colours exact."""
    colors = []
    for cell in cells:
        for _, (r, g, b, a) in cell.getcolors(1 << 24):
            assert a in (0, 255), 'pets need binary transparency'
            if a and (r, g, b) not in colors:
                colors.append((r, g, b))
    assert len(colors) < 256, 'pets are limited to 255 colours'
    blank = next(c for c in ((1, 2, 3), (254, 1, 253), (3, 250, 7)) if c not in colors)
    lookup = {c: i for i, c in enumerate([blank] + colors)}
    images = []
    for cell in cells:
        flat = Image.new('RGB', cell.size, blank)
        flat.paste(cell.convert('RGB'), mask=cell.getchannel('A'))
        # Median cut keeps every colour of a cell with few colours; fall back to an exact
        # (slow) per-pixel lookup whenever it does not.
        local = flat.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        if local.convert('RGB').tobytes() == flat.tobytes():
            entries = local.getpalette()
            table = [lookup.get(tuple(entries[i * 3:i * 3 + 3]), 0) for i in range(len(entries) // 3)]
            index = Image.frombytes('L', cell.size, local.tobytes()).point(table + [0] * (256 - len(table)))
        else:
            raw = flat.tobytes()
            index = Image.frombytes('L', cell.size, bytes(lookup[tuple(raw[i:i + 3])] for i in range(0, len(raw), 3)))
        images.append(index)
    return colors, images


def compile_pet(name):
    folder = root / name
    pet = json.loads((folder / 'pet.json').read_text())
    width, height = pet['size']['width'], pet['size']['height']
    sheet = Image.open(folder / pet['sheet']).convert('RGBA')
    cells = []
    for sx, sy, w, h, dx, dy in pet['frames']:
        cell = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        if w:
            cell.paste(sheet.crop((sx, sy, sx + w, sy + h)), (dx, dy))
        cells.append(cell)
    colors, images = indexed(cells)
    animations = list(pet['animations'].items())
    data, frames, max_patch, stored, starts = bytearray(), [], 0, {}, []
    for _, animation in animations:
        sequence = animation['frames']
        assert sequence and len(animation['durations']) == len(sequence)
        assert 0 <= animation['rest'] < len(sequence)
        starts.append(len(frames))
        previous = None
        for k, index in enumerate(sequence):
            image = images[index]
            box = (0, 0, width, height) if previous is None else ImageChops.difference(previous, image).getbbox()
            if box:
                patch = zlib.compress(image.crop(box).tobytes(), 9)
                x, y, w, h = box[0], box[1], box[2] - box[0], box[3] - box[1]
            else:
                patch, x, y, w, h = b'', 0, 0, 0, 0
            if patch and patch not in stored:  # loops repeat the same rectangles
                stored[patch] = len(data)
                data.extend(patch)
            frames.append((x, y, w, h, animation['durations'][k], stored.get(patch, 0), len(patch)))
            max_patch = max(max_patch, w * h)
            previous = image

    # Replay every animation from its stored rectangles.
    for (_, animation), start in zip(animations, starts):
        canvas = Image.new('L', (width, height))
        for k, index in enumerate(animation['frames']):
            x, y, w, h, _, offset, size = frames[start + k]
            if w:
                canvas.paste(Image.frombytes('L', (w, h), zlib.decompress(data[offset:offset + size])), (x, y))
            assert canvas.tobytes() == images[index].tobytes(), 'replay mismatch'

    ids = [n for n, _ in animations]
    pools = []
    for state in STATES:
        entries = []
        for entry in pet['states'].get(state, []):
            target = entry.get('play') or entry.get('hold')
            entries.append((ids.index(target), entry.get('ms', 0) if 'hold' in entry else 0))
        pools.append(entries)
    assert pools[STATES.index('idle')], 'idle pool is required'

    symbol = 'pet_' + ''.join(c if c.isalnum() else '_' for c in name)
    rgb565 = [(r >> 3) << 11 | (g >> 2) << 5 | b >> 3 for r, g, b in colors]
    lines = [f'static const uint16_t {symbol}_palette[] = {{0,{",".join(map(str, rgb565))}}};',
             f'static const uint8_t {symbol}_alpha[] = {{0,{",".join(["255"] * len(colors))}}};',
             f'static const uint8_t {symbol}_data[] = {{']
    for offset in range(0, len(data), 32):
        lines.append(','.join(map(str, data[offset:offset + 32])) + ',')
    lines += ['};', f'static const deskling_pet_frame_t {symbol}_frames[] = {{']
    lines += ['{%d,%d,%d,%d,%d,%d,%d},' % frame for frame in frames]
    lines += ['};', f'static const deskling_pet_animation_t {symbol}_animations[] = {{'
              + ','.join('{%d,%d,%d}' % (start, len(a['frames']), a['rest'])
                         for (_, a), start in zip(animations, starts)) + '};']
    pool_refs = []
    for state, entries in zip(STATES, pools):
        if entries:
            lines.append(f'static const deskling_pet_entry_t {symbol}_{state}[] = {{'
                         + ','.join('{%d,%d}' % e for e in entries) + '};')
            pool_refs.append(f'{{{symbol}_{state},{len(entries)}}}')
        else:
            pool_refs.append('{NULL,0}')
    definition = (f'{{"{name}",{width},{height},{pet["anchor"]["x"]},{pet["anchor"]["y"]},'
                  f'{symbol}_palette,{symbol}_alpha,{symbol}_data,{symbol}_frames,{symbol}_animations,'
                  f'{len(frames)},{max_patch},{{{",".join(pool_refs)}}}}}')
    print(f'{name}: {len(frames)} frames, {len(colors)} colours, {len(data)} packed bytes, '
          f'largest patch {max_patch} px')
    return lines, definition


lines, definitions = ['#include "pet_pack.h"'], []
for name in order:
    body, definition = compile_pet(name)
    lines += body
    definitions.append(definition)
lines += ['const deskling_pet_t deskling_pets[] = {' + ','.join(definitions) + '};',
          f'const size_t deskling_pet_count = {len(definitions)};']
output.write_text('\n'.join(lines) + '\n')
