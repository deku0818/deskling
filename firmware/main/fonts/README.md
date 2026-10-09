The device uses the same Fusion Pixel Font 2026.09.25 as the web UI. Font
sources and licenses are in [assets/fonts](../../../assets/fonts/):
SIL OFL plus the bundled upstream component licenses.

The 24px font includes the upstream font's CJK ideographs (including its
extension-A subset), Latin, kana, punctuation and full-width characters.
It is generated from the full upstream font, so session titles are not limited
to characters present in the demo. 1,770 missing basic CJK glyphs are filled
from Noto Sans CJK SC Regular (Adobe copyright 2014–2021; Noto is a trademark
of Google Inc.), under [SIL OFL](Noto-OFL.txt).
The 12px font contains static UI text, the 20px font serves the clock and
ASCII status words, and the 28px font serves quota percentages.

The source is a 12px pixel font. Glyphs use 1-bit bitmaps; 24px uses an exact
2× scale. Line height and baseline follow the web CSS em boxes and the font's
hhea metrics. Large bitmap offsets and the compressed glyph decoder are enabled
in sdkconfig.defaults. The generated C sources are sufficient for normal builds.

To regenerate:

    pip install 'fonttools[woff]'
    npm install --prefix /tmp/deskling-font-tools lv_font_conv@1.5.3
    python firmware/tools/build_pixel_fonts.py --converter /tmp/deskling-font-tools/node_modules/.bin/lv_font_conv

Pass --archive for an already-downloaded release ZIP and --fallback-font for a
local Noto OTF. The generator verifies both SHA-256 hashes. Supplementary-plane
CJK and emoji remain outside the device font.
