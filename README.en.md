English | [简体中文](README.md)

<p align="center">
  <img src="./public/app-icon.svg" alt="GoRead Icon" width="128" height="128">
</p>

# GoRead

GoRead is a lightweight reader application designed specifically for local e‑book reading. It supports both desktop and mobile platforms (Android / iOS), providing a consistent and smooth reading experience across your devices.

> Online e‑book source: <a href="https://z-lib.id" target="_blank">Z-Library</a> — download online and import locally.


---

## Overview

GoRead focuses on **local e‑book management and immersive reading**. It does not rely on cloud accounts, contains no ads, and minimizes interruptions. It is designed for users who want full control over their library and privacy.

You can consolidate e‑books scattered across different folders, organize them into custom groups, and read them in a unified reader with bookmarks and reading progress management.

---

## Core Features

### 1. Library & Bookshelf Management
- Import local e‑book files once and manage them over the long term
- Display all books in a **bookshelf view** for quick browsing and filtering
- Manage book metadata in a unified way for easier search and organization

### 2. Custom Grouping
- Create custom groups such as "Reading", "Tech", "Literature", "To Read", etc.
- Move books freely between groups to keep your library organized
- Adjust group order, e.g. pin frequently used groups to the top

### 3. Immersive Reading Experience
- High‑performance rendering engine for smooth page turns, zooming, and navigation
- Supports common reading operations: page jump, continuous reading, page zooming, etc.
- Clean reading UI designed to reduce distractions and keep your attention on the content

### 4. Bookmarks & Reading Progress
- Add multiple bookmarks to important pages for quick review later
- Automatically records reading progress for each book and restores it on the next open
- All progress is stored locally and does not require a network connection

### 5. Search & Quick Navigation
- Search by book title to quickly locate what you want to read
- Combine grouping and sorting to quickly find the content that matters most

### 6. Local Storage & Privacy
- All books and reading data are stored locally on your device
- No upload of your library or reading history, suitable for users who care about privacy

### 7. Multilingual & Internationalization
- Built-in English and Simplified Chinese UI, follows system language by default
- Planned in-app language switch and more languages support

---

## Who Is GoRead For?

- **Heavy readers**: Have many local e‑books and want a unified tool to manage them
- **Technical / professional users**: Frequently read PDFs or technical manuals and need efficient lookup and bookmarking
- **Privacy‑conscious users**: Do not want their library or reading history to depend on cloud services or third‑party accounts
- **Multi‑device users**: Want a consistent reading experience on desktop and mobile (you can sync your library across devices using your own file sync tools)

---

## Basic Usage Flow

1. **Install and launch GoRead**
2. **Import books**: Import local e‑book files into the app
3. **Organize groups**: Create groups based on your own reading habits and categorize books
4. **Start reading**: Select a book from the bookshelf to open the reader
5. **Add bookmarks / track progress**: Add bookmarks for key content while reading; progress is recorded automatically when you exit
6. **Search and manage**: Use search and groups to quickly locate the books you need

---

## Getting Started (Developers)

If you want to run GoRead locally or contribute to its development, follow these steps.

### Requirements
- Node.js installed (LTS version recommended)
- Rust installed (stable channel is sufficient)
- System dependencies set up according to the official Tauri documentation

### Install Dependencies

```bash
npm install
```

### Start Development Environment

```bash
npm run tauri dev
```

### Build Desktop Release

```bash
npm run tauri build
```

---

## Mobile Support

GoRead can be built as Android and iOS applications, suitable for users who prefer reading on phones or tablets.

### Initialize Mobile Projects

Before starting mobile development for the first time, run the initialization commands:

```bash
# Initialize Android
npm run tauri android init

# Initialize iOS
npm run tauri ios init
```

### Run Mobile Apps (Development)

After connecting a real device or starting an emulator, you can run mobile dev builds:

```bash
# Android development mode
npm run tauri android dev

# iOS development mode
npm run tauri ios dev
```

### Build Mobile Packages

```bash
# Build Android packages (APK/AAB)
npm run tauri android build

# Build iOS packages (IPA)
npm run tauri ios build
```

To generate a signing key for Android, you can use a command similar to:
```bash
keytool -genkey -v \
  -keystore "release-key.keystore" \
  -alias "goread" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

---

## Contributing & Feedback
GoRead is under active development. You are welcome to:

- Report issues or suggestions to help improve the experience
- Contribute code or optimize existing features
- Share your usage scenarios across different devices and reading contexts

If you run into problems while using GoRead or have new ideas for features, please open an Issue or submit a Pull Request in the project repository.
