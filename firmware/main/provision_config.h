#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "cJSON.h"
typedef struct { uint32_t version; char ssid[33], password[65], hub[256], token[257], provider[8], hub_id[33]; } deskling_config_v2_t;
typedef struct { uint32_t version; char ssid[33], password[65], hub[256], token[257], provider[8], hub_id[33], hub_type[8]; } device_config_t;
bool deskling_valid_hub(const char *url);
bool deskling_can_discover(const device_config_t *config);
const char *deskling_prepare_config(const device_config_t *saved, bool configured, cJSON *json, device_config_t *out, bool *pair, char hubs[4][256]);
