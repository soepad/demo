// import { getCookie } from 'hono/cookie';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  
  console.log('管理后台请求:', path);
  
  // 如果是登录页面或登录路径，直接返回
  if (path === '/admin/login.html' || path === '/admin/login') {
    console.log('访问登录页面，直接放行');
    return next();
  }
  
  // 手动解析cookie获取session_id
  let sessionId = null;
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = cookieHeader.split(';').map(cookie => cookie.trim());
  
  for (const cookie of cookies) {
    if (cookie.startsWith('session_id=')) {
      sessionId = cookie.substring('session_id='.length);
      break;
    }
  }
  
  console.log('解析的sessionId:', sessionId);
  
  let isAuthenticated = false;
  
  if (sessionId && env?.DB) {
    try {
      const session = await env.DB.prepare(
        'SELECT * FROM sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP'
      ).bind(sessionId).first();
      
      if (session) {
        console.log('用户已登录:', session.username);
        isAuthenticated = true;
      } else {
        console.log('会话无效或已过期');
      }
    } catch (error) {
      console.error('检查会话出错:', error);
    }
  }
  
  // 如果用户未登录，重定向到登录页面
  if (!isAuthenticated) {
    console.log('用户未登录，重定向到登录页面');
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/admin/login.html'
      }
    });
  }
  
  // 用户已登录，继续处理请求
  console.log('用户已登录，继续处理请求');
  try {
    return next();
  } catch (error) {
    console.error('处理请求时出错:', error);
    return new Response('内部服务器错误: ' + error.message, { status: 500 });
  }
} 

