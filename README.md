# Chameleon Ultra · Web

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Deploy](https://github.com/hakureiyuyuko/chameleon-web/actions/workflows/deploy.yml/badge.svg)](https://github.com/hakureiyuyuko/chameleon-web/actions/workflows/deploy.yml)

Chameleon Ultra 的**纯前端**网页版 GUI：浏览器通过 **Web Serial** 直接打开设备的 USB CDC 串口（`VID_6868&PID_8686`，Windows 上通常显示为 `COM38`），不用装任何客户端。

在线使用：**https://hakureiyuyuko.github.io/chameleon-web/**

> 需要 **Chromium 桌面版**（Chrome / Edge 89+）。Firefox、Safari、iPad 没有 Web Serial；Chatbox / 飞书 / 微信这类内置的 Electron 浏览器也不行（它们没有实现 `select-serial-port` 事件）。

底层协议交给 [`chameleon-ultra.js`](https://github.com/taichunmin/chameleon-ultra.js)（MIT），与官方 GUI/CLI 使用同一套串口协议帧。

## 功能

| 功能 | 说明 |
|---|---|
| 连接 / 断开 | Web Serial，115200 8N1，自动识别 DFU 模式 |
| 设备信息 | 型号、固件版本、git 版本、模式、激活槽、电量、芯片 ID |
| 槽位管理 | 8 个槽位，HF / LF 各自可设 tag type、启用开关、设为激活、保存到设备 |
| HF 扫描 | ISO14443A 防冲突，读 UID / ATQA / SAK / ATS 并推断卡型 |
| 读取 MF1 整卡 | 密钥字典批量查密钥（一条命令扫 40 扇区）→ 逐块读 → 带扇区/尾块高亮的 dump 视图 |
| Gen1a 快读 | 后门卡（UID 卡）绕过密钥整卡读取 |
| 读取 MF0 / NTAG | Ultralight / NTAG 全页读取 |
| LF 扫描 | 依次试 EM410x / HID Prox / Viking |
| 写入槽位 | MF1 dump、MF0 dump、LF 卡号都能写进槽位当模拟卡 |
| dump 导入导出 | JSON（含密钥表与扫描信息）/ 原始 `.bin` |
| 密钥字典 | 32 个常用密钥，可编辑，存 localStorage |
| 日间 / 夜间模式 | 跟随系统，可手动切换并记忆 |

## 本地开发

```powershell
npm install
npm run dev          # http://localhost:5173
npm run build        # 产物在 dist/
npm run preview      # 预览 dist
npm run serve        # 零依赖静态服务器，http://localhost:8080
```

Windows 上也可以直接双击 `start.cmd`：没有 `dist/` 会先构建，然后起静态服务并打开 Chrome。

`localhost` 属于安全上下文，Web Serial 直接可用，不需要证书；但**双击 `index.html`（`file://`）是不行的**。

## 部署

推送到 `main` 后由 GitHub Actions（`.github/workflows/deploy.yml`）自动构建并发布到 GitHub Pages。
仓库需要在 **Settings → Pages → Source** 选 **GitHub Actions**（本仓库已配置）。

`vite.config.ts` 里 `base: './'`，所以放在 `/<repo>/` 子路径下也能正常加载资源。

## 实现要点（踩过的坑）

1. **UID 不在 block 0 里。** 固件默认 `use_mf1_coll_res = false`，模拟卡的 UID/ATQA/SAK 来自防冲突配置。只写 block 0 复制不出 UID，必须额外调 `cmdHf14aSetAntiCollData`。
2. **`cmdMf1EmuWriteBlock(offset, data)` 的 offset 是块号，不是字节偏移**（对照固件 `cmd_processor_mf1_write_emu_block_data`），`data` 长度必须是 16 的倍数，单批 32 块比较稳。
3. **端口过滤器被绕过了。** SDK 的 `WebserialAdapter` 内部写死 `requestPort({filters: [6868:8686]})`，改过 PID 的板子会看不到，所以这里包了一层忽略 filters。
4. **串口只能由用户手势触发，且只能选已授权的口。** 浏览器里没有"自动扫描 COM 号"这回事，`navigator.serial.getPorts()` 只能拿到之前授权过的端口。
5. **串口独占。** CLI / 桌面版 GUI 开着同一个 COM 口时，浏览器会报 `Failed to open serial port`。

## 已知限制

- 仅 Chromium 桌面版。Android 需要 `web-serial-polyfill` + WebUSB，很多机器 CDC 驱动已被占用。
- 后台标签页会被节流，长时间流式读取（sniffing）需要放到 Worker 里，本版未做。
- 尚未实现：MF1 硬解（nested / darkside / hardnested）、真实写卡、HF/LF sniffing、固件 DFU 更新。

## 致谢

- [chameleon-ultra.js](https://github.com/taichunmin/chameleon-ultra.js) — MIT，本项目的串口协议与命令封装全部来自它
- [ChameleonUltraGUI](https://github.com/GameTec-live/ChameleonUltraGUI) — 功能布局参考
- [ChameleonUltra](https://github.com/RfidResearchGroup/ChameleonUltra) — 固件与协议文档

## License

**GNU Affero General Public License v3.0 or later**，见 [LICENSE](LICENSE)。

本项目为独立实现，未复制 GPL 代码；依赖的 `chameleon-ultra.js` 为 MIT 许可，与 AGPLv3 兼容。若你把它部署成公开的在线服务，AGPL 要求向社会公开修改后的源代码。
