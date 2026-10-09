// Runs the production UI and pet code against an in-memory LVGL display.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "../../main/ui.c"
static unsigned char framebuffer[480*480*3];
static char selected[8];
void deskling_select_provider(const char *provider) { snprintf(selected, sizeof(selected), "%s", provider); }
void deskling_request_setup(void) {}
void deskling_request_pairing(void) {}
static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{
    int w = area->x2 - area->x1 + 1;
    int stride = lv_draw_buf_width_to_stride(w, LV_COLOR_FORMAT_RGB888);
    for (int y = area->y1; y <= area->y2; y++)
        memcpy(framebuffer + (y*480+area->x1)*3, pixels + (y-area->y1)*stride, w*3);
    lv_display_flush_ready(display);
}
static void screenshot(const char *directory, const char *name)
{
    lv_obj_invalidate(lv_screen_active()); lv_refr_now(NULL);
    char path[1024]; snprintf(path, sizeof(path), "%s/%s.ppm", directory, name);
    FILE *f = fopen(path, "wb"); assert(f); fprintf(f, "P6\n480 480\n255\n");
    for (size_t i = 0; i < sizeof(framebuffer); i += 3) {
        fputc(framebuffer[i+2], f); fputc(framebuffer[i+1], f); fputc(framebuffer[i], f);
    }
    fclose(f);
}
static void publish(deskling_state_t *state) { deskling_ui_publish(state); refresh(NULL); lv_obj_update_layout(lv_screen_active()); }
int main(int argc, char **argv)
{
    assert(argc == 2); setenv("TZ", "Asia/Shanghai", 1); tzset(); lv_init();
    lv_display_t *display = lv_display_create(480,480);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB888);
    static unsigned char draw_buffer[480*480*3];
    lv_display_set_buffers(display,draw_buffer,NULL,sizeof(draw_buffer),LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(display,flush); deskling_ui_start();
    deskling_state_t state = {.connected=true,.has_snapshot=true,.session_count=4,.updated_at=1791478800};
    strcpy(state.provider,"codex"); strcpy(state.overall,"done");
    const char *titles[] = {"接入 AMOLED 触摸交互","修复 WebSocket 重连逻辑","检查 Hub 账号额度隔离","验证设备配置保存"};
    for(int i=0;i<4;i++) { strcpy(state.sessions[i].title,titles[i]); strcpy(state.sessions[i].state,"done"); }
    state.quota[0]=(deskling_quota_t){.present=true,.left=81,.reset_at=time(NULL)+12120};
    state.quota[1]=(deskling_quota_t){.present=true,.left=56,.reset_at=time(NULL)+367200};
    publish(&state); screenshot(argv[1],"home-codex");
    uint32_t idle_renders = deskling_ui_metrics(false).render_count;
    refresh(NULL); lv_refr_now(NULL);
    assert(deskling_ui_metrics(false).render_count == idle_renders);
    state.updated_at++; publish(&state); lv_refr_now(NULL);
    assert(deskling_ui_metrics(false).render_count == idle_renders);
    show_sessions(NULL); screenshot(argv[1],"sessions-reference");
    assert(lv_obj_get_child_count(detail_body)==4);
    assert(lv_obj_get_width(detail_body)==408 && lv_obj_get_height(detail_body)==356);
    lv_point_t back_point = {58,54}, list_point = {240,140};
    assert(lv_indev_search_obj(lv_screen_active(), &back_point)==lv_obj_get_child(overlay,0));
    assert(lv_indev_search_obj(lv_screen_active(), &list_point)==detail_body);
    strcpy(state.sessions[0].state,"waiting"); strcpy(state.sessions[1].state,"working");
    strcpy(state.sessions[2].state,"error"); state.sessions[3].stale=true;
    strcpy(state.sessions[1].title,"重构 WebSocket 重连逻辑与异常恢复流程，验证中文长标题换行和上下滑动");
    strcpy(state.overall,"waiting"); publish(&state); screenshot(argv[1],"sessions-live-update");
    assert(lv_obj_get_height(lv_obj_get_child(detail_body,1))>72);
    show_quota(NULL); screenshot(argv[1],"quota-codex");
    state.quota[0].present=false; state.quota[1].left=0; publish(&state);
    assert(!strcmp(lv_label_get_text(quota[0]),"--")); assert(!strcmp(lv_label_get_text(quota[1]),"0%"));
    screenshot(argv[1],"quota-missing-zero");
    close_overlay(NULL); show_settings(NULL); screenshot(argv[1],"settings-codex");
    lv_obj_t *claude_choice=lv_obj_get_child(overlay,2);
    lv_obj_send_event(claude_choice,LV_EVENT_CLICKED,NULL); assert(!strcmp(config_draft,"claude"));
    close_overlay(NULL); assert(!selected[0]);
    show_settings(NULL); claude_choice=lv_obj_get_child(overlay,2);
    lv_obj_send_event(claude_choice,LV_EVENT_CLICKED,NULL);
    save_settings(NULL); assert(!strcmp(selected,"claude"));
    strcpy(state.provider,"claude"); state.quota[2]=(deskling_quota_t){.present=true,.left=87};
    publish(&state); screenshot(argv[1],"home-claude"); show_quota(NULL); screenshot(argv[1],"quota-claude");
    // Snapshots that leave quota unchanged keep the open quota cards; a quota change rebuilds them.
    // A marker survives only if the card object is kept (a reused address would not carry it).
    static int marker; lv_obj_set_user_data(lv_obj_get_child(detail_body,0),&marker);
    state.updated_at++; strcpy(state.sessions[0].state,"done"); publish(&state);
    assert(lv_obj_get_user_data(lv_obj_get_child(detail_body,0))==&marker);
    state.quota[2].left=86; publish(&state);
    assert(lv_obj_get_user_data(lv_obj_get_child(detail_body,0))==NULL);
    state.session_count=12;
    for(int i=4;i<12;i++) { strcpy(state.sessions[i].title,"滚动列表测试会话");strcpy(state.sessions[i].state,"working"); }
    publish(&state); show_sessions(NULL); lv_obj_scroll_to_y(detail_body,160,LV_ANIM_OFF);
    int before=lv_obj_get_scroll_y(detail_body); state.sessions[8].stale=true; publish(&state);
    assert(before==lv_obj_get_scroll_y(detail_body)); screenshot(argv[1],"sessions-scroll");
    state.session_count=0; publish(&state); screenshot(argv[1],"sessions-empty");
    assert(lv_obj_get_child_count(detail_body)==1);
    state.connected=false; close_overlay(NULL); publish(&state); screenshot(argv[1],"home-offline");
    show_network(NULL); screenshot(argv[1],"network-settings");
    assert(view == NETWORK);
    show_setup("Deskling-TEST", "123456789ABC"); screenshot(argv[1],"usb-setup");
    phone_setup(NULL); screenshot(argv[1],"phone-wifi-qr");
    deskling_ui_provision("pair", "在 Hub 中核对配对码并确认", "284916"); refresh(NULL); screenshot(argv[1],"phone-pairing");
    assert(view == SETUP);
    deskling_ui_provision("pair_wait", "请在远程 Hub 管理页开启设备配对", ""); refresh(NULL); screenshot(argv[1],"remote-pair-wait");
    deskling_ui_provision("pair", "在远程 Hub 中核对配对码并确认", "284916"); refresh(NULL); screenshot(argv[1],"remote-pair-code");
    deskling_ui_provision("error", "Wi-Fi 密码不正确，请修改后重试。", ""); refresh(NULL); screenshot(argv[1],"setup-error");
    puts("UI preview checks passed: reference layout, live updates, wrapped titles, missing/zero quota, cancel/save, scroll position, empty list.");
    return 0;
}
