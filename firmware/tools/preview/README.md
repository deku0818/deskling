# Native UI preview and checks

This harness compiles the production `ui.c`, `pet.c`, generated fonts and
pet tables against the same LVGL source used by the ESP32 firmware. Hardware
locks, timers and network actions are stubbed; rendering and hit testing use LVGL.
Its fixture sessions are used only on the host, never installed on the device.

Run an ESP-IDF build (or `idf.py reconfigure`) first to download LVGL. The pet
tables are generated from `assets/pets` by `tools/embed_pets.py` with the host
Python, which needs Pillow. Then, from the repository root:

```sh
cmake -S firmware/tools/preview -B /tmp/deskling-ui-preview-build
cmake --build /tmp/deskling-ui-preview-build -j 8
mkdir -p /tmp/deskling-ui-preview
/tmp/deskling-ui-preview-build/deskling-ui-preview /tmp/deskling-ui-preview
/tmp/deskling-ui-preview-build/deskling-pet-test
```

The executable writes 480×480 PPM screenshots for both providers, sessions,
quota, configuration, stale/offline states, missing/zero quota and long titles.
Pillow can convert them to PNG. Assertions check live list updates, wrapping,
back/list touch hit boxes, scroll preservation, cancel/save behavior, and glyph
lookup/bitmap decoding. Physical touch and panel output still need device checks.

The pet test checks frame timing against the pack, that incremental (changed
rectangle) frames match a replay from the keyframe, pool rotation, catch-up after
a late timer, held frames that sleep instead of polling, pause/resume and the
idle fallback for unknown states. UI assertions also check that
unchanged text and timestamp-only snapshots do not cause another render.
