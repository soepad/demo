/**
 * 分块上传组件 - 能够处理大文件，避免CloudFlare CPU超时
 */

// 检查是否已经定义了原始控制台引用，避免重复定义
if (!window.originalConsole) {
  window.originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };
  
  // 创建自定义控制台处理器
  function setupConsoleHandling() {
    // 检查调试模式
    const isDebugMode = localStorage.getItem('debugMode') === 'true' || 
                       new URLSearchParams(window.location.search).has('debug');
    
    // 重写控制台方法
    console.log = function(...args) {
      if (isDebugMode) {
        window.originalConsole.log.apply(console, args);
      }
    };
    
    console.info = function(...args) {
      if (isDebugMode) {
        window.originalConsole.info.apply(console, args);
      }
    };
    
    console.warn = function(...args) {
      if (isDebugMode) {
        window.originalConsole.warn.apply(console, args);
      }
    };
    
    console.debug = function(...args) {
      if (isDebugMode) {
        window.originalConsole.debug.apply(console, args);
      }
    };
    
    // 错误日志始终保留，不受调试模式影响
    console.error = function(...args) {
      window.originalConsole.error.apply(console, args);
    };
  }
  
  // 初始化控制台处理
  setupConsoleHandling();
}

class ChunkedUploader {
  constructor(file, options = {}) {
    // 文件信息
    this.file = file;
    this.fileName = options.fileName || file.name;
    
    // 分块设置
    this.chunkSize = options.chunkSize || 5 * 1024 * 1024; // 默认5MB分块
    this.totalChunks = Math.ceil(file.size / this.chunkSize);
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.uploadedChunks = [];
    
    // 状态
    this.status = 'ready'; // ready, uploading, paused, completed, error
    this.error = null;
    this.progress = 0;
    this.uploadStartTime = null;
    this.uploadSpeed = 0;
    this.remainingTime = 0;
    
    // 是否跳过部署
    this.skipDeploy = options.skipDeploy || false;
    
    // 回调
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    // 初始化分块
    this._initChunks();
  }
  
  /**
   * 初始化文件分块
   */
  _initChunks() {
    this.chunks = [];
    
    for (let i = 0; i < this.totalChunks; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, this.file.size);
      
      this.chunks.push({
        index: i,
        start: start,
        end: end,
        size: end - start,
        blob: this.file.slice(start, end),
        status: 'pending', // pending, uploading, uploaded, error
        uploadedAt: null,
        retries: 0,
        error: null
      });
    }
  }
  
  /**
   * 开始上传
   */
  async start() {
    if (this.status === 'uploading') {
      return;
    }
    
    this._setStatus('uploading');
    this.uploadStartTime = Date.now();
    this.currentChunkIndex = 0;
    
    // 首先创建上传会话
    try {
      await this._createUploadSession();
      await this._uploadNextChunk();
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * 创建上传会话
   */
  async _createUploadSession() {
    try {
      const response = await fetch('/api/upload?action=create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: this.fileName,
          fileSize: this.file.size,
          totalChunks: this.totalChunks,
          mimeType: this.file.type
        })
      });
      
      const responseText = await response.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        throw new Error(`创建上传会话失败: 无效的响应格式 - ${responseText}`);
      }
      
      if (!response.ok) {
        // 处理特定类型的错误
        if (response.status === 409) {
          throw new Error(`文件 "${this.fileName}" 已存在，请重命名后重试`);
        } else if (response.status === 403) {
          // 明确处理游客上传禁用的情况
          if (result.error && result.error.includes('游客上传已禁用')) {
            throw new Error('游客上传已禁用，请登录后再试');
          } else {
            throw new Error('您没有权限上传文件');
          }
        } else {
          throw new Error(result.error || `创建上传会话失败: ${response.status}`);
        }
      }
      
      this.sessionId = result.sessionId;
      
      if (!this.sessionId) {
        throw new Error('服务器未返回有效的会话ID');
      }
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * 上传下一个分块
   */
  async _uploadNextChunk() {
    if (this.status !== 'uploading') {
      return;
    }
    
    if (this.currentChunkIndex >= this.totalChunks) {
      await this._completeUpload();
      return;
    }
    
    const chunk = this.chunks[this.currentChunkIndex];
    chunk.status = 'uploading';
    
    try {
      // 准备上传数据
      const formData = new FormData();
      formData.append('chunk', chunk.blob);
      formData.append('sessionId', this.sessionId);
      formData.append('chunkIndex', chunk.index);
      formData.append('totalChunks', this.totalChunks);
      
      // 上传分块
      const response = await fetch('/api/upload?action=chunk', {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        let errorText = await response.text();
        try {
          const errorJson = JSON.parse(errorText);
          errorText = errorJson.error || errorText;
        } catch (e) {}
        throw new Error(`上传分块失败: ${errorText}`);
      }
      
      // 处理成功的分块上传
      chunk.status = 'uploaded';
      chunk.uploadedAt = Date.now();
      this.uploadedChunks.push(chunk.index);
      
      // 更新进度
      this._updateProgress();
      
      // 继续上传下一个分块
      this.currentChunkIndex++;
      await this._uploadNextChunk();
      
    } catch (error) {
      // 处理分块上传错误
      chunk.status = 'error';
      chunk.error = error.message;
      
      if (chunk.retries < 3) {
        // 重试
        chunk.retries++;
        console.log(`分块 ${chunk.index} 上传失败，正在重试 (${chunk.retries}/3)...`);
        setTimeout(() => this._uploadNextChunk(), 1000);
      } else {
        this._handleError(new Error(`分块 ${chunk.index} 上传失败，超过最大重试次数`));
      }
    }
  }
  
  /**
   * 完成上传过程
   */
  async _completeUpload() {
    try {
      const response = await fetch('/api/upload?action=complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          fileName: this.fileName,
          fileSize: this.file.size,
          mimeType: this.file.type,
          skipDeploy: this.skipDeploy
        })
      });
      
      const responseText = await response.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        throw new Error(`完成上传失败: 无效的响应格式 - ${responseText}`);
      }
      
      if (!response.ok) {
        // 处理特定类型的错误
        if (response.status === 409) {
          throw new Error(`文件 "${this.fileName}" 已存在，请重命名后重试`);
        } else {
          throw new Error(result.error || `完成上传失败: ${response.status}`);
        }
      }
      
      this._setStatus('completed');
      this.onComplete(result);
      
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * 更新上传进度
   */
  _updateProgress() {
    const uploadedSize = this.uploadedChunks.reduce((total, index) => {
      return total + this.chunks[index].size;
    }, 0);
    
    this.progress = Math.round((uploadedSize / this.file.size) * 100) / 100;
    
    // 计算上传速度
    const elapsedSeconds = (Date.now() - this.uploadStartTime) / 1000;
    if (elapsedSeconds > 0) {
      this.uploadSpeed = uploadedSize / elapsedSeconds;
      
      // 计算剩余时间
      const remainingBytes = this.file.size - uploadedSize;
      if (this.uploadSpeed > 0) {
        this.remainingTime = remainingBytes / this.uploadSpeed;
      }
    }
    
    this.onProgress({
      progress: this.progress,
      uploadedSize: uploadedSize,
      totalSize: this.file.size,
      speed: this.uploadSpeed,
      remainingTime: this.remainingTime
    });
  }
  
  /**
   * 处理错误
   */
  _handleError(error) {
    // 如果错误是从API返回的，保留详细信息
    if (typeof error === 'object' && error.error && error.details) {
      // 已经是有结构的错误对象，直接使用
      this.error = error;
    } else if (error instanceof Error) {
      // 如果是标准Error对象，保留它
      this.error = error;
      
      // 尝试从错误消息中提取更多信息
      if (error.message.includes('已存在')) {
        // 处理文件已存在的情况
        this.error.details = '文件已存在，请重命名后重试';
        this.error.status = 409;
      } else if (error.message.includes('游客上传已禁用') || error.message.includes('没有权限上传')) {
        // 处理权限错误
        this.error.details = '请登录后再试';
        this.error.status = 403;
      }
    } else if (typeof error === 'string') {
      // 如果是字符串，转换为Error对象
      this.error = new Error(error);
      
      // 检查权限相关错误
      if (error.includes('游客上传已禁用') || error.includes('没有权限')) {
        this.error.details = '请登录后再试';
        this.error.status = 403;
      }
    } else {
      // 其他情况，创建一个新的Error对象
      try {
        const errorMessage = error.message || JSON.stringify(error) || '未知错误';
        this.error = new Error(errorMessage);
        this.error.details = error.details || JSON.stringify(error);
        
        // 检查状态码
        if (error.status === 403) {
          this.error.details = '没有上传权限，请登录后再试';
        }
      } catch (e) {
        this.error = new Error('发生未知错误');
      }
    }
    
    this._setStatus('error');
    this.onError(this.error);
  }
  
  /**
   * 设置上传状态
   */
  _setStatus(status) {
    this.status = status;
    this.onStatusChange(status);
  }
  
  /**
   * 暂停上传
   */
  pause() {
    if (this.status === 'uploading') {
      this._setStatus('paused');
    }
  }
  
  /**
   * 恢复上传
   */
  resume() {
    if (this.status === 'paused') {
      this._setStatus('uploading');
      this._uploadNextChunk();
    }
  }
  
  /**
   * 取消上传
   */
  cancel() {
    this._setStatus('cancelled');
    
    if (this.sessionId) {
      fetch('/api/upload?action=cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId })
      }).catch(console.error);
    }
  }
}

// 导出上传组件
window.ChunkedUploader = ChunkedUploader; 
