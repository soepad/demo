// CORS头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * 验证管理员权限
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} - 是否有权限
 */
async function checkAdminAuth(request, env) {
  try {
    // 从Cookie中获取会话ID
    const cookies = request.headers.get('cookie') || '';
    const sessionIdMatch = cookies.match(/session_id=([^;]+)/);
    
    if (!sessionIdMatch) {
      return false;
    }
    
    const sessionId = sessionIdMatch[1];
    
    // 验证会话
    const session = await env.DB.prepare(
      'SELECT * FROM sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP'
    ).bind(sessionId).first();
    
    if (!session) {
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('验证管理员权限失败:', error);
    return false;
  }
}

/**
 * 获取所有设置
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} - 设置对象
 */
async function getAllSettings(env) {
  try {
    console.log('正在获取所有设置...');
    const settings = await env.DB.prepare('SELECT * FROM settings').all();
    console.log('数据库返回的设置:', settings);
    
    const settingsMap = {};
    
    for (const setting of settings.results) {
      settingsMap[setting.key] = setting.value;
    }
    
    console.log('转换后的设置映射:', settingsMap);
    console.log('仓库大小阈值设置:', settingsMap['repository_size_threshold']);
    
    return settingsMap;
  } catch (error) {
    console.error('获取设置失败:', error);
    throw error;
  }
}

/**
 * 更新设置
 * @param {Object} env - 环境变量
 * @param {Object} settings - 设置对象
 * @returns {Promise<void>}
 */
async function updateSettings(env, settings) {
  try {
    // 开始事务
    const batch = [];
    
    for (const [key, value] of Object.entries(settings)) {
      batch.push(
        env.DB.prepare(`
          INSERT OR REPLACE INTO settings (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
        `).bind(key, value)
      );
    }
    
    // 执行批量更新
    await env.DB.batch(batch);
    
  } catch (error) {
    console.error('更新设置失败:', error);
    throw error;
  }
}

/**
 * 处理请求
 * @param {Object} context - 请求上下文
 * @returns {Promise<Response>} - 响应对象
 */
export async function onRequest(context) {
  const { request, env } = context;
  
  // 处理OPTIONS请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  
  // 获取所有设置
  if (request.method === 'GET') {
    try {
      const settings = await getAllSettings(env);
      
      return new Response(JSON.stringify({
        success: true,
        data: settings
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('获取设置失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '获取设置失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 更新设置
  if (request.method === 'POST') {
    try {
      // 验证管理员权限
      const isAdmin = await checkAdminAuth(request, env);
      
      if (!isAdmin) {
        return new Response(JSON.stringify({
          success: false,
          error: '需要管理员权限'
        }), {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      const settings = await request.json();
      
      // 验证仓库大小阈值
      if (settings.repository_size_threshold) {
        const thresholdBytes = parseInt(settings.repository_size_threshold);
        const maxThresholdBytes = 1024 * 1024 * 1024; // 1GB
        
        if (thresholdBytes > maxThresholdBytes) {
          return new Response(JSON.stringify({
            success: false,
            error: '仓库大小阈值不能超过1GB'
          }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      }
      
      await updateSettings(env, settings);
      
      return new Response(JSON.stringify({
        success: true,
        message: '设置已更新'
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('更新设置失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '更新设置失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 未找到匹配的路由
  return new Response(JSON.stringify({
    success: false,
    error: '未找到请求的API端点'
  }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
} 
