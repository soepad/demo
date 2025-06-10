import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from 'hono/cloudflare-workers';

// 创建主应用实例
const app = new Hono();

// 创建 API 应用实例
const api = new Hono();

// 添加 CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Cookie',
  'Access-Control-Allow-Credentials': 'true'
};

// 确保所有响应都设置正确的 Content-Type
app.use('*', async (c, next) => {
  await next();
  const path = c.req.path;
  if (path.endsWith('.js')) {
    c.header('Content-Type', 'application/javascript');
  } else if (path.endsWith('.css')) {
    c.header('Content-Type', 'text/css');
  } else if (path.endsWith('.html')) {
    c.header('Content-Type', 'text/html');
  } else if (path.endsWith('.ico')) {
    c.header('Content-Type', 'image/x-icon');
  } else if (path.endsWith('.png')) {
    c.header('Content-Type', 'image/png');
  } else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
    c.header('Content-Type', 'image/jpeg');
  } else if (path.endsWith('.gif')) {
    c.header('Content-Type', 'image/gif');
  } else if (path.endsWith('.svg')) {
    c.header('Content-Type', 'image/svg+xml');
  } else if (path.endsWith('.webp')) {
    c.header('Content-Type', 'image/webp');
  }
});

// 处理 OPTIONS 请求
api.options('*', (c) => {
  return new Response(null, {
    headers: corsHeaders
  });
});

// API 路由定义
api.get('/settings/guest-upload', async (c) => {
  console.log('Entering /settings/guest-upload handler');
  try {
    if (!c.env?.DB) {
      return c.json({ error: 'Database not configured' }, 500);
    }

    const result = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('allow_guest_upload')
      .first();
    
    console.log('Guest upload setting:', result);
    
    return c.json({
      success: true,
      data: {
        allowGuestUpload: result?.value === 'true'
      }
    });
  } catch (error) {
    console.error('Error fetching guest upload settings:', error);
    return c.json({
      success: false,
      error: 'Failed to fetch settings'
    }, 500);
  }
});

// 获取所有设置
api.all('/settings', async (c) => {
    const { request, env } = c;
    
    try {
        const { onRequest } = await import('./api/settings.js');
        return await onRequest({ request, env });
    } catch (error) {
        console.error('Error processing settings request:', error);
        return c.json({
            success: false,
            error: 'Failed to process settings request',
            details: error.message
        }, 500);
    }
});

// 健康检查端点
api.get('/health', (c) => {
    return c.json({
        success: true,
        message: 'Service is running',
        database: c.env?.DB ? 'connected' : 'not connected'
    });
});

// 仓库管理API
api.all('/repositories/*', async (c) => {
    const { request, env } = c;
    const { pathname } = new URL(request.url);
    const repoPath = pathname.replace('/api/repositories', '');
    
    try {
        const { onRequest } = await import('./api/repositories.js');
        return await onRequest({ request, env });
    } catch (error) {
        console.error('Error processing repositories request:', error);
        return c.json({
            success: false,
            error: 'Failed to process repositories request',
            details: error.message
        }, 500);
    }
});

api.all('/repositories', async (c) => {
    const { request, env } = c;
    
    try {
        const { onRequest } = await import('./api/repositories.js');
        return await onRequest({ request, env });
    } catch (error) {
        console.error('Error processing repositories request:', error);
        return c.json({
            success: false,
            error: 'Failed to process repositories request',
            details: error.message
        }, 500);
    }
});

// 文件上传API
api.all('/upload', async (c) => {
    const { request, env } = c;
    
    try {
        const { onRequest } = await import('./api/upload.js');
        return await onRequest({ request, env });
    } catch (error) {
        console.error('Error processing upload request:', error);
        return c.json({
            success: false,
            error: 'Failed to process upload request',
            details: error.message
        }, 500);
    }
});

// 全局错误处理
app.use('*', async (c, next) => {
  try {
    await next();
  } catch (err) {
    console.error('Error:', err);
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Internal Server Error' }, 500);
    }
    throw err;
  }
});

// 请求日志
app.use('*', async (c, next) => {
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}`);
  await next();
});

// 会话管理中间件
async function sessionMiddleware(c, next) {
  const sessionId = getCookie(c, 'session_id');
  
  if (sessionId && c.env?.DB) {
    try {
      const session = await c.env.DB.prepare(
        'SELECT * FROM sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP'
      ).bind(sessionId).first();
      
      if (session) {
        c.set('session', {
          userId: session.user_id,
          username: session.username
        });
      } else {
        deleteCookie(c, 'session_id');
      }
    } catch (error) {
      console.error('Session error:', error);
      deleteCookie(c, 'session_id');
    }
  }
  await next();
}

// 游客上传检查
async function checkGuestUpload(c, next) {
  if (c.req.path === '/api/upload' && c.req.method === 'POST' && c.env?.DB) {
    try {
      const setting = await c.env.DB.prepare(
        'SELECT value FROM settings WHERE key = ?'
      ).bind('allow_guest_upload').first();
      
      if (!setting || setting.value !== 'true') {
        const session = await c.get('session');
        if (!session || !session.userId) {
          return c.json({ error: '游客上传已禁用' }, 403);
        }
      }
    } catch (error) {
      console.error('Guest upload check error:', error);
      return c.json({ error: '检查上传权限失败' }, 500);
    }
  }
  await next();
}

// 上传安全检查中间件
async function checkUploadSecurity(c, next) {
  if (c.req.path === '/api/upload' && c.req.method === 'POST') {
    try {
      const formData = await c.req.formData();
      const file = formData.get('file');
      
      if (!file) {
        return c.json({ error: '未找到文件' }, 400);
      }

      // 检查文件类型
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon'];
      if (!allowedTypes.includes(file.type)) {
        return c.json({ error: '不支持的文件类型' }, 400);
      }

      // 检查文件大小（25MB）
      const MAX_FILE_SIZE = 25 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: '文件大小超过限制 (最大 25MB)' }, 400);
      }

      // 检查文件名
      const fileName = file.name.toLowerCase();
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico'];
      const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
      if (!hasValidExtension) {
        return c.json({ error: '不支持的文件扩展名' }, 400);
      }

      // 检查文件名长度
      if (fileName.length > 100) {
        return c.json({ error: '文件名过长' }, 400);
      }

      // 检查文件名是否包含特殊字符
      const invalidChars = /[<>:"/\\|?*\x00-\x1F]/g;
      if (invalidChars.test(fileName)) {
        return c.json({ error: '文件名包含非法字符' }, 400);
      }

      // 将文件信息添加到上下文中，供后续处理使用
      c.set('uploadFile', file);
    } catch (error) {
      console.error('Upload security check error:', error);
      return c.json({ error: '文件安全检查失败' }, 500);
    }
  }
  await next();
}

// 应用通用中间件
app.use('*', sessionMiddleware);
app.use('*', checkUploadSecurity);
app.use('*', checkGuestUpload);

// 先挂载 API 路由
app.route('/api', api);

// 处理静态文件
app.use('/*', serveStatic({ root: './public' }));

// 导出处理函数
export default app; 
