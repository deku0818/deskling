// Exercise the production pet player with a deterministic LVGL tick.
#include "../../main/pet.c"
#include <stdio.h>
#include <stdlib.h>
#include "src/misc/lv_timer_private.h"

static int animation_id(int state_index, int entry) { return pet->states[state_index].entries[entry].animation; }
static uint32_t entry_ms(int index)
{
    const deskling_pet_animation_t *a = &pet->animations[index];
    uint32_t total = 0;
    for (int i = 0; i < a->count; i++) total += pet->frames[a->start + i].duration_ms;
    return total;
}
static void advance(uint32_t ms) { lv_tick_inc(ms); animate(NULL); }
// Replays an animation from its first frame into a separate buffer.
static void reference(int index, int target, uint8_t *out)
{
    uint8_t *saved = pixels; lv_obj_t *saved_view = view; int saved_displayed = displayed, saved_animation = animation;
    pixels = out; displayed = -1; animation = index; view = NULL;
    show(target);
    pixels = saved; view = saved_view; displayed = saved_displayed; animation = saved_animation;
}

int main(void)
{
    lv_init(); lv_display_create(480, 480);
    deskling_pet_start(lv_screen_active());
    lv_obj_t *created = view;
    size_t bytes = (size_t)pet->width * pet->height * 3;

    // Startup shows the first idle entry: a held still frame that decodes once.
    assert(state == DESKLING_PET_IDLE && holding && pet->states[DESKLING_PET_IDLE].entries[0].hold_ms);
    deskling_pet_metrics(true);
    for (int i = 0; i < 20; i++) advance(100);
    assert(deskling_pet_metrics(false).decoded == 0);
    assert(timer->period > 1000); // sleeps through the hold instead of polling

    // Working plays its first animation frame by frame on the recorded durations.
    deskling_pet_state("working");
    const deskling_pet_animation_t *walk = &pet->animations[animation_id(DESKLING_PET_WORKING, 0)];
    assert(animation == animation_id(DESKLING_PET_WORKING, 0) && frame == 0);
    advance(pet->frames[walk->start].duration_ms - 1); assert(frame == 0);
    advance(1); assert(frame == 1);
    // Incremental frames match a replay from the keyframe.
    uint8_t *expected = malloc(bytes);
    for (int i = 2; i < walk->count; i++) {
        advance(pet->frames[walk->start + i - 1].duration_ms); assert(frame == i);
        memset(expected, 0, bytes); reference(animation, i, expected);
        assert(!memcmp(expected, pixels, bytes));
    }
    // One full pass, then the next entry in the pool.
    advance(pet->frames[walk->start + walk->count - 1].duration_ms);
    assert(animation == animation_id(DESKLING_PET_WORKING, 1) && frame == 0);

    // A late timer catches up on the frames it missed; a long stall continues from now instead.
    int late = frame; advance(250); assert(frame >= late + 2);
    late = frame; advance(5000); assert(frame == late + 1);
    assert(entry_ms(animation) > 1000);

    // Paused: no decoding, and the remaining frame time is kept on resume.
    deskling_pet_state("done");
    int before = frame; deskling_pet_pause(true); deskling_pet_metrics(true);
    lv_tick_inc(5000); animate(NULL);
    assert(deskling_pet_metrics(false).decoded == 0 && frame == before);
    deskling_pet_pause(false); animate(NULL); assert(frame == before);

    // Unknown states fall back to idle and continue its rotation.
    deskling_pet_state("limited");
    assert(state == DESKLING_PET_IDLE && animation == animation_id(DESKLING_PET_IDLE, 1) && !holding);

    // Offline holds the still frame for its configured time.
    deskling_pet_state("offline");
    assert(holding);
    deskling_pet_metrics(true);
    advance(pet->states[DESKLING_PET_OFFLINE].entries[0].hold_ms - 1);
    assert(deskling_pet_metrics(false).decoded == 0);
    assert(view == created);
    free(expected);
    puts("Pet tests passed: held frames sleep, frame timing, delta replay, pool rotation, catch-up, pause, fallback.");
    return 0;
}
