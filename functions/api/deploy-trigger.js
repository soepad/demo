/**
 * 部署触发API - 处理前端发起的部署请求
 * 这个端点允许在所有文件上传完成后统一触发一次部署
 */

// CORS头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * 触发Cloudflare Pages部署钩子
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} - 返回部署结果
 */
async function triggerDeployHook(env) {
  // 检查环境变量是否存在
  if (!env.DEPLOY_HOOK) {
    console.log('DEPLOY_HOOK环境变量未设置，跳过部署');
    return { success: false, error: 'DEPLOY_HOOK环境变量未设置' };
  }

  // 检查格式是否正确
  const deployHook = env.DEPLOY_HOOK.trim();
  if (!deployHook.startsWith('https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/')) {
    console.error('DEPLOY_HOOK格式不正确，应以https://api.cloudflare.com/开头');
    return { success: false, error: 'DEPLOY_HOOK格式不正确' };
  }

  // 直接使用DEPLOY_HOOK的值
  const deployUrl = deployHook;
  
  try {
    console.log('手动触发Cloudflare Pages部署...');
    const response = await fetch(deployUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const result = await response.json();
      console.log('部署成功触发:', result);
      return { success: true, result };
    } else {
      const errorText = await response.text();
      console.error('部署触发失败:', response.status, errorText);
      return { success: false, error: `部署触发失败: ${response.status} ${errorText}` };
    }
  } catch (error) {
    console.error('部署钩子请求异常:', error);
    return { success: false, error: `部署钩子请求异常: ${error.message}` };
  }
}

/**
 * 检查是否允许游客上传
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} - 是否允许游客上传
 */
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

/**
 * 检查用户是否已登录
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} - 是否已登录
 */
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

export async function onRequest(context) {
  const { request, env } = context;
  
  // 处理OPTIONS请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // 只允许POST请求
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({
      success: false,
      error: '只允许POST请求'
    }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
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
  
  try {
    // 获取请求数据
    const data = await request.json();
    const filesUploaded = data.filesUploaded || 0;
    
    // 记录请求信息
    console.log(`收到部署触发请求，已上传文件数: ${filesUploaded}`);
    
    // 触发部署
    const deployResult = await triggerDeployHook(env);
    
    if (deployResult.success) {
      console.log('部署触发成功:', deployResult.result);
      
      return new Response(JSON.stringify({
        success: true,
        message: `部署已触发，${filesUploaded}个文件将被部署`,
        deployment: deployResult.result
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } else {
      console.error('部署触发失败:', deployResult.error);
      
      return new Response(JSON.stringify({
        success: false,
        error: '部署触发失败',
        details: deployResult.error
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } catch (error) {
    console.error('处理部署触发请求时出错:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: '处理请求失败',
      details: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
} 
