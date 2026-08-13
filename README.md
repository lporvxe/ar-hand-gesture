# 浏览器端 AR 双手手势交互特效

基于 MediaPipe 手势识别 + Canvas 的浏览器端 AR 交互项目。通过摄像头实时识别双手关键点并映射为坐标，实现 AR 滤镜镜片交互效果；支持演示模式与本地启动。

## 在线演示

部署完成后在此填入 GitHub Pages 链接：`https://lporvxe.github.io/ar-hand-gesture/`

## 功能

- 摄像头实时识别双手关键点（MediaPipe HandLandmarker），映射为画布坐标
- AR 滤镜镜片交互效果：指尖跟踪、半调点阵滤镜、自拍分割等
- 演示模式（无需摄像头即可预览效果）
- 跟手平滑度调节
- 支持本地启动（Windows 双击 `启动AR.bat` 或运行 `Start-LocalServer.ps1`）

## 技术栈

- JavaScript（ES Module）
- MediaPipe Tasks Vision（WASM，本地 vendor）
- HTML5 Canvas

## 本地运行

```bash
# 方式一：双击 启动AR.bat（Windows）
# 方式二：PowerShell 运行
powershell -ExecutionPolicy Bypass -File Start-LocalServer.ps1
```

> 注意：摄像头需要本地服务器环境（`file://` 方式无法调用摄像头），部署到 HTTPS 站点后可直接在线体验。

## 开发说明

本项目由 AI 辅助开发工具（Claude Code）协助完成：从需求拆解、代码生成、交互逻辑调试到运行优化，全程借助 AI 工具快速迭代，体现「需求 → 原型 → 可用功能」的快速交付流程。
