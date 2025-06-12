import { Octokit } from 'octokit';
import { v4 as uuidv4 } from 'uuid';
import { 
  getActiveRepository, 
  checkRepositorySpaceAndAllocate, 
  updateRepositorySizeEstimate,
  triggerAllRepositoriesDeployHooks
} from './repository-manager.js';

// 保存上传会话的临时内存存储
// 注意：这种方法在多实例环境中不可靠，生产环境应使用持久化存储
const uploadSessions = new Map();

// 每个会话的分块数据
const sessionChunks = new Map();

// 每个会话的过期时间 - 10分钟后自动清理
const sessionExpiry = new Map();

// 过期时间设定（毫秒）
const SESSION_EXPIRY_TIME = 10 * 60 * 1000; // 10分钟

// CORS头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 清理过期会话的函数
function cleanupExpiredSessions() {
  const now = Date.now();
  
  for (const [sessionId, expiry] of sessionExpiry.entries()) {
    if (now > expiry) {
      // 清理过期会话
      uploadSessions.delete(sessionId);
      sessionChunks.delete(sessionId);
      sessionExpiry.delete(sessionId);
      console.log(`已清理过期会话: ${sessionId}`);
    }
  }
}

// 获取北京时间的日期字符串 (YYYY/MM/DD)
function getBeijingDatePath() {
  // 获取当前UTC时间
  const now = new Date();
  
  // 转换为北京时间（UTC+8）
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  
  // 格式化为 YYYY/MM/DD
  const year = beijingTime.getFullYear();
  const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getDate()).padStart(2, '0');
  
  return `${year}/${month}/${day}`;
}

// 将 ArrayBuffer 转换为 Base64 的安全方法，避免栈溢出
function arrayBufferToBase64(buffer) {
  // 对于大文件，分块处理
  const CHUNK_SIZE = 32768; // 32KB 分块
  let binary = '';
  
  // 创建一个 Uint8Array 视图来访问 buffer
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  
  // 分块处理，避免栈溢出
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, Math.min(i + CHUNK_SIZE, len));
    const array = Array.from(chunk);
    binary += String.fromCharCode.apply(null, array);
  }
  
  return btoa(binary);
}

// 导入或定义triggerDeployHook函数
/**
 * 触发Cloudflare Pages部署钩子
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} - 返回部署结果
 */
async function triggerDeployHook(env) {
  // 使用新的多仓库部署钩子触发器
  return triggerAllRepositoriesDeployHooks(env);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // 使用查询参数确定操作类型，而不是路径
  const action = url.searchParams.get('action');
  
  console.log('处理请求路径:', url.pathname, '操作:', action);
  
  // 每次请求时清理过期会话
  cleanupExpiredSessions();
  
  // 处理OPTIONS请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  
  // 检查是否允许游客上传
  const allowGuestUpload = await checkGuestUpload(env);
  const isAuthenticated = await checkAuthentication(request, env);
  
  if (!isAuthenticated && !allowGuestUpload) {
    return new Response(JSON.stringify({
      success: false,
      error: '游客上传已禁用'
    }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
  
  // 处理后台直接上传（非分块）
  if (action === 'upload' && request.method === 'POST') {
    try {
      // 解析表单数据
      const formData = await request.formData();
      const file = formData.get('file');
      const skipDeploy = formData.get('skipDeploy') === 'true';
      
      console.log(`接收到直接上传请求: 文件=${file.name}, 大小=${file.size}字节, 是否跳过部署=${skipDeploy}`);
      
      if (!file) {
        return new Response(JSON.stringify({
          success: false,
          error: '未找到上传文件'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 验证文件类型
      if (!file.type.startsWith('image/')) {
        return new Response(JSON.stringify({
          success: false,
          error: '仅支持上传图片文件'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 读取文件内容
      const fileBuffer = await file.arrayBuffer();
      const base64Data = arrayBufferToBase64(fileBuffer);
      
      // 检查并分配仓库空间
      const allocation = await checkRepositorySpaceAndAllocate(env, file.size);
      
      if (!allocation.canUpload) {
        return new Response(JSON.stringify({
          success: false,
          error: '无法分配足够的存储空间: ' + allocation.error
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 使用分配的仓库
      const { repository } = allocation;
      
      // 使用GitHub API上传文件
      const octokit = new Octokit({
        auth: repository.token
      });
      
      // 获取北京时间的日期路径
      const datePath = getBeijingDatePath();
      
      // 使用原始文件名
      const fileName = file.name;
      
      // 构建完整路径：public/images/年/月/日/文件名
      const filePath = `public/images/${datePath}/${fileName}`;
      
      console.log(`后台直接上传文件到GitHub仓库 ${repository.repo}: ${filePath}`);
      
      // 检查文件是否已存在
      try {
        const fileExists = await octokit.rest.repos.getContent({
          owner: repository.owner,
          repo: repository.repo,
          path: filePath,
          ref: 'main'
        });
        
        // 如果没有抛出错误，说明文件存在
        return new Response(JSON.stringify({
          success: false,
          error: `文件 "${fileName}" 已存在，请重命名后重试`,
          details: 'File already exists'
        }), {
          status: 409, // 明确返回409冲突状态码
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (existingFileError) {
        // 如果是404错误，说明文件不存在，可以继续上传
        if (existingFileError.status !== 404) {
          // 如果是其他错误，记录下来，但继续尝试上传
          console.warn('检查文件是否存在时出错:', existingFileError);
        }
      }
      
      // 上传到GitHub
      const response = await octokit.rest.repos.createOrUpdateFileContents({
        owner: repository.owner,
        repo: repository.repo,
        path: filePath,
        message: `Upload ${fileName} (${datePath})`,
        content: base64Data,
        branch: 'main'
      });
      
      console.log(`文件上传到GitHub成功，SHA: ${response.data.content.sha}`);
      
      // 更新仓库大小估算
      await updateRepositorySizeEstimate(env, repository.id, file.size);
      
      // 保存到数据库 - 使用北京时间而不是UTC时间
      try {
        // 获取当前北京时间的格式字符串
        const now = new Date();
        const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        
        // 使用getUTC*方法正确格式化北京时间
        const beijingYear = beijingTime.getUTCFullYear();
        const beijingMonth = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
        const beijingDay = String(beijingTime.getUTCDate()).padStart(2, '0');
        const beijingHour = String(beijingTime.getUTCHours()).padStart(2, '0');
        const beijingMinute = String(beijingTime.getUTCMinutes()).padStart(2, '0');
        const beijingSecond = String(beijingTime.getUTCSeconds()).padStart(2, '0');
        const beijingTimeString = `${beijingYear}-${beijingMonth}-${beijingDay} ${beijingHour}:${beijingMinute}:${beijingSecond}`;
        
        await env.DB.prepare(`
          INSERT INTO images (filename, size, mime_type, github_path, sha, created_at, updated_at, repository_id)
          VALUES (?, ?, ?, ?, ?, datetime(?), datetime(?), ?)
        `).bind(
          fileName,
          file.size,
          file.type,
          filePath,
          response.data.content.sha,
          beijingTimeString,
          beijingTimeString,
          repository.id
        ).run();
        
        console.log(`文件信息已保存到数据库，上传时间(北京): ${beijingTimeString}`);
      } catch (dbError) {
        console.error('数据库保存失败:', dbError);
        // 继续执行，不因为数据库错误而中断响应
      }
      
      // 只有在不跳过部署的情况下才触发部署钩子
      if (!skipDeploy) {
        // GitHub API已经确认文件上传成功，可以立即触发部署
        console.log('GitHub已确认文件上传成功，触发Cloudflare Pages部署钩子');
        const deployResult = await triggerDeployHook(env);
        if (deployResult.success) {
          console.log('图片上传后部署已成功触发');
        } else {
          console.error('图片上传后部署失败:', deployResult.error);
        }
      } else {
        console.log('根据请求参数跳过触发部署，这不是最后一个文件');
      }
      
      // 返回链接信息
      const imageUrl = `${env.SITE_URL}/images/${datePath}/${fileName}`;
      return new Response(JSON.stringify({
        success: true,
        data: {
          url: imageUrl,
          markdown: `![${fileName}](${imageUrl})`,
          html: `<img src="${imageUrl}" alt="${fileName}">`,
          bbcode: `[img]${imageUrl}[/img]`
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('直接上传失败:', error);
      
      // 处理特定类型的错误
      if (error.message && error.message.includes('already exists')) {
        // 文件已存在冲突
        return new Response(JSON.stringify({
          success: false,
          error: `文件 "${file.name}" 已存在，请重命名后重试`,
          details: 'File already exists'
        }), {
          status: 409, // 明确返回409冲突状态码
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } else if (error.status === 403 || error.status === 401) {
        // 权限不足
        return new Response(JSON.stringify({
          success: false,
          error: 'GitHub授权失败，请检查Token是否正确',
          message: error.message,
          details: {
            stack: error.stack,
            env: {
              hasToken: !!env.GITHUB_TOKEN
            }
          }
        }), {
          status: error.status,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 其他错误
      return new Response(JSON.stringify({
        success: false,
        error: '上传失败',
        message: error.message,
        details: {
          stack: error.stack,
          env: {
            hasToken: !!env.GITHUB_TOKEN,
            hasOwner: !!env.GITHUB_OWNER,
            hasRepo: !!env.GITHUB_REPO,
            hasDB: !!env.DB
          }
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 创建上传会话
  if (action === 'create-session' && request.method === 'POST') {
    try {
      const { fileName, fileSize, totalChunks, mimeType } = await request.json();
      
      // 验证必要参数
      if (!fileName || !fileSize || !totalChunks || !mimeType) {
        return new Response(JSON.stringify({
          success: false,
          error: '缺少必要参数'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 验证文件类型
      if (!mimeType.startsWith('image/')) {
        return new Response(JSON.stringify({
          success: false,
          error: '仅支持上传图片文件'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 生成会话ID
      const sessionId = uuidv4();
      
      // 存储会话信息
      uploadSessions.set(sessionId, {
        fileName,
        fileSize,
        totalChunks,
        mimeType,
        uploadedChunks: 0,
        createdAt: Date.now()
      });
      
      // 初始化分块存储
      sessionChunks.set(sessionId, new Map());
      
      // 设置过期时间 - 10分钟后
      sessionExpiry.set(sessionId, Date.now() + SESSION_EXPIRY_TIME);
      
      return new Response(JSON.stringify({
        success: true,
        sessionId,
        message: '上传会话已创建'
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('创建上传会话失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '创建上传会话失败',
        message: error.message,
        details: {
          stack: error.stack,
          env: {
            hasToken: !!env.GITHUB_TOKEN,
            hasOwner: !!env.GITHUB_OWNER,
            hasRepo: !!env.GITHUB_REPO
          }
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 上传分块
  if (action === 'chunk' && request.method === 'POST') {
    try {
      const formData = await request.formData();
      const chunk = formData.get('chunk');
      const sessionId = formData.get('sessionId');
      const chunkIndex = parseInt(formData.get('chunkIndex'), 10);
      const totalChunks = parseInt(formData.get('totalChunks'), 10);
      
      // 验证参数
      if (!chunk || !sessionId || isNaN(chunkIndex) || isNaN(totalChunks)) {
        return new Response(JSON.stringify({
          success: false,
          error: '缺少必要参数'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 验证会话是否存在
      const session = uploadSessions.get(sessionId);
      if (!session) {
        return new Response(JSON.stringify({
          success: false,
          error: '会话不存在或已过期'
        }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 获取分块存储
      const chunks = sessionChunks.get(sessionId);
      
      // 存储分块数据
      const buffer = await chunk.arrayBuffer();
      chunks.set(chunkIndex, buffer);
      
      // 更新会话信息
      session.uploadedChunks++;
      
      // 刷新会话过期时间
      sessionExpiry.set(sessionId, Date.now() + SESSION_EXPIRY_TIME);
      
      return new Response(JSON.stringify({
        success: true,
        chunkIndex,
        received: true,
        progress: Math.floor((session.uploadedChunks / session.totalChunks) * 100)
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('上传分块失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '上传分块失败',
        message: error.message,
        details: {
          stack: error.stack,
          sessionExists: !!uploadSessions.get(sessionId),
          sessionChunksExists: !!sessionChunks.get(sessionId)
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 完成上传
  if (action === 'complete' && request.method === 'POST') {
    let sessionId = null;
    try {
      const requestData = await request.json();
      sessionId = requestData.sessionId;
      const skipDeploy = requestData.skipDeploy;
      
      console.log(`接收到完成上传请求: 会话ID=${sessionId}, 是否跳过部署=${skipDeploy}`);
      
      // 验证参数
      if (!sessionId) {
        return new Response(JSON.stringify({
          success: false,
          error: '缺少会话ID'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 验证会话是否存在
      const session = uploadSessions.get(sessionId);
      if (!session) {
        console.error(`会话不存在: ${sessionId}`);
        return new Response(JSON.stringify({
          success: false,
          error: '会话不存在或已过期'
        }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 获取分块数据
      const chunks = sessionChunks.get(sessionId);
      if (!chunks) {
        console.error(`分块数据不存在: ${sessionId}`);
        return new Response(JSON.stringify({
          success: false,
          error: '分块数据不存在或已过期'
        }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 验证是否所有分块都已上传
      if (chunks.size !== session.totalChunks) {
        console.error(`分块不完整: ${sessionId}, 已上传=${chunks.size}, 总数=${session.totalChunks}`);
        return new Response(JSON.stringify({
          success: false,
          error: '文件分块不完整，请重新上传',
          uploaded: chunks.size,
          expected: session.totalChunks
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 合并所有分块
      const totalLength = Array.from(chunks.values()).reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const mergedBuffer = new Uint8Array(totalLength);
      
      let offset = 0;
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkBuffer = chunks.get(i);
        if (!chunkBuffer) {
          throw new Error(`分块 ${i} 数据不存在`);
        }
        mergedBuffer.set(new Uint8Array(chunkBuffer), offset);
        offset += chunkBuffer.byteLength;
      }
      
      // 使用优化的方法将数据转换为Base64编码
      console.log(`开始对 ${totalLength} 字节的文件进行Base64编码`);
      const base64Data = arrayBufferToBase64(mergedBuffer.buffer);
      console.log(`Base64编码完成，编码后长度: ${base64Data.length}`);
      
      // 检查并分配仓库空间
      const allocation = await checkRepositorySpaceAndAllocate(env, session.fileSize);
      
      if (!allocation.canUpload) {
        // 清理会话数据
        uploadSessions.delete(sessionId);
        sessionChunks.delete(sessionId);
        sessionExpiry.delete(sessionId);
        
        return new Response(JSON.stringify({
          success: false,
          error: '无法分配足够的存储空间: ' + allocation.error
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 使用分配的仓库
      const { repository } = allocation;
      
      // 使用GitHub API上传文件
      const octokit = new Octokit({
        auth: repository.token
      });
      
      // 获取北京时间的日期路径
      const datePath = getBeijingDatePath();
      
      // 构建文件路径 - 使用原始文件名（或在必要时添加时间戳）
      let uploadFileName = session.fileName;
      if (!uploadFileName.includes('.')) {
        // 如果文件名没有扩展名，添加一个
        const extension = session.mimeType.split('/')[1] || 'jpg';
        uploadFileName = `${uploadFileName}.${extension}`;
      }
      
      const filePath = `public/images/${datePath}/${uploadFileName}`;
      
      try {
        // 上传文件到GitHub
        const response = await octokit.rest.repos.createOrUpdateFileContents({
          owner: repository.owner,
          repo: repository.repo,
          path: filePath,
          message: `Upload ${uploadFileName}`,
          content: base64Data,
          branch: 'main'
        });
        
        // 清理会话数据
        uploadSessions.delete(sessionId);
        sessionChunks.delete(sessionId);
        sessionExpiry.delete(sessionId);
        
        // 更新仓库大小估算
        await updateRepositorySizeEstimate(env, repository.id, session.fileSize);
        
        // 触发部署钩子
        if (!skipDeploy && repository.deployHook) {
          try {
            await fetch(repository.deployHook, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
            });
          } catch (deployError) {
            console.error('触发部署钩子失败:', deployError);
            // 继续执行，不因为部署失败而中断
          }
        }
        
        return new Response(JSON.stringify({
          success: true,
          file: {
            name: uploadFileName,
            path: filePath,
            size: session.fileSize,
            url: response.data.content.html_url
          }
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (error) {
        console.error('上传文件到GitHub失败:', error);
        
        // 清理会话数据
        uploadSessions.delete(sessionId);
        sessionChunks.delete(sessionId);
        sessionExpiry.delete(sessionId);
        
        // 处理特定类型的错误
        if (error.message && error.message.includes('already exists')) {
          return new Response(JSON.stringify({
            success: false,
            error: `文件 "${uploadFileName}" 已存在，请重命名后重试`,
            details: 'File already exists'
          }), {
            status: 409,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        throw error;
      }
    } catch (error) {
      console.error('完成上传失败:', error);
      
      // 清理会话数据
      if (sessionId) {
        uploadSessions.delete(sessionId);
        sessionChunks.delete(sessionId);
        sessionExpiry.delete(sessionId);
      }
      
      return new Response(JSON.stringify({
        success: false,
        error: '完成上传失败',
        message: error.message,
        details: {
          stack: error.stack,
          env: {
            hasToken: !!env.GITHUB_TOKEN,
            hasOwner: !!env.GITHUB_OWNER,
            hasRepo: !!env.GITHUB_REPO,
            hasDB: !!env.DB
          },
          sessionExists: sessionId ? !!uploadSessions.get(sessionId) : false,
          chunksCount: sessionId ? sessionChunks.get(sessionId)?.size || 0 : 0,
          sessionData: sessionId ? uploadSessions.get(sessionId) : null
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 取消上传
  if (action === 'cancel' && request.method === 'POST') {
    try {
      const { sessionId } = await request.json();
      
      // 验证参数
      if (!sessionId) {
        return new Response(JSON.stringify({
          success: false,
          error: '缺少会话ID'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 清理会话数据
      uploadSessions.delete(sessionId);
      sessionChunks.delete(sessionId);
      sessionExpiry.delete(sessionId);
      
      return new Response(JSON.stringify({
        success: true,
        message: '上传已取消'
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('取消上传失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '取消上传失败',
        message: error.message,
        details: {
          stack: error.stack,
          sessionExists: sessionId ? !!uploadSessions.get(sessionId) : false
        }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 如果没有匹配的操作，返回API使用说明
  return new Response(JSON.stringify({
    success: false,
    error: '无效的API请求',
    usage: '请使用查询参数指定操作，例如: /api/upload?action=create-session',
    availableActions: [
      'upload',
      'create-session',
      'chunk',
      'complete',
      'cancel'
    ]
  }), {
    status: 400,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// 检查是否允许游客上传
async function checkGuestUpload(env) {
  if (!env.DB) {
    return false;
  }
  
  try {
    const setting = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('allow_guest_upload').first();
    
    return setting?.value === 'true';
  } catch (error) {
    console.error('检查游客上传设置失败:', error);
    return false;
  }
}

// 检查用户是否已登录
async function checkAuthentication(request, env) {
  // 从Cookie中获取会话ID
  let sessionId = null;
  const cookieHeader = request.headers.get('Cookie');
  
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=');
      if (name === 'session_id') {
        sessionId = value;
        break;
      }
    }
  }
  
  if (!sessionId || !env.DB) {
    return false;
  }
  
  try {
    // 检查会话是否有效
    const session = await env.DB.prepare(
      'SELECT * FROM sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP'
    ).bind(sessionId).first();
    
    return !!session;
  } catch (error) {
    console.error('验证用户登录状态失败:', error);
    return false;
  }
} 
