set(pets_source "${CMAKE_CURRENT_BINARY_DIR}/pets_assets.c")
set(pets_root "${PROJECT_DIR}/../assets/pets")
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
  file(GLOB_RECURSE pets_files CONFIGURE_DEPENDS "${pets_root}/*.json" "${pets_root}/*.webp")
  add_custom_command(OUTPUT "${pets_source}"
    COMMAND "${PYTHON}" "${PROJECT_DIR}/tools/embed_pets.py" "${pets_root}" "${pets_source}"
    DEPENDS "${PROJECT_DIR}/tools/embed_pets.py" ${pets_files}
    VERBATIM)
endif()
idf_component_register(SRCS "main.c" "network.c" "provision_config.c" "protocol.c" "ui.c" "pet.c"
    "fonts/deskling_pixel_12.c" "fonts/deskling_pixel_20.c" "fonts/deskling_pixel_24.c" "fonts/deskling_pixel_28.c"
    "${pets_source}"
    INCLUDE_DIRS "."
    EMBED_FILES "network-portal.html" "../../assets/fonts/setup-pixel.woff2"
    REQUIRES nvs_flash esp_wifi esp_netif esp_event esp_http_server esp_timer
        esp_system json esp-tls esp_http_client esp_driver_usb_serial_jtag esp_websocket_client mdns http_parser espressif__zlib)
