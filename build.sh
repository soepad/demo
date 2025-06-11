#!/bin/bash

# 构建脚本 - 用于在Cloudflare Pages构建过程中克隆和合并所有图片仓库的内容
# 此脚本在Cloudflare Pages的构建环境中运行

# 输出彩色日志
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=========================================${NC}"
echo -e "${GREEN}开始执行多仓库内容合并部署脚本${NC}"
echo -e "${BLUE}=========================================${NC}"

# 检查环境变量
if [ -z "$GITHUB_TOKEN" ]; then
  echo -e "${RED}错误: 缺少GITHUB_TOKEN环境变量${NC}"
  echo -e "${YELLOW}请在Cloudflare Pages的环境变量中设置GITHUB_TOKEN${NC}"
  exit 1
fi

if [ -z "$GITHUB_OWNER" ]; then
  echo -e "${RED}错误: 缺少GITHUB_OWNER环境变量${NC}"
  echo -e "${YELLOW}请在Cloudflare Pages的环境变量中设置GITHUB_OWNER${NC}"
  exit 1
fi

# 创建临时目录用于克隆仓库
TEMP_DIR="./temp_repos"
mkdir -p $TEMP_DIR

# 确保public/images目录存在
mkdir -p ./public/images

echo -e "${GREEN}准备处理图片仓库...${NC}"

# 由于无法在构建环境中直接访问D1数据库，我们使用预定义的仓库列表
# 可以通过REPOS环境变量自定义仓库列表，格式为逗号分隔的仓库名称
if [ ! -z "$REPOS" ]; then
  echo -e "${GREEN}使用环境变量REPOS中的仓库列表${NC}"
  REPO_LIST=$(echo $REPOS | tr ',' ' ')
else
  # 默认仓库列表，使用三位数字格式
  echo -e "${YELLOW}未指定REPOS环境变量，将使用默认仓库列表${NC}"
  REPO_LIST="images-repo-001"
  
  # 尝试查找更多可能的仓库（基于命名模式），使用三位数字格式
  for i in {2..100}; do
    # 将数字格式化为三位数，例如001, 002, ...
    PADDED_NUM=$(printf "%03d" $i)
    REPO_NAME="images-repo-$PADDED_NUM"
    echo -e "${YELLOW}尝试检查仓库 $REPO_NAME 是否存在...${NC}"
    
    # 使用GitHub API检查仓库是否存在
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token $GITHUB_TOKEN" \
      "https://api.github.com/repos/$GITHUB_OWNER/$REPO_NAME")
    
    if [ "$HTTP_CODE" == "200" ]; then
      echo -e "${GREEN}发现仓库: $REPO_NAME${NC}"
      REPO_LIST="$REPO_LIST $REPO_NAME"
    else
      echo -e "${YELLOW}仓库 $REPO_NAME 不存在或无法访问，停止查找更多仓库${NC}"
      break
    fi
  done
  
  # 如果没有找到任何三位数字格式的仓库，尝试查找旧格式的仓库（为了向后兼容）
  if [ "$REPO_LIST" == "images-repo-001" ] && [ "$HTTP_CODE" != "200" ]; then
    echo -e "${YELLOW}未找到三位数字格式的仓库，尝试查找旧格式仓库...${NC}"
    REPO_LIST=""
    
    for i in {1..10}; do
      REPO_NAME="images-repo-$i"
      echo -e "${YELLOW}尝试检查旧格式仓库 $REPO_NAME 是否存在...${NC}"
      
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token $GITHUB_TOKEN" \
        "https://api.github.com/repos/$GITHUB_OWNER/$REPO_NAME")
      
      if [ "$HTTP_CODE" == "200" ]; then
        echo -e "${GREEN}发现旧格式仓库: $REPO_NAME${NC}"
        REPO_LIST="$REPO_LIST $REPO_NAME"
      else
        echo -e "${YELLOW}旧格式仓库 $REPO_NAME 不存在或无法访问，停止查找更多仓库${NC}"
        break
      fi
    done
    
    # 如果仍然没有找到任何仓库，使用默认值
    if [ -z "$REPO_LIST" ]; then
      echo -e "${YELLOW}未找到任何可用仓库，使用默认值 images-repo-001${NC}"
      REPO_LIST="images-repo-001"
    fi
  fi
fi

echo -e "${GREEN}将处理以下仓库:${NC}"
for REPO in $REPO_LIST; do
  echo -e "  - $REPO"
done

# 克隆并合并所有图片仓库的内容
for REPO in $REPO_LIST; do
  echo -e "${BLUE}----------------------------------------${NC}"
  echo -e "${GREEN}处理仓库: $REPO${NC}"
  
  # 克隆仓库
  echo -e "${YELLOW}正在克隆 $GITHUB_OWNER/$REPO...${NC}"
  git clone --depth=1 https://$GITHUB_TOKEN@github.com/$GITHUB_OWNER/$REPO.git $TEMP_DIR/$REPO
  
  if [ $? -ne 0 ]; then
    echo -e "${RED}克隆仓库 $GITHUB_OWNER/$REPO 失败，跳过此仓库${NC}"
    continue
  fi
  
  # 检查public/images目录是否存在
  if [ -d "$TEMP_DIR/$REPO/public/images" ]; then
    echo -e "${GREEN}找到图片目录，正在复制内容...${NC}"
    
    # 复制图片内容到主项目
    cp -r $TEMP_DIR/$REPO/public/images/* ./public/images/ 2>/dev/null || true
    
    if [ $? -eq 0 ]; then
      echo -e "${GREEN}成功复制 $REPO 中的图片内容${NC}"
    else
      echo -e "${RED}复制 $REPO 中的图片内容失败${NC}"
    fi
    
    # 统计此仓库中的图片数量
    REPO_IMAGE_COUNT=$(find $TEMP_DIR/$REPO/public/images -type f | wc -l)
    echo -e "${GREEN}仓库 $REPO 中包含 $REPO_IMAGE_COUNT 个图片文件${NC}"
  else
    echo -e "${YELLOW}仓库 $REPO 中没有找到 public/images 目录，跳过${NC}"
  fi
  
  # 清理临时目录，减少磁盘空间使用
  rm -rf $TEMP_DIR/$REPO
done

# 显示合并后的图片统计信息
IMAGE_COUNT=$(find ./public/images -type f | wc -l)
echo -e "${BLUE}----------------------------------------${NC}"
echo -e "${GREEN}图片合并完成，共计 $IMAGE_COUNT 个文件${NC}"

# 清理临时目录
rm -rf $TEMP_DIR

echo -e "${BLUE}=========================================${NC}"
echo -e "${GREEN}多仓库内容合并部署脚本执行完成${NC}"
echo -e "${BLUE}=========================================${NC}"

# 脚本执行成功
exit 0 
