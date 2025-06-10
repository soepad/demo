// 全局变量
let currentPage = 1;
let selectedImages = new Set();
let categories = [];
let tags = [];

// DOM 元素
const imageGrid = document.getElementById('imageGrid');
const pagination = document.getElementById('pagination');
const searchInput = document.getElementById('search');
const searchBtn = document.getElementById('searchBtn');
const categoryFilter = document.getElementById('categoryFilter');
const tagFilter = document.getElementById('tagFilter');
const sortFilter = document.getElementById('sortFilter');
const batchUpdateBtn = document.getElementById('batchUpdateBtn');
const batchDeleteBtn = document.getElementById('batchDeleteBtn');
const previewModal = document.getElementById('previewModal');
const batchUpdateModal = document.getElementById('batchUpdateModal');
const batchDeleteModal = document.getElementById('batchDeleteModal');

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    await loadCategories();
    await loadTags();
    await loadImages();
    setupEventListeners();
});

// 加载分类列表
async function loadCategories() {
    try {
        const response = await fetch('/api/admin/categories');
        if (!response.ok) throw new Error('获取分类列表失败');
        
        categories = await response.json();
        
        // 更新分类选择器
        const categoryOptions = categories.map(category => 
            `<option value="${category.id}">${category.name}</option>`
        ).join('');
        
        categoryFilter.innerHTML = '<option value="">所有分类</option>' + categoryOptions;
        document.getElementById('previewCategory').innerHTML = '<option value="">选择分类</option>' + categoryOptions;
        document.getElementById('batchCategory').innerHTML = '<option value="">选择分类</option>' + categoryOptions;
    } catch (error) {
        showToast('获取分类列表失败', 'error');
    }
}

// 加载标签列表
async function loadTags() {
    try {
        const response = await fetch('/api/admin/tags');
        if (!response.ok) throw new Error('获取标签列表失败');
        
        tags = await response.json();
        
        // 更新标签选择器
        const tagOptions = tags.map(tag => 
            `<option value="${tag.id}">${tag.name}</option>`
        ).join('');
        
        tagFilter.innerHTML = '<option value="">所有标签</option>' + tagOptions;
    } catch (error) {
        showToast('获取标签列表失败', 'error');
    }
}

// 加载图片列表
async function loadImages() {
    try {
        const search = searchInput.value;
        const category = categoryFilter.value;
        const tag = tagFilter.value;
        const sort = sortFilter.value;
        
        const queryParams = new URLSearchParams({
            page: currentPage,
            search,
            category,
            tag,
            sort
        });
        
        const response = await fetch(`/api/admin/images?${queryParams}`);
        if (!response.ok) throw new Error('获取图片列表失败');
        
        const data = await response.json();
        renderImages(data.images);
        renderPagination(data.total_pages, data.current_page);
    } catch (error) {
        showToast('获取图片列表失败', 'error');
    }
}

// 渲染图片列表
function renderImages(images) {
    imageGrid.innerHTML = images.map(image => `
        <div class="image-item" data-id="${image.id}">
            <div class="image-preview">
                <img src="${image.url}" alt="${image.filename}" loading="lazy">
                <input type="checkbox" class="image-checkbox" ${selectedImages.has(image.id) ? 'checked' : ''}>
            </div>
            <div class="image-info">
                <h3>${image.filename}</h3>
                <div class="image-meta">
                    <p>上传时间：${new Date(image.created_at).toLocaleString()}</p>
                    <p>访问次数：${image.views}</p>
                    <p>文件大小：${formatSize(image.size)}</p>
                    ${image.category_name ? `<p>分类：${image.category_name}</p>` : ''}
                </div>
                ${image.tags && image.tags.length > 0 ? `
                    <div class="image-tags">
                        ${image.tags.map(tag => `<span class="image-tag">${tag}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        </div>
    `).join('');
    
    // 添加点击事件
    document.querySelectorAll('.image-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.classList.contains('image-checkbox')) {
                const imageId = item.dataset.id;
                showImagePreview(imageId);
            }
        });
    });
    
    // 添加复选框事件
    document.querySelectorAll('.image-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            const imageId = parseInt(e.target.closest('.image-item').dataset.id);
            if (e.target.checked) {
                selectedImages.add(imageId);
            } else {
                selectedImages.delete(imageId);
            }
            updateBatchButtons();
        });
    });
}

// 渲染分页控件
function renderPagination(totalPages, currentPage) {
    const pages = [];
    
    // 上一页
    pages.push(`
        <button ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(${currentPage - 1})">
            上一页
        </button>
    `);
    
    // 页码
    for (let i = 1; i <= totalPages; i++) {
        if (
            i === 1 || // 第一页
            i === totalPages || // 最后一页
            (i >= currentPage - 2 && i <= currentPage + 2) // 当前页附近的页码
        ) {
            pages.push(`
                <button class="${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">
                    ${i}
                </button>
            `);
        } else if (
            i === currentPage - 3 || // 当前页前省略号
            i === currentPage + 3 // 当前页后省略号
        ) {
            pages.push('<span>...</span>');
        }
    }
    
    // 下一页
    pages.push(`
        <button ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(${currentPage + 1})">
            下一页
        </button>
    `);
    
    pagination.innerHTML = pages.join('');
}

// 显示图片预览
async function showImagePreview(imageId) {
    try {
        const response = await fetch(`/api/admin/images/${imageId}`);
        if (!response.ok) throw new Error('获取图片信息失败');
        
        const image = await response.json();
        
        // 更新预览模态框内容
        document.getElementById('previewImage').src = image.url;
        document.getElementById('previewFilename').textContent = image.filename;
        document.getElementById('previewUploadTime').textContent = new Date(image.created_at).toLocaleString();
        document.getElementById('previewViews').textContent = image.views;
        document.getElementById('previewSize').textContent = formatSize(image.size);
        document.getElementById('previewCategory').value = image.category_id || '';
        document.getElementById('previewTags').value = image.tags ? image.tags.join(', ') : '';
        
        // 更新链接
        document.getElementById('previewUrl').value = image.url;
        document.getElementById('previewMarkdown').value = `![${image.filename}](${image.url})`;
        document.getElementById('previewHtml').value = `<img src="${image.url}" alt="${image.filename}">`;
        document.getElementById('previewBbcode').value = `[img]${image.url}[/img]`;
        
        // 显示模态框
        previewModal.style.display = 'block';
        
        // 保存当前图片ID
        previewModal.dataset.imageId = imageId;
    } catch (error) {
        showToast('获取图片信息失败', 'error');
    }
}

// 保存图片更改
async function saveImageChanges() {
    const imageId = previewModal.dataset.imageId;
    const categoryId = document.getElementById('previewCategory').value;
    const tags = document.getElementById('previewTags').value
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag);
    
    try {
        const response = await fetch(`/api/admin/images/${imageId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                category_id: categoryId || null,
                tags
            })
        });
        
        if (!response.ok) throw new Error('保存更改失败');
        
        showToast('保存成功', 'success');
        previewModal.style.display = 'none';
        loadImages();
    } catch (error) {
        showToast('保存更改失败', 'error');
    }
}

// 删除图片
async function deleteImage() {
    const imageId = previewModal.dataset.imageId;
    
    try {
        const response = await fetch(`/api/admin/images/${imageId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) throw new Error('删除图片失败');
        
        showToast('删除成功', 'success');
        previewModal.style.display = 'none';
        loadImages();
    } catch (error) {
        showToast('删除图片失败', 'error');
    }
}

// 批量更新分类
async function batchUpdateCategory() {
    const categoryId = document.getElementById('batchCategory').value;
    if (!categoryId) {
        showToast('请选择分类', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/admin/images/batch-update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image_ids: Array.from(selectedImages),
                category_id: categoryId
            })
        });
        
        if (!response.ok) throw new Error('批量更新失败');
        
        showToast('更新成功', 'success');
        batchUpdateModal.style.display = 'none';
        selectedImages.clear();
        updateBatchButtons();
        loadImages();
    } catch (error) {
        showToast('批量更新失败', 'error');
    }
}

// 批量删除图片
async function batchDeleteImages() {
    try {
        const response = await fetch('/api/admin/images/batch-delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image_ids: Array.from(selectedImages)
            })
        });
        
        if (!response.ok) throw new Error('批量删除失败');
        
        showToast('删除成功', 'success');
        batchDeleteModal.style.display = 'none';
        selectedImages.clear();
        updateBatchButtons();
        loadImages();
    } catch (error) {
        showToast('批量删除失败', 'error');
    }
}

// 更新批量操作按钮状态
function updateBatchButtons() {
    const hasSelection = selectedImages.size > 0;
    batchUpdateBtn.disabled = !hasSelection;
    batchDeleteBtn.disabled = !hasSelection;
}

// 设置事件监听器
function setupEventListeners() {
    // 搜索
    searchBtn.addEventListener('click', () => {
        currentPage = 1;
        loadImages();
    });
    
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            currentPage = 1;
            loadImages();
        }
    });
    
    // 筛选器
    categoryFilter.addEventListener('change', () => {
        currentPage = 1;
        loadImages();
    });
    
    tagFilter.addEventListener('change', () => {
        currentPage = 1;
        loadImages();
    });
    
    sortFilter.addEventListener('change', () => {
        currentPage = 1;
        loadImages();
    });
    
    // 模态框关闭按钮
    document.querySelectorAll('.close').forEach(closeBtn => {
        closeBtn.addEventListener('click', () => {
            closeBtn.closest('.modal').style.display = 'none';
        });
    });
    
    // 点击模态框外部关闭
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            e.target.style.display = 'none';
        }
    });
    
    // 预览模态框操作
    document.getElementById('saveChanges').addEventListener('click', saveImageChanges);
    document.getElementById('deleteImage').addEventListener('click', deleteImage);
    
    // 批量操作
    batchUpdateBtn.addEventListener('click', () => {
        batchUpdateModal.style.display = 'block';
    });
    
    batchDeleteBtn.addEventListener('click', () => {
        batchDeleteModal.style.display = 'block';
    });
    
    document.getElementById('confirmBatchUpdate').addEventListener('click', batchUpdateCategory);
    document.getElementById('confirmBatchDelete').addEventListener('click', batchDeleteImages);
    
    document.getElementById('cancelBatchUpdate').addEventListener('click', () => {
        batchUpdateModal.style.display = 'none';
    });
    
    document.getElementById('cancelBatchDelete').addEventListener('click', () => {
        batchDeleteModal.style.display = 'none';
    });
    
    // 复制链接
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = e.target.dataset.target;
            const input = document.getElementById(targetId);
            input.select();
            document.execCommand('copy');
            showToast('复制成功', 'success');
        });
    });
}

// 工具函数
function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// 全局函数
function changePage(page) {
    currentPage = page;
    loadImages();
} 