cmake_minimum_required(VERSION 3.16)
project(deskling_ui_preview C)
get_filename_component(FIRMWARE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_LIST_DIR}/lv_conf.h" CACHE STRING "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
add_subdirectory("${FIRMWARE_ROOT}/managed_components/lvgl__lvgl" lvgl)
# Generate the pet tables locally so the harness does not depend on an ESP-IDF build.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(PETS_ROOT "${FIRMWARE_ROOT}/../assets/pets")
set(PETS_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/pets_assets.c")
file(GLOB_RECURSE PETS_FILES CONFIGURE_DEPENDS "${PETS_ROOT}/*.json" "${PETS_ROOT}/*.webp")
add_custom_command(OUTPUT "${PETS_SOURCE}"
    COMMAND "${Python3_EXECUTABLE}" "${FIRMWARE_ROOT}/tools/embed_pets.py" "${PETS_ROOT}" "${PETS_SOURCE}"
    DEPENDS "${FIRMWARE_ROOT}/tools/embed_pets.py" ${PETS_FILES} VERBATIM)
add_executable(deskling-ui-preview preview.c "${FIRMWARE_ROOT}/main/pet.c"
    "${FIRMWARE_ROOT}/main/fonts/deskling_pixel_12.c" "${FIRMWARE_ROOT}/main/fonts/deskling_pixel_20.c"
    "${FIRMWARE_ROOT}/main/fonts/deskling_pixel_24.c" "${FIRMWARE_ROOT}/main/fonts/deskling_pixel_28.c"
    "${PETS_SOURCE}")
target_include_directories(deskling-ui-preview PRIVATE stubs "${FIRMWARE_ROOT}/main")
target_link_libraries(deskling-ui-preview PRIVATE lvgl z m)
add_executable(deskling-pet-test test_pet.c "${PETS_SOURCE}")
target_include_directories(deskling-pet-test PRIVATE stubs "${FIRMWARE_ROOT}/main")
target_link_libraries(deskling-pet-test PRIVATE lvgl z m)
