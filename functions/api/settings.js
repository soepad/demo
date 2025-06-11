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
    console.log('更新设置，收到的数据:', settings);
    
    // 开始事务
    const batch = [];
    
    for (const [key, value] of Object.entries(settings)) {
      console.log(`准备更新设置: ${key} = ${value}`);
      
      // 特殊处理仓库大小阈值
      if (key === 'repository_size_threshold') {
        // 确保值是字符串
        const thresholdValue = value.toString();
        // 确保值可以解析为整数
        const thresholdBytes = parseInt(thresholdValue);
        
        if (isNaN(thresholdBytes)) {
          console.error(`无效的仓库大小阈值: ${thresholdValue}`);
          continue;
        }
        
        const thresholdMB = Math.round(thresholdBytes / (1024 * 1024));
        
        console.log(`仓库大小阈值将被设置为: ${thresholdBytes} 字节 (${thresholdMB}MB)`);
        
        // 确保数据库记录正确
        batch.push(
          env.DB.prepare(`
            INSERT OR REPLACE INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
          `).bind(key, thresholdBytes.toString())
        );
        
        // 添加一条日志记录，用于验证
        batch.push(
          env.DB.prepare(`
            INSERT OR REPLACE INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
          `).bind(key + '_log', `设置于${new Date().toISOString()}，值为${thresholdBytes}字节 (${thresholdMB}MB)`)
        );
      } else {
        batch.push(
          env.DB.prepare(`
            INSERT OR REPLACE INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
          `).bind(key, value)
        );
      }
    }
    
    // 执行批量更新
    console.log(`准备执行 ${batch.length} 个数据库操作`);
    await env.DB.batch(batch);
    console.log('设置更新成功');
    
    // 验证更新
    if (settings.repository_size_threshold) {
      const verify = await env.DB.prepare(`
        SELECT value FROM settings WHERE key = 'repository_size_threshold'
      `).first();
      
      if (verify) {
        const verifyBytes = parseInt(verify.value);
        const verifyMB = Math.round(verifyBytes / (1024 * 1024));
        console.log(`验证更新后的仓库大小阈值: ${verifyBytes} 字节 (${verifyMB}MB)`);
      } else {
        console.error('验证失败: 未找到仓库大小阈值设置');
      }
    }
    
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
      console.log('接收到获取设置请求');
      const settings = await getAllSettings(env);
      
      // 特殊处理仓库大小阈值，确保返回正确的值
      if (settings.repository_size_threshold) {
        const thresholdBytes = parseInt(settings.repository_size_threshold);
        const thresholdMB = Math.round(thresholdBytes / (1024 * 1024));
        console.log(`返回仓库大小阈值: ${thresholdBytes} 字节 (${thresholdMB}MB)`);
      } else {
        console.log('警告：未找到仓库大小阈值设置');
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: settings
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
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
