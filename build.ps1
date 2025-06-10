# PowerShell构建脚本 - 用于在Windows环境中克隆和合并所有图片仓库的内容
# 此脚本可在本地Windows环境或Cloudflare Pages构建环境中运行

Write-Host "=========================================" -ForegroundColor Blue
Write-Host "开始执行多仓库内容合并部署脚本" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Blue

# 检查环境变量
if (-not $env:GITHUB_TOKEN) {
    Write-Host "错误: 缺少GITHUB_TOKEN环境变量" -ForegroundColor Red
    Write-Host "请在Cloudflare Pages的环境变量中设置GITHUB_TOKEN" -ForegroundColor Yellow
    exit 1
}

if (-not $env:GITHUB_OWNER) {
    Write-Host "错误: 缺少GITHUB_OWNER环境变量" -ForegroundColor Red
    Write-Host "请在Cloudflare Pages的环境变量中设置GITHUB_OWNER" -ForegroundColor Yellow
    exit 1
}

# 创建临时目录用于克隆仓库
$TEMP_DIR = "./temp_repos"
New-Item -ItemType Directory -Force -Path $TEMP_DIR | Out-Null

# 确保public/images目录存在
New-Item -ItemType Directory -Force -Path "./public/images" | Out-Null

Write-Host "准备处理图片仓库..." -ForegroundColor Green

# 由于无法在构建环境中直接访问D1数据库，我们使用预定义的仓库列表
# 可以通过REPOS环境变量自定义仓库列表，格式为逗号分隔的仓库名称
$REPO_LIST = @()
if ($env:REPOS) {
    Write-Host "使用环境变量REPOS中的仓库列表" -ForegroundColor Green
    $REPO_LIST = $env:REPOS -split ','
} else {
    # 默认仓库列表
    Write-Host "未指定REPOS环境变量，将使用默认仓库列表" -ForegroundColor Yellow
    $REPO_LIST = @("images-repo-1")
    
    # 尝试查找更多可能的仓库（基于命名模式）
    for ($i = 2; $i -le 10; $i++) {
        $REPO_NAME = "images-repo-$i"
        Write-Host "尝试检查仓库 $REPO_NAME 是否存在..." -ForegroundColor Yellow
        
        try {
            # 使用GitHub API检查仓库是否存在
            $headers = @{
                'Authorization' = "token $env:GITHUB_TOKEN"
                'Accept' = 'application/vnd.github.v3+json'
            }
            
            $response = Invoke-WebRequest -Uri "https://api.github.com/repos/$env:GITHUB_OWNER/$REPO_NAME" -Headers $headers -UseBasicParsing -ErrorAction SilentlyContinue
            
            if ($response.StatusCode -eq 200) {
                Write-Host "发现仓库: $REPO_NAME" -ForegroundColor Green
                $REPO_LIST += $REPO_NAME
            }
        } catch {
            Write-Host "仓库 $REPO_NAME 不存在或无法访问，停止查找更多仓库" -ForegroundColor Yellow
            break
        }
    }
}

Write-Host "将处理以下仓库:" -ForegroundColor Green
foreach ($REPO in $REPO_LIST) {
    Write-Host "  - $REPO"
}

# 克隆并合并所有图片仓库的内容
foreach ($REPO in $REPO_LIST) {
    Write-Host "----------------------------------------" -ForegroundColor Blue
    Write-Host "处理仓库: $REPO" -ForegroundColor Green
    
    # 克隆仓库
    Write-Host "正在克隆 $env:GITHUB_OWNER/$REPO..." -ForegroundColor Yellow
    
    try {
        git clone --depth=1 "https://$env:GITHUB_TOKEN@github.com/$env:GITHUB_OWNER/$REPO.git" "$TEMP_DIR/$REPO"
        
        # 检查public/images目录是否存在
        if (Test-Path "$TEMP_DIR/$REPO/public/images") {
            Write-Host "找到图片目录，正在复制内容..." -ForegroundColor Green
            
            # 复制图片内容到主项目
            Copy-Item -Path "$TEMP_DIR/$REPO/public/images/*" -Destination "./public/images/" -Recurse -Force -ErrorAction SilentlyContinue
            
            Write-Host "成功复制 $REPO 中的图片内容" -ForegroundColor Green
            
            # 统计此仓库中的图片数量
            $REPO_IMAGE_COUNT = (Get-ChildItem -Path "$TEMP_DIR/$REPO/public/images" -Recurse -File | Measure-Object).Count
            Write-Host "仓库 $REPO 中包含 $REPO_IMAGE_COUNT 个图片文件" -ForegroundColor Green
        } else {
            Write-Host "仓库 $REPO 中没有找到 public/images 目录，跳过" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "克隆或处理仓库 $env:GITHUB_OWNER/$REPO 失败，跳过此仓库" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
    } finally {
        # 清理临时目录，减少磁盘空间使用
        if (Test-Path "$TEMP_DIR/$REPO") {
            Remove-Item -Path "$TEMP_DIR/$REPO" -Recurse -Force
        }
    }
}

# 显示合并后的图片统计信息
$IMAGE_COUNT = (Get-ChildItem -Path "./public/images" -Recurse -File | Measure-Object).Count
Write-Host "----------------------------------------" -ForegroundColor Blue
Write-Host "图片合并完成，共计 $IMAGE_COUNT 个文件" -ForegroundColor Green

# 清理临时目录
Remove-Item -Path $TEMP_DIR -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "=========================================" -ForegroundColor Blue
Write-Host "多仓库内容合并部署脚本执行完成" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Blue

# 脚本执行成功
exit 0 
