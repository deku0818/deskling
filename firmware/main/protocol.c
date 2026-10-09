#include "deskling.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"

static bool known_state(const char *value)
{
    const char *names[] = {"working", "waiting", "done", "error", "limited", "stopped", "idle"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) if (!strcmp(value, names[i])) return true;
    return false;
}

static void copy_title(char *dest, size_t capacity, const char *source)
{
    size_t length = strlen(source);
    if (length >= capacity) {
        length = capacity - 1;
        // Do not leave half a UTF-8 character at the end of a long title.
        while (length && ((unsigned char)source[length] & 0xc0) == 0x80) length--;
    }
    memcpy(dest, source, length);
    dest[length] = 0;
}

bool deskling_parse_snapshot(const char *data, size_t length, deskling_state_t *output)
{
    if (!data || !output || length > DESKLING_SNAPSHOT_MAX || memchr(data, 0, length)) return false;
    cJSON *json = cJSON_ParseWithLengthOpts(data, length + 1, NULL, true);
    cJSON *version = cJSON_GetObjectItemCaseSensitive(json, "v");
    cJSON *provider = cJSON_GetObjectItemCaseSensitive(json, "provider");
    cJSON *overall = cJSON_GetObjectItemCaseSensitive(json, "overall");
    cJSON *sessions = cJSON_GetObjectItemCaseSensitive(json, "sessions");
    if (!cJSON_IsNumber(version) || (version->valuedouble != 1 && version->valuedouble != 2) || !cJSON_IsString(overall) ||
        !known_state(overall->valuestring) || !cJSON_IsArray(sessions)) {
        cJSON_Delete(json);
        return false;
    }
    const char *selected = cJSON_IsString(provider) ? provider->valuestring : "claude";
    if ((version->valuedouble == 2 && !cJSON_IsString(provider)) ||
        (strcmp(selected, "claude") && strcmp(selected, "codex")) ||
        (output->provider[0] && strcmp(output->provider, selected))) {
        cJSON_Delete(json); return false;
    }
    deskling_state_t state = *output;
    snprintf(state.provider, sizeof(state.provider), "%s", selected);
    snprintf(state.overall, sizeof(state.overall), "%s", overall->valuestring);
    state.session_count = 0;
    cJSON *entry;
    cJSON_ArrayForEach(entry, sessions) {
        if (state.session_count >= DESKLING_SESSION_MAX) break;
        cJSON *title = cJSON_GetObjectItemCaseSensitive(entry, "title");
        cJSON *status = cJSON_GetObjectItemCaseSensitive(entry, "state");
        if (!cJSON_IsString(title) || !cJSON_IsString(status) || !known_state(status->valuestring)) continue;
        deskling_session_t *s = &state.sessions[state.session_count++];
        copy_title(s->title, sizeof(s->title), title->valuestring);
        snprintf(s->state, sizeof(s->state), "%s", status->valuestring);
        s->stale = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(entry, "stale"));
    }
    cJSON *quota = cJSON_GetObjectItemCaseSensitive(json, "quota");
    const char *keys[] = {"5h", "week", "fable"};
    for (int i = 0; i < 3; i++) {
        cJSON *q = cJSON_GetObjectItemCaseSensitive(quota, keys[i]);
        cJSON *left = cJSON_GetObjectItemCaseSensitive(q, "left");
        cJSON *reset = cJSON_GetObjectItemCaseSensitive(q, "resetAt");
        state.quota[i].present = cJSON_IsNumber(left) && isfinite(left->valuedouble) && left->valuedouble >= 0 && left->valuedouble <= 100;
        state.quota[i].left = state.quota[i].present ? left->valuedouble : 0;
        state.quota[i].reset_at = cJSON_IsNumber(reset) && reset->valuedouble > 0 && reset->valuedouble < 1e12 ? (int64_t)reset->valuedouble : 0;
    }
    if (!strcmp(selected, "codex")) memset(&state.quota[2], 0, sizeof(state.quota[2]));
    state.has_snapshot = true;
    cJSON *updated = cJSON_GetObjectItemCaseSensitive(json, "ts");
    state.updated_at = cJSON_IsNumber(updated) && updated->valuedouble > 0 && updated->valuedouble < 1e12 ? (int64_t)updated->valuedouble : 0;
    state.connected = true;
    cJSON_Delete(json);
    state.message[0] = 0;
    *output = state;
    return true;
}
