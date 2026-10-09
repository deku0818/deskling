#pragma once
#include <stdio.h>
#define ESP_LOGI(tag, ...) do { printf("%s: ", tag); printf(__VA_ARGS__); puts(""); } while(0)
