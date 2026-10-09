#pragma once
// Single-threaded host preview: mutexes always succeed.
typedef void *SemaphoreHandle_t;
#define portMAX_DELAY 0xffffffffu
#define xSemaphoreCreateMutex() ((SemaphoreHandle_t)1)
#define xSemaphoreTake(lock, ticks) ((void)(lock), (void)(ticks), 1)
#define xSemaphoreGive(lock) ((void)(lock), 1)
