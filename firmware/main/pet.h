#pragma once
#include "lvgl.h"
typedef struct { uint32_t decoded, skipped, max_us; uint64_t total_us; } deskling_pet_metrics_t;
deskling_pet_metrics_t deskling_pet_metrics(bool reset);
void deskling_pet_start(lv_obj_t *parent);
// state: working, waiting, done, idle, stopped, offline or error; anything else shows idle.
void deskling_pet_state(const char *state);
void deskling_pet_pause(bool paused);
