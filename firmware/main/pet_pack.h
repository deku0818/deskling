#pragma once
// Pet packs compiled from assets/pets by tools/embed_pets.py.
#include <stddef.h>
#include <stdint.h>

// Fixed state order shared with tools/embed_pets.py.
enum { DESKLING_PET_WORKING, DESKLING_PET_WAITING, DESKLING_PET_DONE, DESKLING_PET_IDLE,
       DESKLING_PET_STOPPED, DESKLING_PET_OFFLINE, DESKLING_PET_ERROR, DESKLING_PET_STATE_COUNT };

// A frame is a zlib-compressed rectangle of palette indices. The first frame of each
// animation covers the whole cell; later frames only cover what changed since the
// previous frame, so frames inside an animation must be applied in order.
typedef struct {
    uint16_t x, y, w, h; // w == 0: identical to the previous frame
    uint16_t duration_ms;
    uint32_t offset, size;
} deskling_pet_frame_t;

typedef struct { uint16_t start, count, rest; } deskling_pet_animation_t;

// hold_ms == 0: play the animation once; otherwise show its rest frame for hold_ms.
typedef struct { uint8_t animation; uint16_t hold_ms; } deskling_pet_entry_t;

typedef struct { const deskling_pet_entry_t *entries; uint8_t count; } deskling_pet_pool_t;

typedef struct {
    const char *id;
    uint16_t width, height; // cell size
    int16_t x, y;           // cell position inside the 440x238 companion area
    const uint16_t *palette; // RGB565
    const uint8_t *alpha;    // per palette entry
    const uint8_t *data;
    const deskling_pet_frame_t *frames;
    const deskling_pet_animation_t *animations;
    uint16_t frame_count;
    uint32_t max_patch; // largest frame rectangle, in pixels
    deskling_pet_pool_t states[DESKLING_PET_STATE_COUNT];
} deskling_pet_t;

extern const deskling_pet_t deskling_pets[];
extern const size_t deskling_pet_count; // deskling_pets[0] is the default pet
