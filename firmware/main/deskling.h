#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define DESKLING_SESSION_MAX 12
#define DESKLING_SNAPSHOT_MAX 8192

typedef struct {
    char title[257];
    char state[16];
    bool stale;
} deskling_session_t;

typedef struct {
    bool present;
    double left;
    int64_t reset_at;
} deskling_quota_t;

typedef struct {
    char provider[8];
    bool connected;
    bool has_snapshot;
    int64_t updated_at;
    char overall[16];
    char message[128];
    int session_count;
    deskling_session_t sessions[DESKLING_SESSION_MAX];
    deskling_quota_t quota[3];
} deskling_state_t;

void deskling_ui_start(void);
typedef struct {
    uint32_t render_count, render_max_us, tick_count, tick_max_gap_ms;
    uint64_t render_total_us;
    int view;
    char provider[8], overall[16];
} deskling_ui_metrics_t;
deskling_ui_metrics_t deskling_ui_metrics(bool reset);
void deskling_ui_publish(const deskling_state_t *state);
void deskling_ui_setup(const char *ssid, const char *password);
void deskling_ui_provision(const char *stage, const char *detail, const char *code);
void deskling_network_start(void);
void deskling_request_setup(void);
void deskling_request_pairing(void);
void deskling_select_provider(const char *provider);
bool deskling_parse_snapshot(const char *data, size_t length, deskling_state_t *output);
