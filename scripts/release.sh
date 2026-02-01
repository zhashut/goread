#!/bin/bash

# GoRead 版本发布脚本
# 用法:
#   ./scripts/release.sh           # 自动递增版本号 (最新tag + 0.0.1)
#   ./scripts/release.sh 1.4.0     # 指定版本号

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 获取脚本所在目录的项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}      GoRead 版本发布脚本              ${NC}"
echo -e "${GREEN}========================================${NC}"

# 获取最新的 git tag
get_latest_tag() {
    # 同步远程 tags
    git fetch --tags --quiet 2>/dev/null
    # 按版本号排序获取最新 tag
    local latest=$(git tag --sort=-v:refname | head -1)
    echo "${latest:-v0.0.0}"
}

# 递增版本号 (patch 版本 +1)
increment_version() {
    local version=$1
    # 移除 v 前缀
    version=${version#v}
    
    local major minor patch
    IFS='.' read -r major minor patch <<< "$version"
    
    # patch 版本 +1
    patch=$((patch + 1))
    
    echo "$major.$minor.$patch"
}

# 验证版本号格式
validate_version() {
    local version=$1
    if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo -e "${RED}错误: 版本号格式不正确，应为 x.y.z 格式（如 1.3.6）${NC}"
        exit 1
    fi
}

# 更新版本号到配置文件
update_version_files() {
    local version=$1
    
    echo -e "${YELLOW}正在更新版本号到配置文件...${NC}"
    
    # 更新 package.json
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" package.json
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" src-tauri/tauri.conf.json
        sed -i '' "s/^version = \"[^\"]*\"/version = \"$version\"/" src-tauri/Cargo.toml
    else
        # Linux/Git Bash
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" package.json
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" src-tauri/tauri.conf.json
        sed -i "s/^version = \"[^\"]*\"/version = \"$version\"/" src-tauri/Cargo.toml
    fi
    
    echo -e "${GREEN}✓ package.json${NC}"
    echo -e "${GREEN}✓ src-tauri/tauri.conf.json${NC}"
    echo -e "${GREEN}✓ src-tauri/Cargo.toml${NC}"
}

# 主逻辑
main() {
    # 获取最新 tag
    LATEST_TAG=$(get_latest_tag)
    echo -e "当前最新 tag: ${YELLOW}$LATEST_TAG${NC}"
    
    # 确定新版本号
    if [ -n "$1" ]; then
        # 用户指定版本号
        NEW_VERSION="$1"
        echo -e "使用指定版本号: ${GREEN}$NEW_VERSION${NC}"
    else
        # 自动递增版本号
        NEW_VERSION=$(increment_version "$LATEST_TAG")
        echo -e "自动递增版本号: ${GREEN}$NEW_VERSION${NC}"
    fi
    
    # 验证版本号格式
    validate_version "$NEW_VERSION"
    
    # 检查 tag 是否已存在
    if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
        echo -e "${RED}错误: Tag v$NEW_VERSION 已存在！${NC}"
        exit 1
    fi
    
    # 确认发布
    echo ""
    echo -e "${YELLOW}即将执行以下操作:${NC}"
    echo -e "  1. 更新版本号到 ${GREEN}$NEW_VERSION${NC}"
    echo -e "  2. 提交更改并创建 tag ${GREEN}v$NEW_VERSION${NC}"
    echo -e "  3. 推送到 GitHub 触发自动构建"
    echo ""
    read -p "确认继续? (y/n): " -n 1 -r
    echo
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}已取消${NC}"
        exit 0
    fi
    
    # 更新版本号
    update_version_files "$NEW_VERSION"
    
    # Git 操作
    echo -e "${YELLOW}正在提交更改...${NC}"
    git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
    git commit -m "chore(release): release version v$NEW_VERSION"
    
    echo -e "${YELLOW}正在创建 tag...${NC}"
    git tag "v$NEW_VERSION"
    
    echo -e "${YELLOW}正在推送到远程仓库...${NC}"
    git push origin master
    git push origin "v$NEW_VERSION"
    
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}✓ 发布成功！${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo -e "版本号: ${GREEN}v$NEW_VERSION${NC}"
    echo -e "Tag 已推送，GitHub Actions 将自动开始构建"
    echo -e "查看构建进度: ${YELLOW}https://github.com/zhashut/goread/actions${NC}"
}

main "$@"
