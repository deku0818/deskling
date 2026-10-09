#include "deskling.h"
#include "nvs_flash.h"
#include "esp_chip_info.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "bsp/esp-bsp.h"
#include "bsp/display.h"
#include "bsp/touch.h"

// The CO5300 panel only accepts windows that start on an even pixel and span an even count.
static void round_area(lv_event_t *e)
{
    lv_area_t *area = lv_event_get_param(e);
    area->x1 &= ~1; area->y1 &= ~1;
    area->x2 |= 1; area->y2 |= 1;
}

static lv_display_t *register_display(esp_lcd_panel_handle_t panel, esp_lcd_panel_io_handle_t io, bool psram, uint16_t lines)
{
    esp_lv_adapter_display_config_t config = {
        .panel = panel, .panel_io = io,
        .profile = { .interface = ESP_LV_ADAPTER_PANEL_IF_OTHER, .rotation = ESP_LV_ADAPTER_ROTATE_0,
            .hor_res = BSP_LCD_H_RES, .ver_res = BSP_LCD_V_RES, .buffer_height = lines,
            .use_psram = psram, .enable_ppa_accel = false, .require_double_buffer = true },
        .tear_avoid_mode = ESP_LV_ADAPTER_TEAR_AVOID_MODE_NONE,
    };
    return esp_lv_adapter_register_display(&config);
}

// Same steps as bsp_display_start(), except the draw buffers. The BSP puts them in PSRAM,
// which SPI DMA cannot read, so every flushed band needed a temporary ~46 KB internal copy;
// when the internal heap was fragmented that allocation failed (ESP_ERR_NO_MEM) and the band
// was silently dropped, leaving parts of the screen stale. Internal buffers need no copy.
static lv_display_t *start_display(void)
{
    const esp_lv_adapter_config_t adapter = ESP_LV_ADAPTER_DEFAULT_CONFIG();
    ESP_ERROR_CHECK(esp_lv_adapter_init(&adapter));
    const bsp_display_config_t panel_config = { .max_transfer_sz = BSP_LCD_H_RES * BSP_LCD_V_RES * BSP_LCD_BITS_PER_PIXEL / 8 };
    esp_lcd_panel_handle_t panel = NULL; esp_lcd_panel_io_handle_t io = NULL;
    ESP_ERROR_CHECK(bsp_display_new(&panel_config, &panel, &io));
    // 2 x 480 x 20 x 2 bytes = 37.5 KB of internal RAM; Wi-Fi and the setup portal need the rest.
    lv_display_t *display = register_display(panel, io, false, 20);
    if (!display) {
        ESP_LOGW("deskling", "Internal draw buffers unavailable; falling back to PSRAM");
        display = register_display(panel, io, true, 50);
    }
    assert(display);
    lv_display_add_event_cb(display, round_area, LV_EVENT_INVALIDATE_AREA, NULL);
    bsp_display_cfg_t touch_config = { .touch_flags = { .swap_xy = 1, .mirror_x = 0, .mirror_y = 1 } };
    esp_lcd_touch_handle_t touch = NULL;
    ESP_ERROR_CHECK(bsp_touch_new(&touch_config, &touch));
    const esp_lv_adapter_touch_config_t touch_adapter = ESP_LV_ADAPTER_TOUCH_DEFAULT_CONFIG(display, touch);
    lv_indev_t *input = esp_lv_adapter_register_touch(&touch_adapter);
    assert(input); (void)input;
    // Full brightness (CO5300 command 0x51), as bsp_display_brightness_init() does.
    uint8_t brightness = 255;
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io, 0x02 << 24 | 0x51 << 8, &brightness, 1));
    ESP_ERROR_CHECK(esp_lv_adapter_start());
    return display;
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    // Preserve existing NVS on a version mismatch; never silently erase it.
    ESP_ERROR_CHECK(err);
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    ESP_LOGI("deskling", "Deskling on ESP32-S3, revision %d, PSRAM %u bytes",
             chip.revision, (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM));
    lv_display_t *display = start_display();
    assert(display);
    deskling_ui_start();
    ESP_LOGI("deskling", "480x480 display and touch initialized; internal heap %u free, largest block %u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    deskling_network_start();
}
