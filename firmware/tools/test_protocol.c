#include "deskling.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static bool parse(const char *json, deskling_state_t *state)
{
    return deskling_parse_snapshot(json, strlen(json), state);
}

int main(void)
{
    deskling_state_t state = {0};
    const char *valid = "{\"v\":1,\"overall\":\"waiting\",\"sessions\":["
        "{\"title\":\"测试会话\",\"state\":\"waiting\",\"stale\":true},"
        "{\"title\":\"Second\",\"state\":\"working\",\"stale\":false}],"
        "\"quota\":{\"5h\":{\"left\":0,\"resetAt\":1791500000},"
        "\"week\":{\"left\":42.5,\"resetAt\":1791600000},\"fable\":null}}";
    assert(parse(valid, &state));
    assert(state.connected && state.has_snapshot);
    assert(state.session_count == 2 && !strcmp(state.sessions[0].title, "测试会话"));
    assert(state.sessions[0].stale && !state.sessions[1].stale);
    assert(state.quota[0].present && state.quota[0].left == 0);
    assert(state.quota[1].present && state.quota[1].left == 42.5);
    assert(!state.quota[2].present);
    deskling_state_t before = state;
    const char *invalid[] = {"null", "{", "{}", "[]", "{\"v\":2,\"overall\":\"idle\",\"sessions\":[]}",
        "{\"v\":1,\"overall\":\"unknown\",\"sessions\":[]}",
        "{\"v\":1,\"overall\":\"idle\",\"sessions\":null}",
        "{\"v\":1,\"overall\":\"idle\",\"sessions\":[]}garbage"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        assert(!parse(invalid[i], &state));
        assert(!memcmp(&before, &state, sizeof(state)));
    }
    char with_null[] = "{\"v\":1,\"overall\":\"idle\",\"sessions\":[]}\0hidden";
    assert(!deskling_parse_snapshot(with_null, sizeof(with_null) - 1, &state));
    assert(!deskling_parse_snapshot(NULL, 0, &state));
    assert(!deskling_parse_snapshot(valid, strlen(valid), NULL));
    assert(parse("{\"v\":1,\"overall\":\"idle\",\"sessions\":[],\"quota\":{\"5h\":{\"left\":101},\"week\":{\"left\":-1},\"fable\":{\"left\":\"0\"}}}", &state));
    assert(!state.quota[0].present && !state.quota[1].present && !state.quota[2].present);
    assert(state.session_count == 0);
    char many[4096] = "{\"v\":1,\"overall\":\"working\",\"sessions\":[";
    for (int i = 0; i < 20; i++) {
        char row[100]; snprintf(row, sizeof(row), "%s{\"title\":\"%d\",\"state\":\"working\"}", i ? "," : "", i);
        strcat(many, row);
    }
    strcat(many, "]}");
    assert(parse(many, &state));
    assert(state.session_count == 12 && !strcmp(state.sessions[11].title, "11"));
    memset(&state, 0, sizeof(state)); strcpy(state.provider, "codex");
    assert(parse("{\"v\":2,\"provider\":\"codex\",\"ts\":1791478800,\"overall\":\"working\",\"sessions\":[],\"quota\":{\"fable\":{\"left\":70}}}", &state));
    assert(!strcmp(state.provider, "codex") && !state.quota[2].present);
    assert(state.updated_at == 1791478800);
    before = state;
    assert(!parse("{\"v\":2,\"provider\":\"claude\",\"overall\":\"waiting\",\"sessions\":[]}", &state));
    assert(!memcmp(&before, &state, sizeof(state)));
    assert(!parse(valid, &state)); // A late v1 Claude snapshot cannot cross a Codex selection.
    char long_title[512], long_snapshot[1024];
    memset(long_title, 'A', 255);
    strcpy(long_title + 255, "设备连接");
    snprintf(long_snapshot, sizeof(long_snapshot),
        "{\"v\":2,\"provider\":\"codex\",\"overall\":\"working\",\"sessions\":[{\"title\":\"%s\",\"state\":\"working\"}]}", long_title);
    assert(parse(long_snapshot, &state));
    assert(strlen(state.sessions[0].title) == 255); // Cut before the three-byte character.
    assert(state.sessions[0].title[254] == 'A');
    puts("Protocol tests passed: schema, atomic updates, UTF-8, missing/zero quota, bounds, trailing/embedded data.");
}
