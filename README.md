# GoRead

GoRead 是一个基于 Tauri 和 React 构建的高性能本地电子书阅读器。它结合了 Rust 的高性能后端和 React 的现代化前端体验，提供流畅的阅读和书籍管理功能。

## ✨ 功能特性

- **📚 书架管理**：轻松导入和管理您的藏书，支持拖拽排序。
- **📂 分组整理**：支持自定义分组，让您的书库井井有条。
- **📖 沉浸式阅读**：高性能渲染引擎，提供流畅的翻页和缩放体验。
- **🔖 书签功能**：随时保存阅读进度，快速跳转。
- **🔍 快速搜索**：支持书名搜索，快速找到您想读的书。
- **⚙️ 个性化设置**：支持多种阅读模式和界面设置。
- **💾 本地存储**：使用 SQLite 本地存储数据，保护您的隐私。

## 🛠️ 技术栈

### 前端
- **框架**: [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **构建工具**: [Vite](https://vitejs.dev/)
- **路由**: [React Router](https://reactrouter.com/)
- **交互**: [dnd-kit](https://dndkit.com/) (拖拽交互)

### 后端
- **核心**: [Rust](https://www.rust-lang.org/)
- **框架**: [Tauri v2](https://tauri.app/)
- **数据库**: SQLite (via `sqlx` & `tauri-plugin-sql`)
- **文档渲染**: [PDFium](https://pdfium.googlesource.com/pdfium/) (via `pdfium-render`)

## 🚀 快速开始

### 环境要求
- [Node.js](https://nodejs.org/) (推荐 LTS 版本)
- [Rust](https://www.rust-lang.org/tools/install) (最新稳定版)
- 操作系统构建依赖 (参考 [Tauri 文档](https://tauri.app/start/prerequisites/))

### 安装依赖

```bash
npm install
```

### 开发模式运行

```bash
npm run tauri dev
```

### 构建发布版本

```bash
npm run tauri build
```

## 📱 移动端开发

GoRead 支持打包为 Android 和 iOS 应用。

### 前置要求

- **Android**: 安装 Android Studio 并配置 Android SDK 和 NDK。
- **iOS**: 安装 Xcode (仅限 macOS)。
- 详细环境配置请参考 [Tauri 移动端指南](https://v2.tauri.app/develop/)。

### 初始化移动端

首次开发移动端前，需要初始化相关配置：

```bash
# 初始化 Android
npm run tauri android init

# 初始化 iOS
npm run tauri ios init
```

### 🔐 应用签名密钥生成
```bash
keytool -genkey -v `
  -keystore "release-key.keystore" `
  -alias "goread" `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000
```

### 移动端运行

连接真机或启动模拟器后：

```bash
# Android 开发模式
npm run tauri android dev

# iOS 开发模式
npm run tauri ios dev
```

### 移动端构建

构建用于发布的安装包（APK/AAB/IPA）：

```bash
# 构建 Android
npm run tauri android build

# 构建 iOS
npm run tauri ios build
```

## 📂 项目结构

```
goread/
├── src/                # 前端源代码
│   ├── components/     # React 组件 (书架, 阅读器等)
│   ├── services/       # 业务逻辑服务
│   ├── constants/      # 常量定义
│   └── ...
├── src-tauri/          # Rust 后端源代码
│   ├── src/
│   │   ├── commands/   # Tauri 命令 (前后端交互)
│   │   ├── pdf/        # PDF 文档处理逻辑
│   │   └── ...
│   ├── capabilities/   # Tauri 权限配置
│   └── ...
└── ...
```
