# OCR 集成尝试总结

> **状态**：已放弃。三轮方案 PoC 均未达预期，暂不再推进。
> **调研日期**：2026-08-08 ~ 2026-08-09。
> **对应 ROADMAP**：无（新功能调研，未进 ROADMAP）。

---

## 结论

在 Markdown 编辑器中为图片增加「识别文字」按钮的 OCR 功能经三轮 PoC 后放弃。三个方案各有硬伤，目前没有兼具高精度、高速度、跨平台的可行路线。

---

## 三轮方案及结果

| 轮次 | 方案 | 结果 | 核心问题 |
|------|------|------|----------|
| 1 | Tesseract.js (前端 WASM) | ❌ 放弃 | 中文识别精度低；大图耗时数十秒 |
| 2 | Windows.Media.Ocr (Rust 原生) | ❌ 放弃 | 依赖 Windows 语言包；识别排版混乱；仅 Windows 不跨平台 |
| 3 | `@paddle-js-models/ocr` (Paddle.js WebGL) | ❌ 放弃 | 集成坑多（见下文），实测效果仍不理想 |

### 方案 1：Tesseract.js

- npm: `tesseract.js`，WebAssembly + Web Worker 推理
- 中文精度中下，大图（截图级）耗时 20s+
- 适合英文场景文本；中文 Markdown 笔记场景不适用

### 方案 2：Windows.Media.Ocr（Rust 原生）

- Windows WinRT API，原生 CPU 推理，速度最快
- 依赖系统安装的语言包（中文需用户手动安装）
- 识别结果排版混乱（无排序、无段落还原）
- 仅 Windows，macOS/Linux 无法使用 → 与项目跨平台目标冲突

### 方案 3：`@paddle-js-models/ocr`（Paddle.js WebGL）

- npm: `@paddle-js-models/ocr@4.1.1`，Paddle.js (WebGL) 推理 PP-OCRv3
- API 简洁（`init()` + `recognize(img)`），精度理论上最高（PaddleOCR 中文标杆）
- **实测识别效果不理想**，决定放弃

---

## 被排除的方案

| 方案 | 排除原因 |
|------|---------|
| Rust ORT + RapidOCR (`ort` crate) | 交叉编译复杂度 + Rust 端 PaddleOCR 前后处理无社区实现 |
| Tauri Sidecar (PyInstaller 打包 PaddleOCR) | +100MB 包体积不可接受 |
| 系统 Tesseract CLI | 用户覆盖率低，依赖系统安装 |
| ONNX Runtime Web + 手写前后处理 | ~800 行 JS 前后处理代码，维护成本高 |
