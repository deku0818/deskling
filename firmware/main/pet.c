// Plays a pet pack (pet_pack.h). Frames are palette-index rectangles applied in order onto
// one RGB565A8 image; only the changed rectangle is decoded and invalidated.
#include "pet.h"
#include "pet_pack.h"
#include <assert.h>
#include <string.h>
#include "esp_timer.h"
#include "zlib.h"
#include "freertos/FreeRTOS.h"

static const char *const state_names[DESKLING_PET_STATE_COUNT] = {
    "working", "waiting", "done", "idle", "stopped", "offline", "error"};
static const deskling_pet_t *pet;
static lv_obj_t *view;
static lv_timer_t *timer;
static uint8_t *pixels, *scratch;
static z_stream stream;
static lv_image_dsc_t image;
static int state = -1, animation, frame, displayed = -1;
static unsigned cursors[DESKLING_PET_STATE_COUNT];
static bool holding, paused;
static int64_t next_at;
static portMUX_TYPE metrics_lock = portMUX_INITIALIZER_UNLOCKED;
static deskling_pet_metrics_t metrics;

deskling_pet_metrics_t deskling_pet_metrics(bool reset)
{
    portENTER_CRITICAL(&metrics_lock); deskling_pet_metrics_t result = metrics;
    if (reset) memset(&metrics, 0, sizeof(metrics));
    portEXIT_CRITICAL(&metrics_lock); return result;
}

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

// Applies one stored frame to the image and grows *dirty (cell coordinates) to cover it.
static void apply(int index, lv_area_t *dirty, bool *any)
{
    const deskling_pet_frame_t *f = &pet->frames[index];
    displayed = index;
    if (!f->w) {
        portENTER_CRITICAL(&metrics_lock); metrics.skipped++; portEXIT_CRITICAL(&metrics_lock); return;
    }
    int64_t started = esp_timer_get_time();
    // One long-lived inflate stream: uncompress() would allocate and free ~40 KB of zlib
    // state per frame, fragmenting the internal heap that SPI and Wi-Fi depend on.
    int result = inflateReset(&stream);
    stream.next_in = (Bytef *)(pet->data + f->offset); stream.avail_in = f->size;
    stream.next_out = scratch; stream.avail_out = (uInt)f->w * f->h;
    if (result == Z_OK) result = inflate(&stream, Z_FINISH);
    assert(result == Z_STREAM_END && stream.avail_out == 0);
    uint16_t *color = (uint16_t *)pixels;
    uint8_t *alpha = pixels + (size_t)pet->width * pet->height * 2;
    const uint8_t *source = scratch;
    for (int y = f->y; y < f->y + f->h; y++) {
        size_t row = (size_t)y * pet->width + f->x;
        for (int x = 0; x < f->w; x++, source++) {
            color[row + x] = pet->palette[*source];
            alpha[row + x] = pet->alpha[*source];
        }
    }
    uint32_t elapsed = (uint32_t)(esp_timer_get_time() - started);
    portENTER_CRITICAL(&metrics_lock);
    metrics.decoded++; metrics.total_us += elapsed; if (elapsed > metrics.max_us) metrics.max_us = elapsed;
    portEXIT_CRITICAL(&metrics_lock);
    lv_area_t area = {f->x, f->y, f->x + f->w - 1, f->y + f->h - 1};
    if (*any) {
        if (area.x1 < dirty->x1) dirty->x1 = area.x1;
        if (area.y1 < dirty->y1) dirty->y1 = area.y1;
        if (area.x2 > dirty->x2) dirty->x2 = area.x2;
        if (area.y2 > dirty->y2) dirty->y2 = area.y2;
    } else *dirty = area;
    *any = true;
}

// Brings the image to frame `target` of the current animation.
static void show(int target)
{
    const deskling_pet_animation_t *a = &pet->animations[animation];
    int first = a->start, last = a->start + target;
    // Later frames are deltas: continue from the displayed frame when it is earlier in this animation.
    if (displayed >= first && displayed <= last) first = displayed + 1;
    lv_area_t dirty; bool any = false;
    for (int index = first; index <= last; index++) apply(index, &dirty, &any);
    frame = target;
    if (!any || !view) return;
    lv_area_t coords; lv_obj_get_coords(view, &coords);
    lv_area_move(&dirty, coords.x1, coords.y1);
    lv_obj_invalidate_area(view, &dirty);
}
static void next_entry(int64_t now)
{
    const deskling_pet_pool_t *pool = &pet->states[state];
    if (!pool->count) pool = &pet->states[DESKLING_PET_IDLE];
    // Each state keeps its own place in the pool, like the web page.
    const deskling_pet_entry_t *entry = &pool->entries[cursors[state]++ % pool->count];
    animation = entry->animation; holding = entry->hold_ms != 0;
    if (holding) { show(pet->animations[animation].rest); next_at = now + entry->hold_ms; return; }
    show(0);
    next_at = now + pet->frames[pet->animations[animation].start].duration_ms;
}

// Sleep until the next frame is due instead of polling.
static void schedule(int64_t now)
{
    int64_t wait = next_at - now;
    lv_timer_set_period(timer, wait < 1 ? 1 : (uint32_t)wait);
}

static void animate(lv_timer_t *unused)
{
    (void)unused;
    if (paused || state < 0) return;
    int64_t now = now_ms();
    // After a long stall, continue from now instead of replaying every missed frame.
    if (now - next_at > 1000) next_at = now;
    while (now >= next_at) {
        const deskling_pet_animation_t *a = &pet->animations[animation];
        if (holding || frame + 1 >= a->count) { next_entry(next_at); continue; }
        show(frame + 1);
        next_at += pet->frames[a->start + frame].duration_ms;
    }
    schedule(now);
}

void deskling_pet_state(const char *name)
{
    int next = DESKLING_PET_IDLE;
    for (int i = 0; i < DESKLING_PET_STATE_COUNT; i++) if (!strcmp(name, state_names[i])) next = i;
    if (next == state) return;
    state = next;
    int64_t now = now_ms();
    next_entry(now);
    if (timer) schedule(now);
}

void deskling_pet_start(lv_obj_t *parent)
{
    assert(deskling_pet_count > 0);
    pet = &deskling_pets[0];
    size_t area = (size_t)pet->width * pet->height;
    pixels = lv_malloc(area * 3); scratch = lv_malloc(pet->max_patch);
    assert(pixels && scratch);
    memset(pixels, 0, area * 3);
    int result = inflateInit(&stream); assert(result == Z_OK); (void)result;
    image = (lv_image_dsc_t){ .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565A8,
        .flags = LV_IMAGE_FLAGS_MODIFIABLE, .w = pet->width, .h = pet->height, .stride = pet->width * 2 },
        .data_size = area * 3, .data = pixels };
    view = lv_image_create(parent);
    lv_obj_set_pos(view, pet->x, pet->y);
    lv_image_set_src(view, &image); lv_obj_set_clickable(view, false);
    timer = lv_timer_create(animate, 40, NULL);
    // Decode at startup so corrupt assets fail before connecting.
    deskling_pet_state("idle");
}

void deskling_pet_pause(bool value)
{
    if (paused == value) return;
    paused = value;
    if (!timer) return;
    // Keep the time left on the current frame rather than catching up on the hidden time.
    static int64_t remaining;
    if (paused) { remaining = next_at - now_ms(); lv_timer_pause(timer); return; }
    next_at = now_ms() + (remaining > 0 ? remaining : 0);
    lv_timer_resume(timer); lv_timer_ready(timer);
}
