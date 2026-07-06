const TAISHAN_WORKBENCH_BOARD = {
  id: "taishan-gray",
  label: "泰山派 RK3566 小电脑",
  family: "Taishan Linux",
  status: "available",
  route: "/workbench?board=taishan-gray",
  description: "当前线上工作台的主力 Linux 小屏设备入口。未绑定真实硬件的账号会先进入体验预览，已绑定设备可直接走自己的硬件通道。",
  capabilities: ["Web App", "Agent Workflow", "Preview", "FRP Deploy"],
};

const WANGQI_BOARD_CATALOG = [
  {
    id: "szpi-esp32s3",
    label: "立创实战派 ESP32-S3",
    family: "ESP32-S3",
    status: "planning",
    route: "/workbench?board=szpi-esp32s3&mode=demo",
    description: "ESP-IDF v5.4, 16MB Flash, 8MB PSRAM, LCD, audio, camera, IMU, SD card.",
    capabilities: ["ESP-IDF", "LVGL", "WiFi/BLE", "Camera", "Audio", "IMU"],
  },
  {
    id: "huangshan-pi-sf32lb52",
    label: "Huangshan Pi / SiFli SF32LB52",
    family: "SiFli SF32LB52",
    status: "planning",
    route: "/workbench?board=huangshan-pi-sf32lb52&mode=demo",
    description: "SiFli SDK/SCons workflow with compile, bridge flash, LVGL preview, serial evidence.",
    capabilities: ["SiFli SDK", "LVGL Preview", "Local Bridge", "Flash Evidence"],
  },
  {
    id: "seeed-xiao-nrf52840-sense",
    label: "Seeed XIAO nRF52840 Sense",
    family: "Nordic nRF52840",
    status: "experimental",
    route: "/workbench?board=seeed-xiao-nrf52840-sense&mode=demo",
    description: "Experimental Nordic workspace for BLE and sensor-oriented firmware flows.",
    capabilities: ["Nordic", "BLE", "Sensors", "DFU"],
  },
  {
    id: "waveshare-esp32s3-touch-amoled-18",
    label: "ESP32-S3 Touch AMOLED 1.8",
    family: "Waveshare ESP32-S3",
    status: "planning",
    route: "/workbench?board=waveshare-esp32s3-touch-amoled-18&mode=demo",
    description: "Screen-first ESP32-S3 board target referenced by the external board notes.",
    capabilities: ["ESP32-S3", "AMOLED", "Touch", "LVGL"],
  },
  {
    id: "waveshare-esp32p4-wifi6-touch-lcd-35",
    label: "ESP32-P4 WIFI6 Touch LCD 3.5",
    family: "Waveshare ESP32-P4",
    status: "planning",
    route: "/workbench?board=waveshare-esp32p4-wifi6-touch-lcd-35&mode=demo",
    description: "Large-screen ESP32-P4 target reserved for future board-specific workflows.",
    capabilities: ["ESP32-P4", "WIFI6", "Touch LCD", "LVGL"],
  },
];

export function buildBoardCatalog() {
  return [
    TAISHAN_WORKBENCH_BOARD,
    ...WANGQI_BOARD_CATALOG,
  ];
}
