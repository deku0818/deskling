#include "deskling.h"
#include "pet.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "bsp/esp-bsp.h"
#include "lvgl.h"
#include "ui_icons.h"

LV_FONT_DECLARE(deskling_pixel_12);
LV_FONT_DECLARE(deskling_pixel_20);
LV_FONT_DECLARE(deskling_pixel_24);
LV_FONT_DECLARE(deskling_pixel_28);

// state_lock guards the small render metrics; data_lock (a mutex, so interrupts stay on)
// guards the ~3.6 KB snapshot hand-off and provisioning text between tasks.
static portMUX_TYPE state_lock = portMUX_INITIALIZER_UNLOCKED;
static SemaphoreHandle_t data_lock;
static deskling_state_t pending, current;
static bool dirty;
static bool provision_dirty;
static char provision_stage[16], provision_detail[128], provision_code[8];
static int64_t provision_done_at;
static char setup_ssid[33], setup_password[17], config_draft[8];
static lv_obj_t *clock_label, *dots, *status_label, *hero_icon, *hero, *note;
static lv_obj_t *quota[3], *bar[3], *columns[3], *dot_items[DESKLING_SESSION_MAX];
static lv_obj_t *overlay, *detail_body, *provider_marks[2], *quota_reset[3], *quota_intro;
static enum { HOME, SESSIONS, QUOTA, SETTINGS, SETUP, NETWORK } view;
static int touch_count;
static deskling_ui_metrics_t metrics;
static int64_t render_started;
static uint32_t last_tick;
deskling_ui_metrics_t deskling_ui_metrics(bool reset)
{
    xSemaphoreTake(data_lock, portMAX_DELAY);
    portENTER_CRITICAL(&state_lock);
    deskling_ui_metrics_t result = metrics; result.view = view;
    if (reset) { memset(&metrics, 0, sizeof(metrics)); last_tick = 0; }
    portEXIT_CRITICAL(&state_lock);
    snprintf(result.provider, sizeof(result.provider), "%s", current.provider);
    snprintf(result.overall, sizeof(result.overall), "%s", current.connected ? current.overall : "offline");
    xSemaphoreGive(data_lock); return result;
}
static void measure_render(lv_event_t *event)
{
    if (lv_event_get_code(event) == LV_EVENT_RENDER_START) render_started = esp_timer_get_time();
    else {
        uint32_t elapsed = (uint32_t)(esp_timer_get_time() - render_started);
        portENTER_CRITICAL(&state_lock);
        metrics.render_count++; metrics.render_total_us += elapsed;
        if (elapsed > metrics.render_max_us) metrics.render_max_us = elapsed;
        portEXIT_CRITICAL(&state_lock);
    }
}
static int64_t snapshot_at;
static const uint32_t paper = 0xf0e9dc, muted = 0x9a9185, accent = 0xee9a62;
static const uint32_t screen_color = 0x141413, line_color = 0x39342e;
static const char *quota_names[] = {"5H", "WEEK", "FABLE"};
// Match the web layout's corner clearance without scaling the pet artwork.
enum { SAFE_X = 36, SAFE_TOP = 32, CONTENT_W = 408, SAFE_BOTTOM = 448,
       DETAIL_Y = 92, QUOTA_Y = 130 };

static lv_obj_t *panel(lv_obj_t *parent, int x, int y, int w, int h)
{
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_size(obj, w, h);
    lv_obj_set_style_bg_color(obj, lv_color_hex(screen_color), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(obj, false);
    lv_obj_set_clickable(obj, false);
    return obj;
}

static lv_obj_t *label(lv_obj_t *parent, const char *text, int x, int y,
                       int width, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *obj = lv_label_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_width(obj, width);
    lv_obj_set_style_text_font(obj, font, 0);
    lv_obj_set_style_text_color(obj, lv_color_hex(color), 0);
    lv_label_set_text(obj, text);
    lv_obj_set_clickable(obj, false);
    return obj;
}

static lv_obj_t *rule(lv_obj_t *parent, int x, int y, int w, uint32_t color)
{
    lv_obj_t *obj = panel(parent, x, y, w, 1);
    lv_obj_set_style_bg_color(obj, lv_color_hex(color), 0);
    return obj;
}

static void border(lv_obj_t *obj, uint32_t color, uint32_t fill)
{
    lv_obj_set_style_border_width(obj, 1, 0);
    lv_obj_set_style_border_color(obj, lv_color_hex(color), 0);
    lv_obj_set_style_bg_color(obj, lv_color_hex(fill), 0);
    lv_obj_set_style_radius(obj, 0, 0);
}

static const lv_image_dsc_t *icon_source(const char *state)
{
    if (!strcmp(state, "working")) return &icon_working;
    if (!strcmp(state, "waiting")) return &icon_waiting;
    if (!strcmp(state, "done")) return &icon_done;
    if (!strcmp(state, "stopped")) return &icon_stopped;
    if (!strcmp(state, "offline")) return &icon_offline;
    if (!strcmp(state, "error") || !strcmp(state, "limited")) return &icon_error;
    if (!strcmp(state, "back")) return &icon_back;
    return &icon_idle;
}

static uint32_t state_color(const char *state)
{
    if (!strcmp(state, "waiting") || !strcmp(state, "error") || !strcmp(state, "limited")) return accent;
    if (!strcmp(state, "offline") || !strcmp(state, "stopped") || !strcmp(state, "idle")) return muted;
    return 0xc8bba6;
}

static lv_obj_t *icon(lv_obj_t *parent, const char *state, int x, int y, uint32_t color)
{
    lv_obj_t *obj = lv_image_create(parent);
    lv_image_set_src(obj, icon_source(state));
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_style_image_recolor(obj, lv_color_hex(color), 0);
    lv_obj_set_style_image_recolor_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_clickable(obj, false);
    return obj;
}

static void close_overlay(lv_event_t *e)
{
    (void)e;
    if (overlay) lv_obj_delete(overlay);
    overlay = detail_body = quota_intro = NULL;
    memset(quota_reset, 0, sizeof(quota_reset));
    view = HOME;
    deskling_pet_pause(false);
}

static lv_obj_t *open_overlay(const char *title)
{
    close_overlay(NULL);
    deskling_pet_pause(true);
    overlay = panel(lv_screen_active(), 0, 0, 480, 480);
    lv_obj_set_clickable(overlay, true); // Keep background touches inside the dialog.
    // Web .overlay padding:32px 36px, navigation height:44, gap:16.
    lv_obj_t *back = panel(overlay, SAFE_X, SAFE_TOP, 44, 44);
    border(back, 0x66503a, screen_color);
    lv_obj_set_style_radius(back, 12, 0);
    lv_obj_set_clickable(back, true);
    icon(back, "back", 9, 9, paper);
    lv_obj_add_event_cb(back, close_overlay, LV_EVENT_CLICKED, NULL);
    label(overlay, title, SAFE_X + 56, SAFE_TOP + 10, CONTENT_W - 56, &deskling_pixel_24, paper);
    return overlay;
}

static void render_sessions(void)
{
    int scroll = lv_obj_get_scroll_y(detail_body);
    lv_obj_clean(detail_body);
    int y = 0;
    for (int i = 0; i < current.session_count; i++) {
        const deskling_session_t *s = &current.sessions[i];
        lv_obj_t *row = panel(detail_body, 0, y, CONTENT_W, 72);
        icon(row, s->state, 0, 21, state_color(s->state));
        lv_obj_t *title = label(row, s->title, 36, 21, CONTENT_W - 36, &deskling_pixel_24,
                               !strcmp(s->state, "stopped") ? muted : paper);
        lv_obj_set_style_text_line_space(title, 6, 0);
        lv_obj_update_layout(title);
        int height = lv_obj_get_height(title) + 43;
        if (height < 72) height = 72;
        lv_obj_set_height(row, height);
        rule(row, 0, height - 1, CONTENT_W, line_color);
        if (s->stale) lv_obj_set_style_opa(row, 115, 0);
        y += height;
    }
    if (!current.session_count) {
        lv_obj_t *empty = label(detail_body, "暂无会话", 15, 70, CONTENT_W - 30, &deskling_pixel_12, muted);
        lv_obj_set_style_text_align(empty, LV_TEXT_ALIGN_CENTER, 0);
    }
    lv_obj_update_layout(detail_body);
    lv_obj_scroll_to_y(detail_body, scroll, LV_ANIM_OFF);
}

static void show_sessions(lv_event_t *e)
{
    (void)e; touch_count++;
    ESP_LOGI("deskling-ui", "Touch: sessions");
    open_overlay("会话"); view = SESSIONS;
    detail_body = panel(overlay, SAFE_X, DETAIL_Y, CONTENT_W, SAFE_BOTTOM - DETAIL_Y);
    lv_obj_set_clickable(detail_body, true);
    lv_obj_set_scrollable(detail_body, true);
    lv_obj_set_scroll_dir(detail_body, LV_DIR_VER);
    lv_obj_set_style_bg_color(detail_body, lv_color_hex(0x665039), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(detail_body, LV_OPA_50, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(detail_body, 2, LV_PART_SCROLLBAR);
    render_sessions();
}

static void reset_text(const deskling_quota_t *q, char *text, size_t size)
{
    if (!q->present) { text[0] = 0; return; }
    if (!q->reset_at) { snprintf(text, size, "重置时间未知"); return; }
    int64_t seconds = q->reset_at - (int64_t)time(NULL);
    if (seconds <= 0) { snprintf(text, size, "已到重置时间，等待刷新"); return; }
    int64_t d = seconds / 86400, h = seconds / 3600 % 24, m = seconds / 60 % 60;
    if (d) snprintf(text, size, "%lldd %lldh 后重置", (long long)d, (long long)h);
    else if (h) snprintf(text, size, "%lldh %lldm 后重置", (long long)h, (long long)m);
    else snprintf(text, size, "%lldm 后重置", (long long)(m > 0 ? m : 1));
}

static void quota_intro_text(void)
{
    if (!quota_intro) return;
    char text[80], clock[16];
    time_t updated = snapshot_at;
    struct tm local; localtime_r(&updated, &local);
    strftime(clock, sizeof(clock), "%H:%M", &local);
    if (snapshot_at) snprintf(text, sizeof(text), "%s · 更新于 %s", current.connected ? "实时数据" : "上次同步数据", clock);
    else snprintf(text, sizeof(text), "%s", current.connected ? "实时数据" : "上次同步数据");
    lv_label_set_text(quota_intro, text);
}

static void render_quota(void)
{
    lv_obj_clean(detail_body);
    memset(quota_reset, 0, sizeof(quota_reset));
    const char *names[] = {"5h 窗口 · 剩余", "周额度 · 剩余", "Fable · 剩余"};
    int count = !strcmp(current.provider, "codex") ? 2 : 3;
    for (int i = 0; i < count; i++) {
        const deskling_quota_t *q = &current.quota[i];
        bool low = q->present && q->left <= 15;
        lv_obj_t *card = panel(detail_body, 0, i * 106, CONTENT_W, 98);
        border(card, line_color, 0x201e1a);
        label(card, names[i], 15, 21, 250, &deskling_pixel_12, muted);
        char text[96];
        if (q->present) snprintf(text, sizeof(text), "%.0f%%", q->left);
        else snprintf(text, sizeof(text), "--");
        lv_obj_t *value = label(card, text, CONTENT_W - 140, 12, 124, &deskling_pixel_28, low ? accent : paper);
        lv_obj_set_style_text_align(value, LV_TEXT_ALIGN_RIGHT, 0);
        int filled = q->present ? (int)(q->left / 5 + 0.5) : 0;
        for (int j = 0; j < 20; j++) {
            int start = j * (CONTENT_W - 26) / 20, end = (j + 1) * (CONTENT_W - 26) / 20 - 4;
            lv_obj_t *segment = panel(card, 14 + start, 50, end - start, 8);
            lv_obj_set_style_bg_color(segment, lv_color_hex(j < filled ? (low ? accent : 0xc6b79e) : 0x34302a), 0);
        }
        if (q->present) snprintf(text, sizeof(text), "已用 %.0f%%", 100 - q->left);
        else snprintf(text, sizeof(text), "暂无数据");
        label(card, text, 15, 70, 100, &deskling_pixel_12, muted);
        reset_text(q, text, sizeof(text));
        quota_reset[i] = label(card, text, 118, 70, CONTENT_W - 134, &deskling_pixel_12, muted);
        lv_obj_set_style_text_align(quota_reset[i], LV_TEXT_ALIGN_RIGHT, 0);
    }
    quota_intro_text();
}

static void show_quota(lv_event_t *e)
{
    (void)e; touch_count++;
    ESP_LOGI("deskling-ui", "Touch: quota");
    open_overlay("额度"); view = QUOTA;
    quota_intro = label(overlay, "", SAFE_X, DETAIL_Y, CONTENT_W, &deskling_pixel_12, muted);
    detail_body = panel(overlay, SAFE_X, QUOTA_Y, CONTENT_W, SAFE_BOTTOM - QUOTA_Y);
    render_quota();
}

static void request_setup(lv_event_t *e)
{
    (void)e;
    deskling_request_setup();
}
static void request_pairing(lv_event_t *e) { (void)e; deskling_request_pairing(); }

static void show_network(lv_event_t *e)
{
    (void)e;
    open_overlay("网络设置"); view = NETWORK;
    const char *names[] = {"Wi-Fi", "Hub"};
    const char *details[] = {"连接电脑或扫码修改网络", "在 Hub 中重新配对设备"};
    for (int i = 0; i < 2; i++) {
        lv_obj_t *row = panel(overlay, SAFE_X, DETAIL_Y + i * 88, CONTENT_W, 88);
        lv_obj_set_clickable(row, true);
        icon(row, i ? "done" : "idle", 0, 21, muted);
        label(row, names[i], 36, 16, CONTENT_W - 36, &deskling_pixel_24, paper);
        label(row, details[i], 36, 50, CONTENT_W - 36, &deskling_pixel_12, muted);
        rule(row, 0, 87, CONTENT_W, line_color);
        lv_obj_add_event_cb(row, i ? request_pairing : request_setup, LV_EVENT_CLICKED, NULL);
    }
    label(overlay, "原配置会保留到新连接验证成功", SAFE_X, 328, CONTENT_W, &deskling_pixel_12, muted);
}

static void choose_provider(lv_event_t *e)
{
    const char *provider = lv_event_get_user_data(e);
    snprintf(config_draft, sizeof(config_draft), "%s", provider);
    for (int i = 0; i < 2; i++) lv_obj_set_hidden(provider_marks[i], strcmp(config_draft, i ? "codex" : "claude") != 0);
}

static void save_settings(lv_event_t *e)
{
    (void)e;
    deskling_select_provider(config_draft);
    close_overlay(NULL);
}

static void show_settings(lv_event_t *e)
{
    (void)e; touch_count++;
    ESP_LOGI("deskling-ui", "Touch: settings");
    open_overlay("配置"); view = SETTINGS;
    snprintf(config_draft, sizeof(config_draft), "%s", current.provider[0] ? current.provider : "claude");
    const char *names[] = {"Claude Code", "Codex"};
    const char *providers[] = {"claude", "codex"};
    for (int i = 0; i < 2; i++) {
        lv_obj_t *row = panel(overlay, SAFE_X, DETAIL_Y + i * 72, CONTENT_W, 72);
        lv_obj_set_clickable(row, true);
        provider_marks[i] = icon(row, "done", 0, 21, 0xc8bba6);
        lv_obj_set_hidden(provider_marks[i], strcmp(config_draft, providers[i]) != 0);
        label(row, names[i], 36, 21, CONTENT_W - 36, &deskling_pixel_24, paper);
        rule(row, 0, 71, CONTENT_W, line_color);
        lv_obj_add_event_cb(row, choose_provider, LV_EVENT_CLICKED, (void *)providers[i]);
    }
    lv_obj_t *save = panel(overlay, SAFE_X, SAFE_BOTTOM - 44, CONTENT_W, 44);
    border(save, 0x795337, 0x2b211a);
    lv_obj_set_style_radius(save, 14, 0);
    lv_obj_set_clickable(save, true);
    lv_obj_t *text = label(save, "保存", 0, 16, CONTENT_W, &deskling_pixel_12, accent);
    lv_obj_set_style_text_align(text, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_add_event_cb(save, save_settings, LV_EVENT_CLICKED, NULL);
    // The hardware-only network entry shares the same flat row style.
    lv_obj_t *network = panel(overlay, SAFE_X, 308, CONTENT_W, 60);
    lv_obj_set_clickable(network, true);
    label(network, "网络设置", 0, 8, CONTENT_W, &deskling_pixel_24, paper);
    label(network, "Wi-Fi / Hub", 0, 38, CONTENT_W, &deskling_pixel_12, muted);
    rule(network, 0, 59, CONTENT_W, line_color);
    lv_obj_add_event_cb(network, show_network, LV_EVENT_CLICKED, NULL);
}

void deskling_ui_publish(const deskling_state_t *state)
{
    xSemaphoreTake(data_lock, portMAX_DELAY);
    pending = *state; dirty = true;
    xSemaphoreGive(data_lock);
}

void deskling_ui_setup(const char *ssid, const char *password)
{
    xSemaphoreTake(data_lock, portMAX_DELAY);
    snprintf(setup_ssid, sizeof(setup_ssid), "%s", ssid);
    snprintf(setup_password, sizeof(setup_password), "%s", password);
    dirty = true;
    xSemaphoreGive(data_lock);
}

void deskling_ui_provision(const char *stage, const char *detail, const char *code)
{
    xSemaphoreTake(data_lock, portMAX_DELAY);
    snprintf(provision_stage, sizeof(provision_stage), "%s", stage);
    snprintf(provision_detail, sizeof(provision_detail), "%s", detail);
    snprintf(provision_code, sizeof(provision_code), "%s", code);
    provision_dirty = true;
    xSemaphoreGive(data_lock);
}

static void render_dots(void)
{
    lv_obj_clean(dots); memset(dot_items, 0, sizeof(dot_items));
    int count = current.session_count;
    int width = count ? count * 21 - 3 : 18;
    if (width > 150) width = 150;
    lv_obj_set_pos(dots, SAFE_X + CONTENT_W - width - 12, SAFE_TOP);
    lv_obj_set_size(dots, width + 12, 44);
    if (!count) {
        lv_obj_t *empty = panel(dots, 12, 12, 18, 10);
        lv_obj_set_style_border_color(empty, lv_color_hex(muted), 0);
        lv_obj_set_style_border_width(empty, 1, 0);
    }
    for (int i = 0; i < count; i++) {
        const deskling_session_t *s = &current.sessions[i];
        int start = i * (width + 3) / count, end = (i + 1) * (width + 3) / count - 3;
        lv_obj_t *dot = panel(dots, 12 + start, 12, end - start, 10); dot_items[i] = dot;
        bool hollow = !strcmp(s->state, "done") || !strcmp(s->state, "idle");
        uint32_t color = !strcmp(s->state, "stopped") ? 0x625b51 : state_color(s->state);
        if (!strcmp(s->state, "working")) color = paper;
        lv_obj_set_style_bg_color(dot, lv_color_hex(color), 0);
        if (hollow) {
            lv_obj_set_style_bg_opa(dot, LV_OPA_TRANSP, 0);
            lv_obj_set_style_border_width(dot, !strcmp(s->state, "done") ? 2 : 1, 0);
            lv_obj_set_style_border_color(dot, lv_color_hex(paper), 0);
        }
    }
}

static void blink_dots(void)
{
    for (int i = 0; i < current.session_count; i++) {
        if (!dot_items[i]) continue;
        const deskling_session_t *s = &current.sessions[i];
        lv_opa_t opacity = s->stale ? 115 : LV_OPA_COVER;
        if (!s->stale && !strcmp(s->state, "working") && lv_tick_get() % 1200 >= 600) opacity = 64;
        if (!s->stale && !strcmp(s->state, "waiting") && lv_tick_get() % 1400 >= 700) opacity = 102;
        if (lv_obj_get_style_opa(dot_items[i], 0) != opacity) lv_obj_set_style_opa(dot_items[i], opacity, 0);
    }
}

static void render_home(void)
{
    render_dots();
    const char *state = current.connected ? current.overall : "offline";
    deskling_pet_state(state);
    char text[96]; size_t n = strlen(state);
    for (size_t i = 0; i <= n; i++) text[i] = state[i] >= 'a' && state[i] <= 'z' ? state[i] - 32 : state[i];
    lv_label_set_text(status_label, text);
    uint32_t color = state_color(state);
    if (!strcmp(state, "working") || !strcmp(state, "done")) color = paper;
    lv_obj_set_style_text_color(status_label, lv_color_hex(color), 0);
    lv_image_set_src(hero_icon, icon_source(state));
    lv_obj_set_style_image_recolor(hero_icon, lv_color_hex(color), 0);
    lv_obj_update_layout(status_label);
    int word_width = lv_obj_get_width(status_label);
    lv_obj_set_width(hero, word_width + 34);
    lv_obj_set_x(hero, (480 - word_width - 34) / 2);
    lv_obj_set_hidden(note, current.has_snapshot);
    lv_label_set_text(note, current.message);
    bool is_codex = !strcmp(current.provider, "codex");
    lv_obj_set_hidden(columns[2], is_codex);
    for (int i = 0; i < (is_codex ? 2 : 3); i++) {
        int count = is_codex ? 2 : 3;
        int available = CONTENT_W - (count - 1) * 20;
        int start = i * available / count, end = (i + 1) * available / count;
        int width = end - start, x = SAFE_X + start + i * 20;
        lv_obj_set_pos(columns[i], x, 391); lv_obj_set_width(columns[i], width);
        if (i) { lv_obj_set_style_border_width(columns[i], 1, 0); lv_obj_set_style_border_side(columns[i], LV_BORDER_SIDE_LEFT, 0); lv_obj_set_style_border_color(columns[i], lv_color_hex(line_color), 0); }
        int inset = i ? 16 : 0;
        lv_obj_set_x(lv_obj_get_child(columns[i], 0), inset);
        lv_obj_set_width(lv_obj_get_child(columns[i], 0), width - inset);
        lv_obj_set_x(quota[i], inset);
        lv_obj_set_width(quota[i], width - inset);
        lv_obj_set_pos(bar[i], inset, 46);
        lv_obj_set_width(bar[i], width - inset);
        const deskling_quota_t *q = &current.quota[i];
        bool low = q->present && q->left <= 15;
        if (q->present) snprintf(text, sizeof(text), "%.0f%%", q->left); else snprintf(text, sizeof(text), "--");
        lv_label_set_text(quota[i], text);
        lv_obj_set_style_text_color(quota[i], lv_color_hex(low ? accent : paper), 0);
        lv_obj_set_style_bg_color(bar[i], lv_color_hex(low ? accent : paper), LV_PART_INDICATOR);
        lv_bar_set_value(bar[i], q->present ? (int)q->left : 0, LV_ANIM_OFF);
        lv_obj_set_style_opa(bar[i], current.connected ? LV_OPA_COVER : 115, 0);
    }
}

static char active_setup_ssid[33], active_setup_password[17];
static void phone_setup(lv_event_t *e)
{
    (void)e; open_overlay("手机配网"); view = SETUP;
    lv_obj_t *qr = lv_qrcode_create(overlay);
    lv_qrcode_set_size(qr, 192); lv_obj_set_pos(qr, 144, DETAIL_Y);
    lv_qrcode_set_dark_color(qr, lv_color_hex(screen_color)); lv_qrcode_set_light_color(qr, lv_color_hex(paper));
    char text[128]; snprintf(text, sizeof(text), "WIFI:T:WPA;S:%s;P:%s;;", active_setup_ssid, active_setup_password);
    lv_qrcode_update(qr, text, strlen(text));
    lv_obj_t *heading = label(overlay, "扫码连接 Wi-Fi", SAFE_X, 300, CONTENT_W, &deskling_pixel_24, paper);
    lv_obj_set_style_text_align(heading, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_t *name = label(overlay, active_setup_ssid, SAFE_X, 340, CONTENT_W, &deskling_pixel_12, muted);
    lv_obj_set_style_text_align(name, LV_TEXT_ALIGN_CENTER, 0);
    label(overlay, "连接后打开: http://192.168.4.1", SAFE_X, 388, CONTENT_W, &deskling_pixel_12, muted);
    label(overlay, "热点将在 10 分钟后关闭", SAFE_X, 430, CONTENT_W, &deskling_pixel_12, muted);
}

static void show_setup(const char *ssid, const char *password)
{
    snprintf(active_setup_ssid, sizeof(active_setup_ssid), "%s", ssid);
    snprintf(active_setup_password, sizeof(active_setup_password), "%s", password);
    open_overlay("连接 Deskling"); view = SETUP;
    label(overlay, "用 USB 连接电脑", SAFE_X, 152, CONTENT_W, &deskling_pixel_24, paper);
    label(overlay, "在 Hub 中点击添加设备", SAFE_X, 202, CONTENT_W, &deskling_pixel_12, muted);
    lv_obj_t *button = panel(overlay, SAFE_X, 352, CONTENT_W, 52); border(button, 0x795337, 0x2b211a); lv_obj_set_style_radius(button, 14, 0); lv_obj_set_clickable(button, true);
    lv_obj_t *text = label(button, "用手机配置", 0, 20, CONTENT_W, &deskling_pixel_12, accent); lv_obj_set_style_text_align(text, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_add_event_cb(button, phone_setup, LV_EVENT_CLICKED, NULL);
}

static void show_provision(const char *stage, const char *detail, const char *code)
{
    const char *title = !strcmp(stage, "wifi") ? "连接 Wi-Fi" : !strcmp(stage, "hub") ? "连接 Hub" : !strcmp(stage, "pair_wait") ? "等待配对" : !strcmp(stage, "pair") ? "确认配对" : !strcmp(stage, "save") ? "保存配置" : !strcmp(stage, "done") ? "已连接" : !strcmp(stage, "closed") ? "热点已关闭" : !strcmp(stage, "cancelled") ? "已取消" : "连接未完成";
    open_overlay("连接 Deskling"); view = SETUP;
    icon(overlay, !strcmp(stage, "done") ? "done" : !strcmp(stage, "error") ? "error" : "working", 228, 130, accent);
    lv_obj_t *heading = label(overlay, code[0] ? code : title, SAFE_X, 184, CONTENT_W, &deskling_pixel_24, paper);
    lv_obj_set_style_text_align(heading, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_t *description = label(overlay, detail, SAFE_X, 236, CONTENT_W, &deskling_pixel_12, muted);
    lv_obj_set_style_text_align(description, LV_TEXT_ALIGN_CENTER, 0); lv_obj_set_style_text_line_space(description, 8, 0);
    if (!strcmp(stage, "done")) provision_done_at = (int64_t)lv_tick_get() + 2000;
    else provision_done_at = 0;
    if (!strcmp(stage, "error") || !strcmp(stage, "closed") || !strcmp(stage, "cancelled")) {
        lv_obj_t *button = panel(overlay, SAFE_X, 352, CONTENT_W, 52); border(button, 0x795337, 0x2b211a); lv_obj_set_style_radius(button, 14, 0); lv_obj_set_clickable(button, true);
        lv_obj_t *text = label(button, "重新配置", 0, 20, CONTENT_W, &deskling_pixel_12, accent); lv_obj_set_style_text_align(text, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_add_event_cb(button, request_setup, LV_EVENT_CLICKED, NULL);
    }
}

static void refresh(lv_timer_t *timer)
{
    (void)timer;
    uint32_t tick = lv_tick_get();
    portENTER_CRITICAL(&state_lock);
    if (last_tick && tick - last_tick > metrics.tick_max_gap_ms) metrics.tick_max_gap_ms = tick - last_tick;
    last_tick = tick; metrics.tick_count++;
    portEXIT_CRITICAL(&state_lock);
    time_t now = time(NULL); struct tm local; localtime_r(&now, &local);
    char text[96];
    if (now > 1700000000) strftime(text, sizeof(text), "%H:%M", &local); else snprintf(text, sizeof(text), "--:--");
    if (strcmp(lv_label_get_text(clock_label), text)) lv_label_set_text(clock_label, text);
    blink_dots();
    char ssid[33] = {0}, password[17] = {0}, network_stage[16], network_detail[128], network_code[8];
    xSemaphoreTake(data_lock, portMAX_DELAY);
    bool changed = dirty;
    bool network_changed = provision_dirty;
    if (network_changed) {
        snprintf(network_stage, sizeof(network_stage), "%s", provision_stage);
        snprintf(network_detail, sizeof(network_detail), "%s", provision_detail);
        snprintf(network_code, sizeof(network_code), "%s", provision_code);
        provision_dirty = false;
    }
    bool sessions_changed = false, home_changed = false, quota_changed = false;
    if (changed) {
        sessions_changed = current.session_count != pending.session_count || memcmp(current.sessions, pending.sessions, sizeof(current.sessions));
        // The quota cards depend on the values, the provider (two or three cards) and connection state.
        quota_changed = memcmp(current.quota, pending.quota, sizeof(current.quota)) ||
            strcmp(current.provider, pending.provider) || current.connected != pending.connected;
        home_changed = sessions_changed || quota_changed || current.has_snapshot != pending.has_snapshot ||
            strcmp(current.overall, pending.overall) || strcmp(current.message, pending.message);
        current = pending; dirty = false;
        snprintf(ssid, sizeof(ssid), "%s", setup_ssid); snprintf(password, sizeof(password), "%s", setup_password);
        setup_ssid[0] = 0;
    }
    xSemaphoreGive(data_lock);
    if (network_changed) show_provision(network_stage, network_detail, network_code);
    if (provision_done_at && (int64_t)lv_tick_get() > provision_done_at) { provision_done_at = 0; if (view == SETUP) close_overlay(NULL); }
    if (changed) {
        if (current.has_snapshot && current.connected) snapshot_at = current.updated_at ? current.updated_at : now;
        if (home_changed) render_home();
        if (view == SESSIONS && sessions_changed) render_sessions();
        // Rebuilding the cards creates ~70 objects; otherwise only the "updated at" line moves.
        if (view == QUOTA) { if (quota_changed) render_quota(); else quota_intro_text(); }
        if (ssid[0]) show_setup(ssid, password);
    }
    if (view == QUOTA) {
        for (int i = 0; i < 3; i++) if (quota_reset[i]) {
            reset_text(&current.quota[i], text, sizeof(text));
            if (strcmp(lv_label_get_text(quota_reset[i]), text)) lv_label_set_text(quota_reset[i], text);
        }
    }
}

void deskling_ui_start(void)
{
    data_lock = xSemaphoreCreateMutex(); assert(data_lock);
    bsp_display_lock(-1);
    lv_display_add_event_cb(lv_display_get_default(), measure_render, LV_EVENT_RENDER_START, NULL);
    lv_display_add_event_cb(lv_display_get_default(), measure_render, LV_EVENT_RENDER_READY, NULL);
    // Validate both glyph lookup and decompression on the target.
    const uint32_t glyphs[] = {0x8bbe, 0x5907, 0x8fde, 0x63a5, 0x989d, 0x5ea6, 0x7f16, 0x7801, 0x5f55, 0x4e02};
    for (size_t i = 0; i < sizeof(glyphs) / sizeof(glyphs[0]); i++) {
        lv_font_glyph_dsc_t dsc = {0};
        assert(lv_font_get_glyph_dsc(&deskling_pixel_24, &dsc, glyphs[i], 0));
        assert(!dsc.is_placeholder);
        lv_draw_buf_t *bitmap = lv_draw_buf_create(dsc.box_w, dsc.box_h, LV_COLOR_FORMAT_A8, 0);
        assert(bitmap && lv_font_get_glyph_bitmap(&dsc, bitmap));
        lv_font_glyph_release_draw_data(&dsc); lv_draw_buf_destroy(bitmap);
    }
    ESP_LOGI("deskling-ui", "Pixel CJK glyph and bitmap checks passed");
    lv_obj_t *root = lv_screen_active();
    lv_obj_set_style_bg_color(root, lv_color_hex(screen_color), 0);
    lv_obj_set_scrollable(root, false);
    clock_label = label(root, "--:--", SAFE_X, SAFE_TOP, 96, &deskling_pixel_20, muted);
    lv_obj_set_style_text_letter_space(clock_label, 2, 0);
    lv_obj_set_clickable(clock_label, true);
    lv_obj_set_height(clock_label, 44);
    lv_obj_set_style_pad_top(clock_label, 12, 0);
    lv_obj_add_event_cb(clock_label, show_settings, LV_EVENT_CLICKED, NULL);
    dots = panel(root, SAFE_X + CONTENT_W - 30, SAFE_TOP, 30, 44);
    lv_obj_set_clickable(dots, true);
    lv_obj_add_event_cb(dots, show_sessions, LV_EVENT_CLICKED, NULL);
    lv_obj_t *companion = panel(root, 20, 92, 440, 238);
    deskling_pet_start(companion);
    lv_obj_set_clickable(companion, true);
    lv_obj_add_event_cb(companion, show_sessions, LV_EVENT_CLICKED, NULL);
    hero = panel(root, 140, 344, 200, 24);
    hero_icon = icon(hero, "idle", 0, 0, muted);
    lv_image_set_scale(hero_icon, 213); // 20/24, matching the web hero icon.
    lv_image_set_pivot(hero_icon, 0, 0);
    status_label = label(hero, "STARTING", 30, 0, LV_SIZE_CONTENT, &deskling_pixel_20, paper);
    lv_obj_set_style_text_letter_space(status_label, 4, 0);
    note = label(root, "Initializing Wi-Fi", 20, 368, 440, &deskling_pixel_12, muted);
    lv_obj_set_style_text_align(note, LV_TEXT_ALIGN_CENTER, 0);
    rule(root, SAFE_X, 378, CONTENT_W, line_color);
    for (int i = 0; i < 3; i++) {
        int start = i * (CONTENT_W - 40) / 3, end = (i + 1) * (CONTENT_W - 40) / 3;
        columns[i] = panel(root, SAFE_X + start + i * 20, 391, end - start, 69);
        lv_obj_set_clickable(columns[i], true);
        lv_obj_add_event_cb(columns[i], show_quota, LV_EVENT_CLICKED, NULL);
        label(columns[i], quota_names[i], 0, 0, 100, &deskling_pixel_12, muted);
        quota[i] = label(columns[i], "--", 0, 17, 110, &deskling_pixel_24, paper);
        bar[i] = lv_bar_create(columns[i]);
        lv_obj_remove_style_all(bar[i]); lv_obj_set_pos(bar[i], 0, 46); lv_obj_set_size(bar[i], end - start, 4);
        lv_obj_set_style_bg_opa(bar[i], LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_bg_color(bar[i], lv_color_hex(line_color), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(bar[i], LV_OPA_COVER, LV_PART_INDICATOR);
        lv_obj_set_style_bg_color(bar[i], lv_color_hex(paper), LV_PART_INDICATOR);
        lv_obj_set_clickable(bar[i], false);
    }
    lv_timer_create(refresh, 100, NULL);
    bsp_display_unlock();
}
