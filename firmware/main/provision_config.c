#include "provision_config.h"
#include <ctype.h>
#include <string.h>
#include "http_parser.h"

bool deskling_valid_hub(const char *url)
{
    if (!*url) return true;
    if (strncmp(url, "http://", 7) && strncmp(url, "https://", 8)) return false;
    const char *host = strstr(url, "://") + 3;
    if (!*host || *host == '/') return false;
    for (const char *p = host; *p; p++) {
        if ((unsigned char)*p <= 32 || *p == '@' || *p == '?' || *p == '#') return false;
        if (*p == '/' && p[1]) return false;
    }
    struct http_parser_url parsed; http_parser_url_init(&parsed);
    return http_parser_parse_url(url, strlen(url), 0, &parsed) == 0 && (parsed.field_set & (1 << UF_HOST));
}
bool deskling_can_discover(const device_config_t *config) { return strcmp(config->hub_type, "remote") != 0; }
static bool copy(cJSON *json, const char *key, char *out, size_t size, bool required)
{
    cJSON *value = cJSON_GetObjectItemCaseSensitive(json, key);
    if (!value && !required) return true;
    if (!cJSON_IsString(value) || strlen(value->valuestring) >= size) return false;
    strcpy(out, value->valuestring); return true;
}
const char *deskling_prepare_config(const device_config_t *saved, bool configured, cJSON *json, device_config_t *out, bool *pair, char hubs[4][256])
{
    if (!cJSON_IsObject(json)) return "配置格式不正确。";
    *out = *saved; memset(hubs, 0, 4 * 256);
    bool keep_wifi = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "keepWifi"));
    bool keep_hub = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "keepHub"));
    if ((keep_wifi || keep_hub) && !configured) return "设备还没有已保存的配置。";
    char password[65] = "", token[257] = "";
    bool valid = keep_wifi || (copy(json, "ssid", out->ssid, sizeof(out->ssid), true) && out->ssid[0] && copy(json, "password", password, sizeof(password), true));
    if (!keep_wifi) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "preservePassword")) && !password[0]) {
            if (strcmp(out->ssid, saved->ssid)) valid = false;
        } else strcpy(out->password, password);
    }
    size_t length = strlen(out->password);
    if (length && length < 8) valid = false;
    if (length == 64) for (const char *p = out->password; *p; p++) if (!isxdigit((unsigned char)*p)) valid = false;
    if (!keep_hub) {
        valid = valid && copy(json, "hub", out->hub, sizeof(out->hub), false) && deskling_valid_hub(out->hub) &&
            copy(json, "hubType", out->hub_type, sizeof(out->hub_type), false) && copy(json, "token", token, sizeof(token), false);
        if (!out->hub_type[0]) strcpy(out->hub_type, "local");
        if (strcmp(out->hub_type, "local") && strcmp(out->hub_type, "remote")) valid = false;
        if (!deskling_can_discover(out) && !out->hub[0]) valid = false;
        bool changed = strcmp(out->hub, saved->hub) || strcmp(out->hub_type, saved->hub_type);
        bool request_pair = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "pair"));
        if (changed || token[0] || request_pair) { memset(out->token, 0, sizeof(out->token)); memset(out->hub_id, 0, sizeof(out->hub_id)); }
        if (token[0]) strcpy(out->token, token);
        valid = valid && copy(json, "hubId", out->hub_id, sizeof(out->hub_id), false);
        *pair = request_pair || !out->token[0];
        if (request_pair && token[0]) valid = false;
        if (*pair) { memset(out->token, 0, sizeof(out->token)); memset(out->hub_id, 0, sizeof(out->hub_id)); }
        cJSON *list = cJSON_GetObjectItemCaseSensitive(json, "hubs"), *entry; int i = 0;
        if (list && !cJSON_IsArray(list)) valid = false;
        cJSON_ArrayForEach(entry, list) {
            if (!deskling_can_discover(out) || i >= 4 || !cJSON_IsString(entry) || !entry->valuestring[0] || strlen(entry->valuestring) >= 256 || !deskling_valid_hub(entry->valuestring)) { valid = false; break; }
            strcpy(hubs[i++], entry->valuestring);
        }
    } else {
        *pair = false;
        // Wi-Fi-only changes cannot replace, rediscover, or reveal Hub credentials.
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "pair"))) valid = false;
        cJSON *value = cJSON_GetObjectItemCaseSensitive(json, "token");
        if (value && (!cJSON_IsString(value) || value->valuestring[0])) valid = false;
    }
    for (const char *p = out->token; *p; p++) if ((unsigned char)*p <= 32 || (unsigned char)*p >= 127) valid = false;
    size_t n = strlen(out->hub); if (n && out->hub[n - 1] == '/') out->hub[n - 1] = 0;
    out->version = 3;
    memset(password, 0, sizeof(password)); memset(token, 0, sizeof(token));
    if (!valid) { memset(out, 0, sizeof(*out)); memset(hubs, 0, 4 * 256); return "检查 Wi-Fi 名称、密码和 Hub 地址。"; }
    return NULL;
}
