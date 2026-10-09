#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include "provision_config.h"
static device_config_t original = {.version=3,.ssid="Home",.password="old-password",.hub="http://192.168.1.8:8787",.token="local-secret",.provider="codex",.hub_id="0123456789abcdef0123456789abcdef",.hub_type="local"};
static device_config_t result;
static bool pair;
static char hubs[4][256];
static const char *prepare(const char *text) {
    cJSON *json = cJSON_Parse(text);
    const char *error = deskling_prepare_config(&original, true, json, &result, &pair, hubs);
    cJSON_Delete(json); return error;
}
int main(void) {
    _Static_assert(sizeof(deskling_config_v2_t) == offsetof(device_config_t, hub_type), "v2 migration preserves its original binary layout");
    assert(!prepare("{\"ssid\":\"Home\",\"password\":\"\",\"preservePassword\":true,\"hubType\":\"remote\",\"hub\":\"https://hub.example.com/\",\"pair\":true}"));
    assert(pair && !result.token[0] && !result.hub_id[0]); assert(!strcmp(result.password,"old-password"));
    assert(!strcmp(result.hub,"https://hub.example.com")); assert(!deskling_can_discover(&result));
    assert(!prepare("{\"keepWifi\":true,\"hubType\":\"remote\",\"hub\":\"http://203.0.113.10:8787\",\"token\":\"remote-secret\"}"));
    assert(!pair && !strcmp(result.ssid,"Home") && !strcmp(result.password,"old-password"));
    assert(!strcmp(result.token,"remote-secret") && !result.hub_id[0]);
    assert(prepare("{\"keepWifi\":true,\"hubType\":\"remote\",\"hub\":\"\"}"));
    assert(prepare("{\"keepWifi\":true,\"hubType\":\"remote\",\"hub\":\"http://example.com/ws\"}"));
    assert(prepare("{\"keepWifi\":true,\"hubType\":\"remote\",\"hub\":\"http://example.com\",\"hubs\":[\"http://192.168.1.8:8787\"]}"));
    assert(prepare("{\"ssid\":\"Other\",\"password\":\"\",\"preservePassword\":true,\"keepHub\":true}"));
    assert(!prepare("{\"ssid\":\"Other\",\"password\":\"new-password\",\"keepHub\":true,\"hub\":\"http://attacker.example.com\"}"));
    assert(!pair && !strcmp(result.hub,original.hub) && !strcmp(result.token,original.token) && !strcmp(result.hub_id,original.hub_id));
    assert(!strcmp(original.password,"old-password") && !strcmp(original.token,"local-secret"));
    assert(deskling_valid_hub("http://[2001:db8::1]:8787"));
    assert(!deskling_valid_hub("ws://example.com/ws")); assert(!deskling_valid_hub("https://user:pass@example.com"));
    assert(!deskling_valid_hub("https://example.com/?key=x")); assert(!deskling_valid_hub("http://example.com\r\nHeader:x"));
    assert(prepare("[]"));
    puts("Provisioning target isolation and credential preservation passed");
}
