#!/bin/bash

# GoRead iOS 本地安装脚本（免费 Apple ID 方案）
# 用法（需在 macOS 上执行）:
#   ./scripts/ios-install.sh               # 构建并安装到已连接的 iPhone（自动检测 Team ID）
#   ./scripts/ios-install.sh <team-id>     # 指定开发者团队 ID 并构建安装
#
# 前提:
#   1. macOS + Xcode（Xcode >= 15）
#   2. 已登录 Apple ID（Xcode → Settings → Accounts，免费即可）
#   3. iPhone 通过 USB 连接并信任电脑
#   4. Rust 已安装，支持 aarch64-apple-ios 目标
#   5. 项目依赖已安装（npm install）
#
# 说明:
#   - 免费 Apple ID 证书 7 天过期，到期后重新运行本脚本即可
#   - 首次安装需在 iPhone 上信任证书:
#     设置 → 通用 → VPN 与设备管理 → 信任开发者

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}      GoRead iOS 本地安装脚本          ${NC}"
echo -e "${GREEN}========================================${NC}"

# ---------- 1. 检查 macOS 环境 ----------
if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "${RED}错误: 此脚本必须在 macOS 上运行${NC}"
    exit 1
fi

# 检查 Xcode
if ! command -v xcodebuild &> /dev/null; then
    echo -e "${RED}错误: 未检测到 Xcode，请安装 Xcode 并确保 xcode-select 指向 Xcode${NC}"
    echo "  安装 Xcode: App Store 或 https://developer.apple.com/xcode/"
    echo "  切换工具链: xcode-select -s /Applications/Xcode.app/Contents/Developer"
    exit 1
fi

# 检查 Rust aarch64-apple-ios 目标
if ! rustup target list --installed | grep -q "aarch64-apple-ios"; then
    echo -e "${YELLOW}正在添加 Rust aarch64-apple-ios 目标...${NC}"
    rustup target add aarch64-apple-ios
fi

# 检查 Node
if ! command -v node &> /dev/null; then
    echo -e "${RED}错误: 未检测到 Node.js，请先安装 Node.js${NC}"
    exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}正在安装项目依赖（npm ci）...${NC}"
    npm ci
fi

# ---------- 2. 确定签名参数 ----------
TEAM_ID="${1:-}"

if [ -z "$TEAM_ID" ]; then
    # 尝试从 project.yml 读取
    TEAM_ID=$(grep 'DEVELOPMENT_TEAM:' src-tauri/gen/apple/project.yml 2>/dev/null | sed 's/.*DEVELOPMENT_TEAM: *"\{0,1\}\([^"]*\)"\{0,1\}*/\1/' | tr -d '"' || true)

    if [ -z "$TEAM_ID" ] || [ "$TEAM_ID" = "YOUR_TEAM_ID_HERE" ]; then
        echo -e "${YELLOW}未指定 Team ID，尝试自动检测...${NC}"
        # 尝试从 Xcode 签名配置获取
        TEAM_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep "Apple Development" | head -1 | awk -F'"' '{print $2}')
        if [ -z "$TEAM_ID" ]; then
            echo -e "${RED}无法自动检测 Team ID，请手动指定:${NC}"
            echo "  ./scripts/ios-install.sh <TEAM_ID>"
            echo ""
            echo "  查找 Team ID:"
            echo "    1. 免费 Apple ID: 登录 https://developer.apple.com → 账户设置 → 成员资格 → Team ID"
            echo "    2. 或 Xcode → Settings → Accounts → 查看 Team 名称（Team ID 在 Accounts 页面下方）"
            exit 1
        fi
    fi

    # 更新 project.yml 中的 Team ID
    echo -e "${YELLOW}正在更新 project.yml 中的 DEVELOPMENT_TEAM...${NC}"
    sed -i '' 's/DEVELOPMENT_TEAM:.*/DEVELOPMENT_TEAM: "'"${TEAM_ID}"'"/' src-tauri/gen/apple/project.yml
fi

echo -e "Team ID: ${YELLOW}${TEAM_ID}${NC}"

# ---------- 3. 构建 iOS 安装包 ----------
echo -e "${YELLOW}正在构建 iOS 安装包（Debug 模式，编译时间较长）...${NC}"
echo -e "  首次编译 Rust 后端约 5-15 分钟，后续增量编译较快"
echo -e "  说明: tauri ios build 会自动复用仓库内已提交的 src-tauri/gen/apple 工程"
npx tauri ios build \
    --debug \
    --team-id "$TEAM_ID" \
    2>&1 | tee /tmp/goread_ios_build.log

BUILD_EXIT=${PIPESTATUS[0]}
if [ $BUILD_EXIT -ne 0 ]; then
    echo -e "${RED}构建失败！查看日志: /tmp/goread_ios_build.log${NC}"
    tail -50 /tmp/goread_ios_build.log
    exit 1
fi

# ---------- 4. 安装到设备 ----------
echo -e "${YELLOW}正在安装到已连接的 iPhone...${NC}"

# 查找 .app 文件
APP_PATH=""
for candidate in \
    "src-tauri/target/aarch64-apple-ios/debug/bundle/app/GoRead.app" \
    "src-tauri/gen/apple/GoRead_iOS/build/Debug-iphoneos/GoRead.app"; do
    if [ -d "$candidate" ]; then
        APP_PATH="$candidate"
        break
    fi
done

if [ -z "$APP_PATH" ]; then
    echo -e "${YELLOW}查找 .app 文件...${NC}"
    APP_PATH=$(find src-tauri -name "GoRead.app" -type d 2>/dev/null | head -1 || true)
fi

if [ -z "$APP_PATH" ]; then
    echo -e "${RED}未找到构建产物 GoRead.app，请检查构建日志: /tmp/goread_ios_build.log${NC}"
    exit 1
fi

echo -e "构建产物: ${GREEN}${APP_PATH}${NC}"

# 使用 ios-deploy 或 Xcode 安装
if command -v ios-deploy &> /dev/null; then
    echo -e "${YELLOW}使用 ios-deploy 安装...${NC}"
    ios-deploy --bundle "$APP_PATH" --no-wifi
elif command -v xcrun &> /dev/null; then
    echo -e "${YELLOW}使用 xcrun devicectl 安装...${NC}"
    xcrun devicectl device install app --app "$APP_PATH" || true
    echo ""
    echo -e "${YELLOW}若自动安装失败，请手动通过 Xcode 安装:${NC}"
    echo "  1. 打开 Xcode → Window → Devices and Simulators"
    echo "  2. 选择你的 iPhone → 找到 GoRead → 点击 Install"
else
    echo -e "${RED}未找到 ios-deploy 或 xcrun，请手动安装:${NC}"
    echo "  1. 打开 Xcode → Window → Devices and Simulators"
    echo "  2. 选择你的 iPhone → 找到 GoRead → Install"
fi

# ---------- 5. 提示 ----------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ iOS 构建完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "iPhone 15 安装步骤:"
echo "  1. USB 连接 iPhone 到 Mac，点击「信任此电脑」"
echo "  2. 运行本脚本: ./scripts/ios-install.sh ${TEAM_ID}"
echo "  3. 首次安装需信任证书:"
echo "     iPhone 设置 → 通用 → VPN 与设备管理 → 信任 ${TEAM_ID}"
echo "  4. 从主屏幕启动 GoRead"
echo ""
echo -e "${YELLOW}注意: 免费 Apple ID 签名证书 7 天过期，到期后重新运行本脚本即可${NC}"
