# 浏览器端 AR 双手手势交互特效

基于 **MediaPipe 手势识别** + **HTML5 Canvas** 构建的浏览器端 AR 交互项目。通过摄像头实时识别双手关键点并映射为画布坐标，在双手之间生成红、蓝、绿三块连续的 AR 滤镜面片，并叠加指尖标记、半调点阵、漫画风、人物自拍分割等多重视觉效果。

支持摄像头实时模式与免摄像头的演示模式；内置本地启动脚本与 GitHub Pages 自动部署，部署后可直接在线体验。

## 效果预览

> 可在此处放一张截图或动图：把图片放入 `docs/` 目录，或将下方占位路径替换为你自己的图片链接。

`![AR 交互效果](docs/screenshot.png)`

## 在线演示

在线体验地址：<https://lporvxe.github.io/ar-hand-gesture/>

> 首次打开会从网页下载约 **17 MB** 的模型与运行库（手部识别模型、WASM 等），需耐心等待十几秒；浏览器缓存后再次打开即为秒开。

## 功能特性

- **双手关键点实时识别**：基于 MediaPipe HandLandmarker，同时识别最多 2 只手，并映射到画布坐标。
- **三块 AR 滤镜面片**：根据左右手关键点动态构建连续面片，分别应用不同风格的实时滤镜：
  - 红色：半调点阵 + 人物抠像；
  - 蓝色：漫画风；
  - 绿色：半调点阵 + 人物抠像。
- **人物自拍分割**：基于 MediaPipe ImageSegmenter（selfie_segmenter），对画面人物进行抠像，让滤镜只作用于人物。
- **指尖标记**：在关键指尖位置绘制标记，直观展示识别结果。
- **跟手平滑度调节**：通过滑块调整关键点插值平滑程度，越靠右越平滑。
- **免摄像头演示模式**：无需授权摄像头即可自动生成双手与场景，用于预览和检查滤镜效果。
- **可离线运行**：MediaPipe 运行库、WASM 与模型文件全部内置于 `vendor/mediapipe`，加载模型无需联网。
- **自动部署**：内置 GitHub Actions 工作流，推送到 `main` 分支即自动重新部署到 GitHub Pages。

## 技术栈

- **JavaScript（ES Module）**：前端交互与渲染逻辑。
- **MediaPipe Tasks Vision（WASM）**：手部关键点识别与人物分割，本地 vendor 内置。
- **HTML5 Canvas**：实时滤镜渲染与交互绘制。

## 目录结构

```text
.
├── index.html                    页面入口
├── README.md                     项目说明
├── src/
│   ├── app.js                    手势识别、坐标映射与滤镜渲染逻辑
│   └── styles.css                界面样式
├── vendor/mediapipe/
│   ├── tasks-vision/             MediaPipe Tasks 运行库与 WASM
│   │   ├── wasm/                 wasm 运行文件
│   │   └── vision_bundle.js      Vision 任务绑定库
│   └── models/                   本地模型文件
│       ├── hand_landmarker.task  手部关键点模型（约 7.8 MB）
│       └── selfie_segmenter.tflite 人物分割模型
├── .github/workflows/pages.yml   GitHub Pages 自动部署工作流
├── Start-LocalServer.ps1         本地 HTTP 服务脚本
├── 启动AR.bat                    Windows 一键启动入口
└── 使用说明.txt                  详细使用说明
```

## 运行方式

### 本地运行

> 摄像头需要本地 HTTP 服务环境：直接双击 `index.html` 以 `file://` 打开时浏览器会禁止调用摄像头，请使用下面任一方式。

- **方式一（Windows 推荐）**：双击 `启动AR.bat`。脚本会自动在 `8000–8999` 中选择可用端口启动本地服务，并打开默认浏览器。
- **方式二（命令行）**：

  ```bash
  powershell -ExecutionPolicy Bypass -File Start-LocalServer.ps1
  ```

页面打开后点击 **启动摄像头**，首次使用按浏览器提示允许访问摄像头；不授权摄像头可点击 **演示模式** 直接预览。

### 在线部署（GitHub Pages）

仓库已内置自动部署工作流（`.github/workflows/pages.yml`）：

1. 打开仓库 **Settings → Pages**。
2. 将 **Source** 设置为 **GitHub Actions**（若已是该选项则忽略）。
3. 推送到 `main` 分支后，工作流会自动构建并部署。

部署完成后访问 <https://lporvxe.github.io/ar-hand-gesture/> 即可在线体验，无需再手动操作。

## 使用说明

- **启动摄像头**：开启摄像头与 MediaPipe 实时手势识别。
- **演示模式**：无需摄像头，自动生成双手与面片，用于检查滤镜效果。
- **重置**：停止摄像头或演示，回到初始状态。
- **跟手平滑度**：拖动滑块调整关键点插值平滑程度，越靠右越平滑。

摄像头启动后控制栏会自动弱化，鼠标移到下方控制栏会重新显示。

## 注意事项 / 常见问题

- **没有摄像头 / 权限被拒**：确认设备已连接、权限已允许；摄像头权限只能在 `http://localhost` 或 `https` 环境下使用。
- **识别不到手 / 只识别到一只手**：将双手同时放入画面，保持手部光照充足；页面顶部会给出提示。
- **首次加载较慢**：首次会从网络下载约 17 MB 的模型与运行库，属正常现象；浏览器缓存后再次打开很快。
- **建议浏览器**：最新版 Chrome 或 Edge。
- **file:// 无法调用摄像头**：必须通过本地服务器或 HTTPS 页面访问。
- **MediaPipe 模型加载失败**：确认 `vendor/mediapipe/tasks-vision` 与 `vendor/mediapipe/models` 目录完整，未重命名或删除。

## 开发说明

本项目由 AI 辅助开发工具（Claude Code）协助完成：从需求拆解、代码生成、交互逻辑调试到运行优化，全程借助 AI 工具快速迭代，体现「需求 → 原型 → 可用功能」的快速交付流程。
