"""Build the Clawd pet pack (assets/pets/clawd) from the official artwork. Requires Pillow.

Frames are scaled to 480px wide with nearest-neighbour sampling, cropped to the area the
480x238 companion shows (x 20-460, y 90-323 of the scaled frame) and trimmed to the union of
visible pixels. Transparency is preserved, so the pack does not depend on a background colour.
Identical frames are stored once and each frame is trimmed to its visible pixels in the atlas,
which keeps the decoded sheet small enough for phone browsers.
"""
from pathlib import Path
import hashlib
import json
from PIL import Image, ImageSequence

root = Path(__file__).resolve().parents[1]
official = root / 'assets/clawd-official'
output = root / 'assets/pets/clawd'
SCALED_WIDTH, VISIBLE = 480, (20, 90, 460, 323)
ATLAS_WIDTH = 2048

# Animation order is the frame order in the sheet. rest: frame shown for reduced motion.
ANIMATIONS = [
    ('still', 'still.png', 'first', '安静休息', 'Clawd 安静休息'),
    ('crab-walking', 'crab-walking.gif', 'first', '小步走动', 'Clawd 横向走路'),
    ('magnifier', 'magnifier.gif', 'last', '寻找线索', 'Clawd 举起放大镜'),
    ('pointing', 'pointing.gif', 'last', '指一指', 'Clawd 指向一旁'),
    ('waving', 'waving.gif', 'last', '挥手招呼', 'Clawd 挥手招呼'),
    ('jumping-happy', 'jumping-happy.gif', 'last', '开心跳跃', 'Clawd 开心跳跃'),
    ('jumping', 'jumping.gif', 'last', '轻轻跳一下', 'Clawd 轻轻跳跃'),
    ('dancing', 'dancing.gif', 'last', '跳个小舞', 'Clawd 跳舞庆祝'),
    ('cloud', 'cloud.gif', 'last', '坐一会儿云朵', 'Clawd 坐在云朵上'),
]
# Each state rotates through its pool. play: one full pass; hold: one frame for ms.
STATES = {
    'working': [{'play': 'crab-walking'}, {'play': 'magnifier'}],
    'waiting': [{'play': 'pointing'}, {'play': 'waving'}],
    'done': [{'play': 'jumping-happy'}, {'play': 'jumping'}, {'play': 'dancing'}],
    'idle': [{'hold': 'still', 'ms': 4800, 'name': '轻轻呼吸', 'alt': 'Clawd 安静陪伴'}, {'play': 'cloud'}],
    'stopped': [{'hold': 'still', 'ms': 4800, 'name': '安静休息', 'alt': 'Clawd 安静休息'}, {'play': 'cloud'}],
    'offline': [{'hold': 'still', 'ms': 7000, 'name': '等待连接', 'alt': 'Clawd 等待连接'}],
    'error': [{'hold': 'still', 'ms': 6000, 'name': '提醒查看', 'alt': 'Clawd 提醒查看错误'}],
}


def load(filename):
    source = Image.open(official / filename)
    frames, durations = [], []
    for frame in ImageSequence.Iterator(source):
        rgba = frame.convert('RGBA')
        size = (SCALED_WIDTH, round(rgba.height * SCALED_WIDTH / rgba.width))
        assert size[1] >= VISIBLE[3], (filename, size)
        scaled = rgba.resize(size, Image.Resampling.NEAREST).crop(VISIBLE)
        # Binary alpha keeps palette packing and compositing exact.
        alpha = scaled.getchannel('A')
        assert not any(alpha.histogram()[1:255]), f'{filename}: partial transparency'
        clear = Image.new('RGBA', scaled.size, (0, 0, 0, 0))
        frames.append(Image.composite(scaled, clear, alpha))
        durations.append(frame.info.get('duration', 80) if filename.endswith('.gif') else 0)
    return frames, durations


def eyes(frame):
    """Eye rectangles (pure black pixels) on a calm frame, for the web blink overlay."""
    dark = [(x, y) for y in range(frame.height) for x in range(frame.width) if frame.getpixel((x, y)) == (0, 0, 0, 255)]
    middle = 240 - VISIBLE[0] - offset[0]
    shapes = []
    for points in ([p for p in dark if p[0] < middle], [p for p in dark if p[0] >= middle]):
        if not points:
            return None
        xs, ys = zip(*points)
        x, y, w, h = min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        if w > 40 or h > 40:
            return None
        color = frame.getpixel((x - 1, y + h // 2))
        shapes.append({'x': x, 'y': y, 'w': w, 'h': h, 'color': '#%02x%02x%02x' % color[:3]})
    return shapes


loaded = {name: load(filename) for name, filename, *_ in ANIMATIONS}
bounds = None
for frames, _ in loaded.values():
    for frame in frames:
        box = frame.getchannel('A').getbbox()
        if box:
            bounds = box if bounds is None else (min(bounds[0], box[0]), min(bounds[1], box[1]),
                                                 max(bounds[2], box[2]), max(bounds[3], box[3]))
offset = bounds[:2]
width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]

# Identical frames are stored once; each animation lists the frames it plays.
unique, lookup, animations, eye_shapes = [], {}, {}, {}
for name, filename, rest, title, alt in ANIMATIONS:
    frames, durations = loaded[name]
    indices = []
    for frame in frames:
        cell = frame.crop(bounds)
        key = cell.tobytes()
        if key not in lookup:
            lookup[key] = len(unique)
            unique.append(cell)
        indices.append(lookup[key])
    rest_index = 0 if rest == 'first' else len(frames) - 1
    animations[name] = {'frames': indices, 'durations': durations, 'rest': rest_index, 'name': title, 'alt': alt}
    shapes = eyes(unique[indices[rest_index]])
    if shapes:
        eye_shapes[name] = shapes

for state, pool in STATES.items():
    for entry in pool:
        assert (entry.get('play') or entry.get('hold')) in animations, (state, entry)
assert 'idle' in STATES

# Shelf-pack each frame's visible pixels into an atlas, tallest first.
boxes = [cell.getchannel('A').getbbox() for cell in unique]
placed, x, y, shelf = {}, 0, 0, 0
for index in sorted(range(len(unique)), key=lambda i: -(boxes[i][3] - boxes[i][1]) if boxes[i] else 0):
    box = boxes[index]
    if not box:
        continue
    w, h = box[2] - box[0], box[3] - box[1]
    if x + w > ATLAS_WIDTH:
        x, y, shelf = 0, y + shelf, 0
    placed[index] = (x, y)
    x, shelf = x + w, max(shelf, h)
atlas = Image.new('RGBA', (ATLAS_WIDTH, y + shelf), (0, 0, 0, 0))
regions = []
for index, cell in enumerate(unique):
    box = boxes[index]
    if not box:
        regions.append([0, 0, 0, 0, 0, 0])
        continue
    sx, sy = placed[index]
    atlas.paste(cell.crop(box), (sx, sy))
    regions.append([sx, sy, box[2] - box[0], box[3] - box[1], box[0], box[1]])
output.mkdir(parents=True, exist_ok=True)
atlas.save(output / 'sheet.webp', lossless=True, quality=100, method=6, exact=True)

# Round trip: every frame of every animation must come back exactly from the encoded atlas.
decoded = Image.open(output / 'sheet.webp').convert('RGBA')
for name, animation in animations.items():
    for k, index in enumerate(animation['frames']):
        sx, sy, w, h, dx, dy = regions[index]
        canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        if w:
            canvas.paste(decoded.crop((sx, sy, sx + w, sy + h)), (dx, dy))
        assert canvas.tobytes() == loaded[name][0][k].crop(bounds).tobytes(), f'{name} frame {k} changed'

pet = {
    'id': 'clawd', 'name': 'Clawd', 'sheet': 'sheet.webp',
    'size': {'width': width, 'height': height},
    # Top-left of the frame canvas inside the 440x238 companion area.
    'anchor': {'x': offset[0], 'y': offset[1]},
    # [sheet x, sheet y, width, height, x, y in the frame canvas]; width 0 is an empty frame.
    'frames': regions,
    'animations': animations, 'states': STATES, 'eyes': eye_shapes,
}
text = json.dumps(pet, ensure_ascii=False, indent=1)
(output / 'pet.json').write_text(text + '\n')
# file:// pages cannot fetch JSON; the web page loads this script instead.
(output / 'pet.js').write_text('window.DESKLING_PETS=window.DESKLING_PETS||{};window.DESKLING_PETS.clawd='
                               + json.dumps(pet, ensure_ascii=False, separators=(',', ':')) + ';\n')
digest = hashlib.sha256((output / 'sheet.webp').read_bytes()).hexdigest()
(output / 'source.json').write_text(json.dumps({
    'source': 'assets/clawd-official (claude.ai official Clawd artwork)',
    'generator': 'scripts/build-pet-clawd.py',
    'scaling': f'nearest neighbour to {SCALED_WIDTH}px wide, visible window {list(VISIBLE)}',
    'sheetSha256': digest,
}, ensure_ascii=False, indent=2) + '\n')
print(f'Clawd: {sum(len(a["frames"]) for a in animations.values())} frames, {len(unique)} unique, '
      f'frame {width}x{height}, anchor {offset}, sheet {atlas.size}, '
      f'{(output / "sheet.webp").stat().st_size} bytes')
