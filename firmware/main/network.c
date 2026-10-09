#include "deskling.h"
#include "pet.h"
#include "provision_config.h"
#include <assert.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_websocket_client.h"
#include "mdns.h"
#include "nvs.h"
#include "cJSON.h"
#include "http_parser.h"
#include "lwip/sockets.h"

static const char *TAG = "deskling-net";
#define WIFI_CONNECTED BIT0
#define SETUP_REQUESTED BIT1
#define CANCEL_REQUESTED BIT2
#define WIFI_FAILED BIT3
#define PREFIX "@deskling "

typedef struct { int op; char id[16]; device_config_t config; char hubs[4][256]; bool pair; unsigned job; } command_t;
static device_config_t saved;
static deskling_state_t state;
static EventGroupHandle_t events;
static QueueHandle_t commands, provider_queue;
static SemaphoreHandle_t lock, radio_lock;
static esp_websocket_client_handle_t client;
static esp_netif_t *sta_netif;
static httpd_handle_t portal_server;
static volatile int wifi_reason;
static volatile bool busy;
static bool configured, ap_active, portal_pair_requested;
// The Hub only needs one successful activation per credential; retry until it succeeds.
static bool credential_active;
// Background Wi-Fi reconnects back off from 1 s to 30 s while the access point is missing.
// Only network_task touches these.
static int64_t reconnect_at;
static uint32_t reconnect_delay_ms = 1000;
static unsigned job_number;
static char stage[16] = "idle", error_text[128], stage_detail[128], pairing_code[8], device_id[13];
static char candidate_hub[256], candidate_hub_type[8];
static char ap_name[33], ap_password[17], candidate_ssid[33];
// Internal RAM is reserved for DMA and Wi-Fi; large CPU-only buffers live in PSRAM.
static char ws_url[320], auth_header[300], *incoming;
static size_t incoming_len;
static bool receiving;
static void start_websocket(void);
static void stop_websocket(void) { if (client) { esp_websocket_client_stop(client); esp_websocket_client_destroy(client); client = NULL; } }
static void message(const char *text) { snprintf(state.message, sizeof(state.message), "%s", text); deskling_ui_publish(&state); }
static void set_stage(const char *value, const char *detail, const char *code)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    snprintf(stage, sizeof(stage), "%s", value);
    snprintf(stage_detail, sizeof(stage_detail), "%s", detail ? detail : "");
    snprintf(error_text, sizeof(error_text), "%s", !strcmp(value, "error") ? detail : "");
    snprintf(pairing_code, sizeof(pairing_code), "%s", code ? code : "");
    xSemaphoreGive(lock);
    deskling_ui_provision(value, detail, code ? code : "");
}
static bool copy_json(cJSON *json, const char *key, char *out, size_t size, bool required)
{
    cJSON *value = cJSON_GetObjectItemCaseSensitive(json, key);
    if (!value && !required) return true;
    if (!cJSON_IsString(value) || strlen(value->valuestring) >= size) return false;
    strcpy(out, value->valuestring); return true;
}
static bool load_config(void)
{
    nvs_handle_t nvs; if (nvs_open("deskling", NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t size = sizeof(saved);
    if (nvs_get_blob(nvs, "config_v3", &saved, &size) != ESP_OK || size != sizeof(saved) || saved.version != 3) {
        memset(&saved, 0, sizeof(saved)); saved.version = 3;
        deskling_config_v2_t old = {0}; size = sizeof(old);
        if (nvs_get_blob(nvs, "config_v2", &old, &size) == ESP_OK && size == sizeof(old) && old.version == 2) {
            memcpy(&saved, &old, sizeof(old)); saved.version = 3;
        } else {
        size = sizeof(saved.ssid); nvs_get_str(nvs, "wifi_ssid", saved.ssid, &size);
        size = sizeof(saved.password); nvs_get_str(nvs, "wifi_pass", saved.password, &size);
        size = sizeof(saved.hub); nvs_get_str(nvs, "hub_url", saved.hub, &size);
        size = sizeof(saved.token); nvs_get_str(nvs, "display_token", saved.token, &size);
        size = sizeof(saved.provider); nvs_get_str(nvs, "provider", saved.provider, &size);
        }
        strcpy(saved.hub_type, "local");
    }
    nvs_close(nvs);
    saved.ssid[32] = 0; saved.password[64] = 0; saved.hub[255] = 0; saved.token[256] = 0; saved.provider[7] = 0; saved.hub_id[32] = 0; saved.hub_type[7] = 0;
    if (strcmp(saved.provider, "claude") && strcmp(saved.provider, "codex")) strcpy(saved.provider, "claude");
    if (strcmp(saved.hub_type, "local") && strcmp(saved.hub_type, "remote")) return false;
    size_t length = strlen(saved.hub); if (length && saved.hub[length - 1] == '/') saved.hub[length - 1] = 0;
    strcpy(state.provider, saved.provider);
    return saved.ssid[0] && saved.token[0] && deskling_valid_hub(saved.hub) && (deskling_can_discover(&saved) || saved.hub[0]);
}
static esp_err_t save_config(const device_config_t *config)
{
    nvs_handle_t nvs; esp_err_t err = nvs_open("deskling", NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        // One blob keeps a failed write from mixing new Wi-Fi with old Hub credentials.
        err = nvs_set_blob(nvs, "config_v3", config, sizeof(*config));
        if (err == ESP_OK) err = nvs_commit(nvs);
        nvs_close(nvs);
    }
    return err;
}
static cJSON *status_json(void)
{
    cJSON *json = cJSON_CreateObject(); xSemaphoreTake(lock, portMAX_DELAY);
    cJSON_AddStringToObject(json, "stage", stage); cJSON_AddStringToObject(json, "error", error_text);
    cJSON_AddStringToObject(json, "detail", stage_detail);
    cJSON_AddStringToObject(json, "hubType", saved.hub_type);
    cJSON_AddStringToObject(json, "targetHub", busy ? candidate_hub : saved.hub);
    cJSON_AddStringToObject(json, "targetHubType", busy ? candidate_hub_type : saved.hub_type);
    cJSON_AddStringToObject(json, "code", pairing_code); cJSON_AddNumberToObject(json, "job", job_number);
    cJSON_AddBoolToObject(json, "configured", configured); cJSON_AddBoolToObject(json, "busy", busy);
    cJSON_AddStringToObject(json, "ssid", busy ? candidate_ssid : saved.ssid);
    cJSON_AddStringToObject(json, "hub", saved.hub); cJSON_AddStringToObject(json, "hubId", saved.hub_id);
    cJSON_AddStringToObject(json, "provider", saved.provider); cJSON_AddStringToObject(json, "deviceId", device_id);
    cJSON_AddBoolToObject(json, "hasPassword", saved.password[0] != 0); cJSON_AddNumberToObject(json, "protocol", 2);
    cJSON_AddBoolToObject(json, "pairRequested", portal_pair_requested);
    xSemaphoreGive(lock);
    esp_netif_ip_info_t ip; char address[20] = "";
    if (sta_netif && esp_netif_get_ip_info(sta_netif, &ip) == ESP_OK) snprintf(address, sizeof(address), IPSTR, IP2STR(&ip.ip));
    cJSON_AddStringToObject(json, "ip", address); cJSON_AddBoolToObject(json, "connected", state.connected);
    return json;
}
static void serial_reply(const char *id, cJSON *data, const char *error)
{
    cJSON *frame = cJSON_CreateObject(); cJSON_AddStringToObject(frame, "id", id);
    cJSON_AddBoolToObject(frame, "ok", error == NULL);
    if (error) cJSON_AddStringToObject(frame, "error", error); else cJSON_AddItemToObject(frame, "data", data);
    char *text = cJSON_PrintUnformatted(frame);
    if (text) { flockfile(stdout); printf("\n" PREFIX "%s\n", text); fflush(stdout); funlockfile(stdout); free(text); }
    cJSON_Delete(frame);
}
static const char *submit_config(cJSON *json, unsigned *job)
{
    command_t *command = calloc(1, sizeof(*command)); if (!command) return "设备内存不足，请重试。";
    command->op = 2;
    xSemaphoreTake(lock, portMAX_DELAY); command->config = saved; bool running = busy; xSemaphoreGive(lock);
    if (running) { free(command); return "设备正在配置，请稍后重试。"; }
    device_config_t *cfg = &command->config;
    device_config_t previous = command->config;
    const char *validation = deskling_prepare_config(&previous, configured, json, cfg, &command->pair, command->hubs);
    memset(&previous, 0, sizeof(previous));
    if (validation) { memset(command, 0, sizeof(*command)); free(command); return validation; }
    xSemaphoreTake(lock, portMAX_DELAY);
    if (busy) { xSemaphoreGive(lock); memset(command, 0, sizeof(*command)); free(command); return "设备正在配置。"; }
    busy = true; command->job = ++job_number; *job = job_number; strcpy(candidate_ssid, cfg->ssid); strcpy(candidate_hub, cfg->hub); strcpy(candidate_hub_type, cfg->hub_type);
    // Publish the new job with its own stage; never expose the previous job's terminal result.
    strcpy(stage, "wifi"); snprintf(stage_detail, sizeof(stage_detail), "%s", cfg->ssid);
    error_text[0] = 0; pairing_code[0] = 0;
    xEventGroupClearBits(events, CANCEL_REQUESTED); xSemaphoreGive(lock);
    if (xQueueSend(commands, &command, 0) != pdTRUE) {
        xSemaphoreTake(lock, portMAX_DELAY); busy = false; xSemaphoreGive(lock);
        memset(command, 0, sizeof(*command)); free(command); return "设备忙，请重试。";
    }
    return NULL;
}
static void serial_task(void *arg)
{
    (void)arg; char line[2049]; size_t used = 0; bool overflow = false;
    for (;;) {
        char chunk[128]; int count = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(100));
        for (int i = 0; i < count; i++) {
            char ch = chunk[i];
            if (ch == '\n') {
                line[used] = 0;
                if (!overflow && !strncmp(line, PREFIX, strlen(PREFIX))) {
                    cJSON *json = cJSON_Parse(line + strlen(PREFIX));
                    char id[16] = "", op[16] = "";
                    if (copy_json(json, "id", id, sizeof(id), true) && copy_json(json, "op", op, sizeof(op), true)) {
                        if (!strcmp(op, "info")) serial_reply(id, status_json(), NULL);
                        else if (!strcmp(op, "perf")) {
                            bool reset = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "reset"));
                            deskling_ui_metrics_t ui = deskling_ui_metrics(reset); deskling_pet_metrics_t pet = deskling_pet_metrics(reset);
                            cJSON *result = cJSON_CreateObject();
                            cJSON_AddNumberToObject(result, "renderCount", ui.render_count); cJSON_AddNumberToObject(result, "renderTotalUs", (double)ui.render_total_us);
                            cJSON_AddNumberToObject(result, "renderMaxUs", ui.render_max_us); cJSON_AddNumberToObject(result, "tickCount", ui.tick_count);
                            cJSON_AddNumberToObject(result, "tickMaxGapMs", ui.tick_max_gap_ms); cJSON_AddNumberToObject(result, "view", ui.view);
                            cJSON_AddStringToObject(result, "provider", ui.provider); cJSON_AddStringToObject(result, "overall", ui.overall);
                            cJSON_AddNumberToObject(result, "decodedFrames", pet.decoded); cJSON_AddNumberToObject(result, "skippedFrames", pet.skipped);
                            cJSON_AddNumberToObject(result, "decodeTotalUs", (double)pet.total_us); cJSON_AddNumberToObject(result, "decodeMaxUs", pet.max_us);
                            // Internal RAM serves DMA and Wi-Fi; the largest block shows fragmentation.
                            cJSON_AddNumberToObject(result, "internalFree", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
                            cJSON_AddNumberToObject(result, "internalLargest", heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
                            cJSON_AddNumberToObject(result, "internalMinimum", heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
                            serial_reply(id, result, NULL);
                        }
                        else if (!strcmp(op, "configure")) {
                            unsigned job; const char *error = submit_config(json, &job);
                            cJSON *result = error ? NULL : cJSON_CreateObject(); if (result) cJSON_AddNumberToObject(result, "job", job);
                            serial_reply(id, result, error);
                        } else if (!strcmp(op, "cancel")) { xEventGroupSetBits(events, CANCEL_REQUESTED); serial_reply(id, cJSON_CreateObject(), NULL); }
                        else if (!strcmp(op, "scan")) {
                            command_t *command = calloc(1, sizeof(*command));
                            if (command) { command->op = 1; strcpy(command->id, id); }
                            if (!command || xQueueSend(commands, &command, 0) != pdTRUE) { free(command); serial_reply(id, NULL, "设备忙，请重试。"); }
                        } else if (!strcmp(op, "provider")) {
                            command_t *command = calloc(1, sizeof(*command));
                            xSemaphoreTake(lock, portMAX_DELAY); bool running = busy; xSemaphoreGive(lock);
                            bool valid = command && copy_json(json, "provider", command->config.provider, sizeof(command->config.provider), true) &&
                                (!strcmp(command->config.provider, "claude") || !strcmp(command->config.provider, "codex")) && !running;
                            if (valid) { command->op = 3; strcpy(command->id, id); }
                            if (!valid || xQueueSend(commands, &command, 0) != pdTRUE) { free(command); serial_reply(id, NULL, "设备忙或选择无效，请重试。"); }
                        } else serial_reply(id, NULL, "不支持的命令。");
                    }
                    cJSON_Delete(json);
                }
                memset(line, 0, sizeof(line)); used = 0; overflow = false;
            } else if (ch != '\r') { if (used < sizeof(line) - 1) line[used++] = ch; else overflow = true; }
        }
    }
}
static esp_err_t http_json(httpd_req_t *req, cJSON *json)
{
    char *text = cJSON_PrintUnformatted(json); cJSON_Delete(json);
    httpd_resp_set_type(req, "application/json; charset=utf-8"); httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = text ? httpd_resp_sendstr(req, text) : ESP_ERR_NO_MEM; free(text); return result;
}
static bool portal_origin(httpd_req_t *req)
{
    char origin[96], type[64];
    if (httpd_req_get_hdr_value_str(req, "Content-Type", type, sizeof(type)) != ESP_OK || strncmp(type, "application/json", 16)) return false;
    if (httpd_req_get_hdr_value_len(req, "Origin") && (httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) != ESP_OK || strcmp(origin, "http://192.168.4.1"))) return false;
    return true;
}
static esp_err_t portal_configure(httpd_req_t *req)
{
    if (!portal_origin(req) || req->content_len <= 0 || req->content_len > 2048) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid request");
    char *body = calloc(1, req->content_len + 1); if (!body) return ESP_ERR_NO_MEM;
    int received = 0;
    while (received < req->content_len) { int count = httpd_req_recv(req, body + received, req->content_len - received); if (count <= 0) { free(body); return ESP_FAIL; } received += count; }
    cJSON *json = cJSON_Parse(body); memset(body, 0, req->content_len); free(body);
    unsigned job; const char *error = submit_config(json, &job); cJSON_Delete(json);
    cJSON *result = cJSON_CreateObject();
    if (error) { httpd_resp_set_status(req, "400 Bad Request"); cJSON_AddStringToObject(result, "error", error); }
    else { httpd_resp_set_status(req, "202 Accepted"); cJSON_AddNumberToObject(result, "job", job); }
    return http_json(req, result);
}
static esp_err_t portal_status(httpd_req_t *req) { return http_json(req, status_json()); }
static esp_err_t portal_cancel(httpd_req_t *req) { if (!portal_origin(req)) return ESP_FAIL; xEventGroupSetBits(events, CANCEL_REQUESTED); return http_json(req, cJSON_CreateObject()); }
static cJSON *scan_networks(void)
{
    xSemaphoreTake(radio_lock, portMAX_DELAY);
    if (busy) { xSemaphoreGive(radio_lock); return NULL; }
    wifi_scan_config_t config = { .show_hidden = false, .scan_type = WIFI_SCAN_TYPE_ACTIVE };
    cJSON *result = cJSON_CreateObject(), *list = cJSON_AddArrayToObject(result, "networks");
    if (esp_wifi_scan_start(&config, true) != ESP_OK) { cJSON_Delete(result); xSemaphoreGive(radio_lock); return NULL; }
    uint16_t count = 32; wifi_ap_record_t *records = calloc(count, sizeof(*records));
    if (!records) { esp_wifi_clear_ap_list(); cJSON_Delete(result); xSemaphoreGive(radio_lock); return NULL; }
    esp_wifi_scan_get_ap_records(&count, records);
    for (int i = 0; i < count; i++) {
        bool duplicate = false;
        for (int j = 0; j < i; j++) if (!strcmp((char *)records[j].ssid, (char *)records[i].ssid)) duplicate = true;
        if (duplicate || !records[i].ssid[0]) continue;
        cJSON *row = cJSON_CreateObject(); cJSON_AddStringToObject(row, "ssid", (char *)records[i].ssid);
        cJSON_AddNumberToObject(row, "rssi", records[i].rssi); cJSON_AddBoolToObject(row, "secured", records[i].authmode != WIFI_AUTH_OPEN);
        cJSON_AddItemToArray(list, row);
    }
    free(records); xSemaphoreGive(radio_lock); return result;
}
static esp_err_t portal_scan(httpd_req_t *req)
{
    // Serialize scans with network configuration. A scan never interrupts an active connection attempt.
    xSemaphoreTake(lock, portMAX_DELAY); bool running = busy; xSemaphoreGive(lock);
    if (running) { httpd_resp_set_status(req, "409 Conflict"); return httpd_resp_sendstr(req, "{\"error\":\"配置进行中，请稍后扫描。\"}"); }
    cJSON *json = scan_networks(); if (!json) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Scan failed");
    return http_json(req, json);
}
extern const unsigned char portal_start[] asm("_binary_network_portal_html_start");
extern const unsigned char portal_end[] asm("_binary_network_portal_html_end");
extern const unsigned char font_start[] asm("_binary_setup_pixel_woff2_start");
extern const unsigned char font_end[] asm("_binary_setup_pixel_woff2_end");
static esp_err_t portal_get(httpd_req_t *req) { httpd_resp_set_type(req, "text/html; charset=utf-8"); httpd_resp_set_hdr(req, "Cache-Control", "no-store"); return httpd_resp_send(req, (char *)portal_start, portal_end - portal_start); }
static esp_err_t portal_font(httpd_req_t *req) { httpd_resp_set_type(req, "font/woff2"); return httpd_resp_send(req, (char *)font_start, font_end - font_start); }
static esp_err_t portal_redirect(httpd_req_t *req, httpd_err_code_t error) { (void)error; httpd_resp_set_status(req, "302 Found"); httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/"); return httpd_resp_sendstr(req, ""); }
static void dns_task(void *arg)
{
    (void)arg;
    // Created with xTaskCreateWithCaps, which must not delete itself; park on failure instead.
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = htonl(INADDR_ANY) };
    if (fd < 0 || bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        ESP_LOGE(TAG, "Captive DNS unavailable"); if (fd >= 0) close(fd);
        for (;;) vTaskDelay(portMAX_DELAY);
    }
    for (;;) {
        unsigned char packet[512]; struct sockaddr_in source; socklen_t length = sizeof(source);
        int count = recvfrom(fd, packet, sizeof(packet) - 16, 0, (struct sockaddr *)&source, &length);
        if (!ap_active || count < 17 || packet[2] & 0x80 || packet[4] || packet[5] != 1) continue;
        int end = 12;
        while (end < count && packet[end] && packet[end] <= 63) end += packet[end] + 1;
        if (end + 5 > count || packet[end] != 0 || packet[end + 1] || packet[end + 2] != 1 || packet[end + 3] || packet[end + 4] != 1) continue;
        end += 5; packet[2] = 0x81; packet[3] = 0x80; packet[6] = 0; packet[7] = 1; memset(packet + 8, 0, 4);
        const unsigned char answer[] = {0xc0,0x0c,0,1,0,1,0,0,0,30,0,4,192,168,4,1};
        memcpy(packet + end, answer, sizeof(answer)); sendto(fd, packet, end + sizeof(answer), 0, (struct sockaddr *)&source, length);
    }
}
static void open_portal(void)
{
    if (ap_active) { deskling_ui_setup(ap_name, ap_password); return; }
    uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(ap_name, sizeof(ap_name), "Deskling-%02X%02X", mac[4], mac[5]);
    snprintf(ap_password, sizeof(ap_password), "%08lX%04lX", (unsigned long)esp_random(), (unsigned long)(esp_random() & 0xffff));
    wifi_config_t ap = { .ap = { .max_connection = 4, .authmode = WIFI_AUTH_WPA2_PSK } };
    strcpy((char *)ap.ap.ssid, ap_name); ap.ap.ssid_len = strlen(ap_name); strcpy((char *)ap.ap.password, ap_password);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    httpd_config_t config = HTTPD_DEFAULT_CONFIG(); config.stack_size = 8192; config.max_uri_handlers = 8;
    // Handlers never write flash, so the server stack can live in PSRAM.
    config.task_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
    ESP_ERROR_CHECK(httpd_start(&portal_server, &config));
    const httpd_uri_t routes[] = {
        {.uri="/",.method=HTTP_GET,.handler=portal_get}, {.uri="/font.woff2",.method=HTTP_GET,.handler=portal_font},
        {.uri="/status",.method=HTTP_GET,.handler=portal_status}, {.uri="/scan",.method=HTTP_GET,.handler=portal_scan},
        {.uri="/configure",.method=HTTP_POST,.handler=portal_configure}, {.uri="/cancel",.method=HTTP_POST,.handler=portal_cancel}
    };
    for (size_t i = 0; i < sizeof(routes)/sizeof(routes[0]); i++) ESP_ERROR_CHECK(httpd_register_uri_handler(portal_server, &routes[i]));
    ESP_ERROR_CHECK(httpd_register_err_handler(portal_server, HTTPD_404_NOT_FOUND, portal_redirect));
    ap_active = true; deskling_ui_setup(ap_name, ap_password); ESP_LOGI(TAG, "Setup hotspot opened");
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) { xEventGroupSetBits(events, WIFI_CONNECTED); xEventGroupClearBits(events, WIFI_FAILED); }
    // Reconnection is scheduled by network_task (retry_wifi) so a missing AP does not scan nonstop.
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_reason = ((wifi_event_sta_disconnected_t *)data)->reason;
        xEventGroupClearBits(events, WIFI_CONNECTED); xEventGroupSetBits(events, WIFI_FAILED);
    }
}
static bool cancelled(void) { return xEventGroupGetBits(events) & CANCEL_REQUESTED; }
static bool connect_wifi(const device_config_t *config, unsigned seconds)
{
    xSemaphoreTake(radio_lock, portMAX_DELAY);
    esp_wifi_disconnect(); vTaskDelay(pdMS_TO_TICKS(150));
    xEventGroupClearBits(events, WIFI_CONNECTED | WIFI_FAILED); wifi_reason = 0;
    wifi_config_t station = {0}; strcpy((char *)station.sta.ssid, config->ssid); strcpy((char *)station.sta.password, config->password);
    if (esp_wifi_set_config(WIFI_IF_STA, &station) != ESP_OK || esp_wifi_connect() != ESP_OK) { xSemaphoreGive(radio_lock); return false; }
    int64_t deadline = esp_timer_get_time() + seconds * 1000000LL; unsigned retries = 0;
    while (esp_timer_get_time() < deadline && !cancelled()) {
        EventBits_t bits = xEventGroupWaitBits(events, WIFI_CONNECTED | WIFI_FAILED | CANCEL_REQUESTED, pdFALSE, pdFALSE, pdMS_TO_TICKS(250));
        if (bits & WIFI_CONNECTED) { xSemaphoreGive(radio_lock); return true; }
        if (bits & CANCEL_REQUESTED) { xSemaphoreGive(radio_lock); return false; }
        if (bits & WIFI_FAILED) {
            // A reconnect can miss one AP scan; retry within the original deadline.
            if (wifi_reason == WIFI_REASON_NO_AP_FOUND && retries++ < 2) {
                vTaskDelay(pdMS_TO_TICKS(500));
                if (cancelled()) break;
                xEventGroupClearBits(events, WIFI_FAILED); wifi_reason = 0;
                if (esp_wifi_connect() == ESP_OK) continue;
            }
            xSemaphoreGive(radio_lock); return false;
        }
    }
    xSemaphoreGive(radio_lock); return false;
}
static cJSON *http_request(const char *base, const char *suffix, const char *token, cJSON *post, int *status)
{
    // HTTPS keeps certificate checks enabled; allow SNTP to set the clock after joining Wi-Fi.
    if (!strncmp(base, "https://", 8)) {
        int64_t deadline = esp_timer_get_time() + 8LL * 1000000;
        while (time(NULL) < 1700000000 && esp_timer_get_time() < deadline && !cancelled()) vTaskDelay(pdMS_TO_TICKS(100));
    }
    char url[512], authorization[300]; snprintf(url, sizeof(url), "%s%s", base, suffix);
    esp_http_client_config_t config = { .url=url, .timeout_ms=4000, .crt_bundle_attach=esp_crt_bundle_attach, .disable_auto_redirect=true, .buffer_size=1024 };
    esp_http_client_handle_t http = esp_http_client_init(&config); if (!http) return NULL;
    if (token && *token) { snprintf(authorization, sizeof(authorization), "Bearer %s", token); esp_http_client_set_header(http, "Authorization", authorization); }
    char *body = post ? cJSON_PrintUnformatted(post) : NULL;
    if (body) { esp_http_client_set_method(http, HTTP_METHOD_POST); esp_http_client_set_header(http, "Content-Type", "application/json"); }
    cJSON *json = NULL; char *buffer = heap_caps_calloc(1, DESKLING_SNAPSHOT_MAX + 1, MALLOC_CAP_SPIRAM);
    if (buffer && esp_http_client_open(http, body ? strlen(body) : 0) == ESP_OK) {
        bool sent = !body || esp_http_client_write(http, body, strlen(body)) == (int)strlen(body);
        if (sent && esp_http_client_fetch_headers(http) >= 0) {
            *status = esp_http_client_get_status_code(http);
            int count = esp_http_client_read_response(http, buffer, DESKLING_SNAPSHOT_MAX);
            if (count >= 0 && count < DESKLING_SNAPSHOT_MAX) json = cJSON_ParseWithLength(buffer, count + 1);
        }
    }
    if (buffer) { memset(buffer, 0, DESKLING_SNAPSHOT_MAX + 1); free(buffer); }
    if (body) { memset(body, 0, strlen(body)); free(body); }
    esp_http_client_close(http); esp_http_client_cleanup(http); return json;
}
static int hub_response_status;
static bool verify_hub(device_config_t *config)
{
    char suffix[64]; snprintf(suffix, sizeof(suffix), "/snapshot?provider=%s", config->provider);
    int status = 0; cJSON *json = http_request(config->hub, suffix, config->token, NULL, &status);
    bool valid = status == 200 && cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(json, "v")) &&
        cJSON_IsString(cJSON_GetObjectItemCaseSensitive(json, "provider")) &&
        !strcmp(cJSON_GetObjectItemCaseSensitive(json, "provider")->valuestring, config->provider) && cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(json, "sessions"));
    hub_response_status = status;
    cJSON_Delete(json); return valid;
}
static bool discover_hub(device_config_t *config, bool pair)
{
    if (!deskling_can_discover(config)) return false;
    mdns_result_t *results = NULL; bool found = false;
    if (mdns_query_ptr("_deskling", "_tcp", 2500, 8, &results) == ESP_OK) for (mdns_result_t *r = results; r && !found; r = r->next) {
        const char *id = ""; bool compatible = false;
        for (size_t i = 0; i < r->txt_count; i++) {
            if (!strcmp(r->txt[i].key, "v") && r->txt[i].value && !strcmp(r->txt[i].value, "2")) compatible = true;
            if (!strcmp(r->txt[i].key, "id") && r->txt[i].value) id = r->txt[i].value;
        }
        if (!compatible || (!pair && config->hub_id[0] && strcmp(config->hub_id, id))) continue;
        for (mdns_ip_addr_t *a = r->addr; a && !found; a = a->next) if (a->addr.type == ESP_IPADDR_TYPE_V4) {
            device_config_t candidate = *config;
            snprintf(candidate.hub, sizeof(candidate.hub), "http://" IPSTR ":%u", IP2STR(&a->addr.u_addr.ip4), r->port);
            if (pair) {
                int status = 0; cJSON *json = http_request(candidate.hub, "/pair/info", NULL, NULL, &status);
                found = status == 200 && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "pairingOpen")); cJSON_Delete(json);
            } else found = verify_hub(&candidate);
            if (found) *config = candidate;
            memset(&candidate, 0, sizeof(candidate));
        }
    }
    mdns_query_results_free(results); return found;
}
static bool pair_hub(device_config_t *config, char *request_id, char *secret)
{
    cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "deviceId", device_id); cJSON_AddStringToObject(body, "name", "Deskling");
    int status = 0; cJSON *json = http_request(config->hub, "/pair/request", NULL, body, &status); cJSON_Delete(body);
    char code[8] = "";
    bool valid = status == 200 && copy_json(json, "id", request_id, 33, true) && copy_json(json, "secret", secret, 49, true) && copy_json(json, "code", code, sizeof(code), true) && copy_json(json, "hubId", config->hub_id, sizeof(config->hub_id), true);
    cJSON_Delete(json); if (!valid) return false;
    set_stage("pair", deskling_can_discover(config) ? "在本机 Hub 中核对配对码并确认" : "在远程 Hub 中核对配对码并确认", code);
    char suffix[80]; snprintf(suffix, sizeof(suffix), "/pair/status?id=%s", request_id);
    int64_t deadline = esp_timer_get_time() + 300LL * 1000000;
    while (esp_timer_get_time() < deadline && !cancelled()) {
        status = 0; json = http_request(config->hub, suffix, secret, NULL, &status);
        bool approved = status == 200 && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "approved")) && copy_json(json, "token", config->token, sizeof(config->token), true);
        cJSON_Delete(json); if (approved) return true; if (status == 404 || status == 400) return false;
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
    return false;
}
static const char *wait_pair_window(device_config_t *config)
{
    int64_t deadline = esp_timer_get_time() + 300LL * 1000000;
    bool waiting = false;
    while (esp_timer_get_time() < deadline && !cancelled()) {
        int status = 0;
        cJSON *json = http_request(config->hub, "/pair/info", NULL, NULL, &status);
        cJSON *open = cJSON_GetObjectItemCaseSensitive(json, "pairingOpen");
        bool valid = status == 200 && cJSON_IsBool(open) && copy_json(json, "hubId", config->hub_id, sizeof(config->hub_id), true);
        bool ready = valid && cJSON_IsTrue(open); cJSON_Delete(json);
        if (ready) return NULL;
        if (!valid) return "无法连接所选 Hub，请检查地址、端口或 HTTPS 证书。";
        if (!waiting) { set_stage("pair_wait", deskling_can_discover(config) ? "请在本机 Hub 中开启设备配对" : "请在远程 Hub 管理页开启设备配对", NULL); waiting = true; }
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
    return "等待配对已超时，请在所选 Hub 中重新开启配对。";
}
static void websocket_event(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    (void)arg; (void)base;
    esp_websocket_event_data_t *event = event_data;
    if (id == WEBSOCKET_EVENT_CONNECTED) {
        ESP_LOGI(TAG, "Connected to Hub");
        message("Connected. Waiting for snapshot");
    } else if (id == WEBSOCKET_EVENT_DISCONNECTED) {
        state.connected = false; receiving = false;
        message("Hub offline. Reconnecting...");
    } else if (id == WEBSOCKET_EVENT_ERROR) {
        state.connected = false;
        message("Hub connection failed. Check address and token.");
    } else if (id == WEBSOCKET_EVENT_DATA) {
        if (event->op_code == 1 && event->payload_offset == 0) { incoming_len = 0; receiving = true; }
        if (!receiving || (event->op_code != 1 && event->op_code != 0)) return;
        if (event->data_len < 0 || incoming_len + event->data_len > DESKLING_SNAPSHOT_MAX) {
            receiving = false; message("Hub snapshot exceeds device limit"); return;
        }
        memcpy(incoming + incoming_len, event->data_ptr, event->data_len);
        incoming_len += event->data_len;
        if (event->fin && event->payload_offset + event->data_len == event->payload_len) {
            incoming[incoming_len] = 0; receiving = false;
            bool first = !state.has_snapshot;
            if (deskling_parse_snapshot(incoming, incoming_len, &state)) {
                if (first) ESP_LOGI(TAG, "Snapshot: provider=%s state=%s sessions=%d", state.provider, state.overall, state.session_count);
                deskling_ui_publish(&state);
            }
            else message("Unsupported Hub snapshot");
        }
    }
}

static void start_websocket(void)
{
    if (!saved.hub[0] || !saved.token[0]) return;
    snprintf(ws_url, sizeof(ws_url), "%s%s/ws?provider=%s", !strncmp(saved.hub, "https://", 8) ? "wss://" : "ws://", strstr(saved.hub, "://") + 3, saved.provider);
    snprintf(auth_header, sizeof(auth_header), "Authorization: Bearer %s\r\n", saved.token);
    esp_websocket_client_config_t config = { .uri=ws_url, .headers=auth_header, .crt_bundle_attach=esp_crt_bundle_attach,
        .reconnect_timeout_ms=5000, .network_timeout_ms=10000, .buffer_size=2048, .task_stack=8192 };
    client = esp_websocket_client_init(&config); if (!client) { message("无法连接 Hub，请重试"); return; }
    ESP_ERROR_CHECK(esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, websocket_event, NULL));
    ESP_ERROR_CHECK(esp_websocket_client_start(client));
}
static bool activate_credential(const device_config_t *config)
{
    int status = 0; cJSON *body = cJSON_CreateObject();
    cJSON *json = http_request(config->hub, "/pair/activate", config->token, body, &status);
    cJSON_Delete(json); cJSON_Delete(body); return status == 200;
}
static void configure_device(command_t *command)
{
    device_config_t *config = &command->config; const char *error = NULL;
    bool same_wifi = configured && !strcmp(config->ssid, saved.ssid) && !strcmp(config->password, saved.password);
    stop_websocket(); state.connected = false; deskling_ui_publish(&state);
    set_stage("wifi", config->ssid, NULL);
    if (!(same_wifi && (xEventGroupGetBits(events) & WIFI_CONNECTED)) && !connect_wifi(config, 25)) {
        error = (wifi_reason == WIFI_REASON_AUTH_FAIL || wifi_reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || wifi_reason == WIFI_REASON_HANDSHAKE_TIMEOUT) ? "Wi-Fi 密码不正确，请修改后重试。" : wifi_reason == WIFI_REASON_NO_AP_FOUND ? "没有找到 Wi-Fi，请重新选择网络。" : "Wi-Fi 连接失败，请检查密码后重试。";
        goto failed;
    }
    set_stage("hub", deskling_can_discover(config) ? "连接本机 Hub 并验证凭证" : "连接远程 Hub 并验证凭证", NULL);
    size_t length = strlen(config->hub); if (length && config->hub[length - 1] == '/') config->hub[length - 1] = 0;
    bool found = false;
    if (config->hub[0]) found = command->pair || verify_hub(config);
    else if (!command->pair) for (int i = 0; i < 4 && !found && !cancelled(); i++) if (command->hubs[i][0]) {
        strcpy(config->hub, command->hubs[i]); found = verify_hub(config);
    }
    if (!found && !cancelled() && deskling_can_discover(config)) {
        config->hub[0] = 0;
        int64_t deadline = esp_timer_get_time() + 15LL * 1000000;
        while (!found && !cancelled() && esp_timer_get_time() < deadline) found = discover_hub(config, command->pair);
    }
    if (!found) { error = (hub_response_status == 401 || hub_response_status == 403) ? "Token 无效或已失效，请修改 Token 或重新配对。" : "无法连接所选 Hub，请检查地址、端口或 HTTPS 证书。"; goto failed; }
    if (command->pair) {
        error = wait_pair_window(config); if (error) goto failed;
        char request_id[33] = "", secret[49] = "";
        bool paired = pair_hub(config, request_id, secret); memset(secret, 0, sizeof(secret));
        if (!paired) { error = "配对未完成或已过期，请在 Hub 中重新开启配对。"; goto failed; }
    }
    if (cancelled()) goto failed;
    if (!verify_hub(config)) { error = (hub_response_status == 401 || hub_response_status == 403) ? "Token 无效或已失效，请修改 Token 或重新配对。" : "Hub 连接验证失败，请检查地址或重新配对。"; goto failed; }
    set_stage("save", "连接验证成功，正在保存", NULL);
    if (save_config(config) != ESP_OK) { error = "配置保存失败，原配置仍然保留。"; goto failed; }
    xSemaphoreTake(lock, portMAX_DELAY); saved = *config; configured = true; xSemaphoreGive(lock);
    // Activation can be retried; the new credential is already usable during its five-minute lease.
    credential_active = activate_credential(&saved);
    memset(&state, 0, sizeof(state)); strcpy(state.provider, saved.provider); strcpy(state.overall, "idle");
    xSemaphoreTake(lock, portMAX_DELAY); busy = false; xSemaphoreGive(lock);
    set_stage("done", "设备可以开始使用了", NULL); start_websocket(); return;
failed:
    bool cancel = cancelled();
    if (configured && saved.ssid[0]) {
        xEventGroupClearBits(events, CANCEL_REQUESTED);
        if (!same_wifi || !(xEventGroupGetBits(events) & WIFI_CONNECTED)) connect_wifi(&saved, 15);
        start_websocket();
    }
    else esp_wifi_disconnect();
    xSemaphoreTake(lock, portMAX_DELAY); busy = false; xSemaphoreGive(lock);
    set_stage(cancel ? "cancelled" : "error", cancel ? "已取消，原配置仍然保留" : error ? error : "连接已取消，请重试", NULL);
}
static bool change_provider(const char *provider)
{
    if (!strcmp(provider, saved.provider)) return true;
    device_config_t updated = saved; strcpy(updated.provider, provider);
    if (save_config(&updated) != ESP_OK) { message("选择保存失败，请重试"); return false; }
    stop_websocket(); xSemaphoreTake(lock, portMAX_DELAY); saved = updated; xSemaphoreGive(lock);
    memset(&state, 0, sizeof(state)); strcpy(state.provider, provider); strcpy(state.overall, "idle");
    message("正在连接所选 Agent"); if (configured) start_websocket();
    return true;
}
static void apply_provider_change(void)
{
    char provider[8]; if (xQueueReceive(provider_queue, provider, 0) == pdTRUE) change_provider(provider);
}
// Reconnects the saved network in the background, backing off while the access point is missing.
static void retry_wifi(void)
{
    EventBits_t bits = xEventGroupGetBits(events);
    if (bits & WIFI_CONNECTED) { reconnect_delay_ms = 1000; reconnect_at = 0; return; }
    int64_t now = esp_timer_get_time();
    if (!configured || busy || !(bits & WIFI_FAILED) || now < reconnect_at) return;
    if (xSemaphoreTake(radio_lock, 0) != pdTRUE) return; // a scan or configuration owns the radio
    if (!busy) {
        xEventGroupClearBits(events, WIFI_FAILED);
        // A rejected request produces no disconnect event, so keep the failure flag for the next try.
        if (esp_wifi_connect() != ESP_OK) xEventGroupSetBits(events, WIFI_FAILED);
        reconnect_at = now + reconnect_delay_ms * 1000LL;
        reconnect_delay_ms = reconnect_delay_ms >= 15000 ? 30000 : reconnect_delay_ms * 2;
    }
    xSemaphoreGive(radio_lock);
}
static void network_task(void *arg)
{
    (void)arg;
    ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default());
    sta_netif = esp_netif_create_default_wifi_sta(); esp_netif_create_default_wifi_ap();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    configured = load_config();
    uint8_t mac[6]; ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(device_id, sizeof(device_id), "%02x%02x%02x%02x%02x%02x", mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(mdns_init()); ESP_ERROR_CHECK(mdns_hostname_set("deskling-display"));
    setenv("TZ", "CST-8", 1); tzset(); esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org"); ESP_ERROR_CHECK(esp_netif_sntp_init(&sntp));
    usb_serial_jtag_driver_config_t usb = {.rx_buffer_size=4096,.tx_buffer_size=4096};
    if (!usb_serial_jtag_is_driver_installed()) ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
    usb_serial_jtag_vfs_use_driver();
    // Neither task writes flash, so their stacks can live in PSRAM.
    assert(xTaskCreateWithCaps(serial_task, "deskling-usb", 6144, NULL, 4, NULL, MALLOC_CAP_SPIRAM) == pdPASS);
    assert(xTaskCreateWithCaps(dns_task, "deskling-dns", 3072, NULL, 3, NULL, MALLOC_CAP_SPIRAM) == pdPASS);
    ESP_LOGI(TAG, "USB configuration protocol ready"); deskling_ui_publish(&state);
    xSemaphoreTake(lock, portMAX_DELAY); busy = true; xSemaphoreGive(lock);
    bool boot_recovery = false;
    if (configured && connect_wifi(&saved, 25)) {
        if (deskling_can_discover(&saved) && (!saved.hub[0] || !verify_hub(&saved))) { discover_hub(&saved, false); }
        if (saved.hub[0]) { credential_active = activate_credential(&saved); start_websocket(); } else open_portal();
    } else {
        open_portal(); boot_recovery = configured && saved.hub[0];
        // Let retry_wifi keep trying the saved network, starting after the first backoff step.
        if (configured) { xEventGroupSetBits(events, WIFI_FAILED); reconnect_at = esp_timer_get_time() + reconnect_delay_ms * 1000LL; }
    }
    xSemaphoreTake(lock, portMAX_DELAY); busy = false; xSemaphoreGive(lock);
    int64_t ap_deadline = ap_active ? esp_timer_get_time() + 600LL * 1000000 : 0;
    int64_t activation_at = 0;
    for (;;) {
        command_t *command = NULL;
        if (xQueueReceive(commands, &command, pdMS_TO_TICKS(250)) == pdTRUE) {
            if (command->op == 1) {
                cJSON *result = busy ? NULL : scan_networks();
                serial_reply(command->id, result, result ? NULL : "扫描失败，请稍后重试。");
            } else if (command->op == 2) { boot_recovery = false; configure_device(command); ap_deadline = ap_active ? esp_timer_get_time() + (!strcmp(stage, "done") ? 60LL : 600LL) * 1000000 : 0; }
            else if (command->op == 3) {
                bool changed = change_provider(command->config.provider);
                serial_reply(command->id, changed ? status_json() : NULL, changed ? NULL : "选择保存失败，请重试。");
            }
            memset(command, 0, sizeof(*command)); free(command);
        }
        if (xEventGroupGetBits(events) & SETUP_REQUESTED) {
            boot_recovery = false;
            xEventGroupClearBits(events, SETUP_REQUESTED); open_portal(); ap_deadline = esp_timer_get_time() + 600LL * 1000000;
        }
        retry_wifi();
        if (boot_recovery && (xEventGroupGetBits(events) & WIFI_CONNECTED) && !client) start_websocket();
        if (boot_recovery && state.connected && state.has_snapshot && !busy) {
            boot_recovery = false; set_stage("done", "设备可以开始使用了", NULL);
            ap_deadline = ap_active ? esp_timer_get_time() + 60LL * 1000000 : 0;
        }
        if (ap_active && !busy && ap_deadline && esp_timer_get_time() > ap_deadline) {
            httpd_stop(portal_server); portal_server = NULL; ap_active = false; esp_wifi_set_mode(WIFI_MODE_STA);
            if (!configured) set_stage("closed", "热点已关闭，点击网络设置可重新打开", NULL);
        }
        if (configured && !credential_active && saved.hub_id[0] && (xEventGroupGetBits(events) & WIFI_CONNECTED) && esp_timer_get_time() > activation_at) {
            activation_at = esp_timer_get_time() + 30LL * 1000000; credential_active = activate_credential(&saved);
        }
        apply_provider_change();
    }
}
void deskling_request_setup(void) { portal_pair_requested = false; if (events) xEventGroupSetBits(events, SETUP_REQUESTED); }
void deskling_request_pairing(void) { portal_pair_requested = true; if (events) xEventGroupSetBits(events, SETUP_REQUESTED); }
void deskling_network_start(void)
{
    strcpy(state.overall, "idle"); strcpy(state.provider, "claude");
    incoming = heap_caps_malloc(DESKLING_SNAPSHOT_MAX + 1, MALLOC_CAP_SPIRAM); assert(incoming);
    events = xEventGroupCreate(); commands = xQueueCreate(4, sizeof(command_t *)); provider_queue = xQueueCreate(1, 8); lock = xSemaphoreCreateMutex(); radio_lock = xSemaphoreCreateMutex();
    assert(events && commands && provider_queue && lock && radio_lock);
    assert(xTaskCreate(network_task, "deskling-network", 12288, NULL, 4, NULL) == pdPASS);
}
void deskling_select_provider(const char *provider)
{
    if (!provider_queue || (strcmp(provider, "claude") && strcmp(provider, "codex"))) return;
    char selected[8] = {0}; snprintf(selected, sizeof(selected), "%s", provider); xQueueOverwrite(provider_queue, selected);
}
