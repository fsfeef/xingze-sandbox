# 虚拟城市沙盘 v1 验证报告

- 验证时间：2026-11-25 17:32–17:36 CST
- 被测：`~/workspace/virtual-city/app/`，服务 `http://localhost:8000/app/`（python http.server，virtual-city/ 根目录起）
- 方法：playwright-core + Chromium 1255（`~/.cache/ms-playwright/chromium-1255/`）+ SwiftShader 软渲染，1280×800。脚本：`tests/verify.js`、`tests/probe.js`、`tests/probe2.js`
- 注意：SwiftShader 是 CPU 软渲染，帧率不能当真机成绩；draw call / 三角面数是引擎侧实测数，可信。

## 结论：通过（v1 沙盘能看、能滑、交互全通）

| 项 | 结果 |
|---|---|
| 启动 | ✅ PASS。启动约 11s（SwiftShader 编译着色器慢），进入开始界面，真实数据 v1.0.0：1053 栋楼 · 44 条路 · 3 个地标 · 最高 260m，MOCK 徽标已隐藏 |
| console 错误 | ✅ **0**（25 秒会话全程：0 console error、0 pageerror、0 失败请求、0 HTTP≥400；仅 1 条 SwiftShader 警告 KHR_parallel_shader_compile，非错误） |
| 白天航拍 | ✅ PASS，见 `01-day-aerial.png` |
| 拖动平移 | ✅ PASS，拖动后视角明显移动，见 `02-after-drag.png` |
| 夜晚 | ✅ PASS，时间轴拖到 22 点，楼群窗光亮起，见 `03-night.png`，时间标签 22:00 夜晚 |
| 热力图 | ✅ PASS，开关 aria-pressed=true，见 `04-heatmap.png` |
| 白膜 | ✅ PASS，开关 aria-pressed=true，全城变白陶土色，见 `05-whitemodel.png` |
| 地标飞行 | ✅ PASS，点“星泽塔 260m”飞过去，见 `06-landmark-fly.png` |
| 小地图点按 | ✅ PASS，点击小地图无报错，见 `07-minimap-fly.png` |
| 面板收起/展开 | ✅ PASS，点 ✕ 面板隐藏、📊 按钮出现；点 📊 面板恢复，见 `08-panel.png` |
| draw call | ✅ **17**（预算 <60） |
| 三角面 | **276,360**（建筑+树 4163 棵+灯+地形+远山+水面；搭建工人 Node 侧估的 29,718 只算了合并建筑，不作数，以实测为准） |
| FPS | 暖机后 HUD **43 FPS**（SwiftShader 软渲染）；刚进场编译着色器时前 5 秒约 0.4 FPS。**这两个数都不是真机成绩**，真机实测仍待做 |

## 启动 bug（已修好）

- 第一版在真浏览器里**启动失败**：`OutputPass.js` 引用的 `vendor/addons/shaders/OutputShader.js` 缺失（404），模块加载挂掉，报“模块加载错误”。
- 已补：从同一 three r170 官方源（unpkg）取回该文件，全 vendor 只缺这一个。补完重测启动成功、零错误。

## 截图清单（tests/）

- `00-boot-error.png`——修复前的启动失败截图（留证）
- `01-day-aerial.png`——白天航拍
- `02-after-drag.png`——拖动后
- `03-night.png`——22:00 夜晚
- `04-heatmap.png`——热力图
- `05-whitemodel.png`——白膜
- `06-landmark-fly.png`——点地标飞过去
- `07-minimap-fly.png`——点小地图后
- `08-panel.png`——面板展开

## 已知问题（诚实说明）

1. **真机流畅度未测**：SwiftShader 帧率不代表手机/真机。60fps 目标、手机滑动手感，必须在真机或老大电脑 Chrome 上再测一次。
2. **顶部帮助条在 1280px 下被顶栏遮住一半**（“多画面·滚轮/捏合…”半句被盖住），小布局 bug，待修。
3. **启动 11 秒**（SwiftShader 编译着色器慢，真机上会快很多，但首屏仍需优化到 3 秒内）。
4. **开车无碰撞、无循路、无道路贴合**，只是自由驾驶 + 双视角。
5. **只有 3 个地标**；住宅 879 栋占绝对多数，柱状图一柱独大。
6. **远山未做视觉验收**；无阴影（有意为之，保性能预算）。
7. **验证脚本的一个失误**：第一次跑 verify.js 时点了 `#panel-toggle`，该按钮在桌面端按设计就是隐藏的（面板默认展开，只有收起后才出现），导致脚本 30 秒超时中断。后用 probe2 按正确流程（先点 ✕ 收起、再点 📊 展开）重测通过。不是 app 的 bug。

## 范围口径（与任务书的出入）

- 本版是 2km×2km 中心区（1053 栋）。老大 17:23/17:29/17:30 电话里已改口径：虚拟城范围是六区（锦江/青羊/金牛/武侯/成华+高新南区，绕城以内），且**不从零重建、不用程序化重建，直接拿现有白模 v3.2 裁出六个区、区外全删，楼高 v2.1 的 84,565 栋全接进去**。
- 本沙盘验证的是“壳子”（Three.js 渲染 + 界面 + 交互 + 性能做法），壳子已验过可用；下一步按老大新决定应是裁白模，不是继续扩程序化城市。
