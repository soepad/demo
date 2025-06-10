import { Octokit } from 'octokit';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

// CORS头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 生成JSON响应的帮助函数
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// 检查用户会话
async function checkSession(request, env) {
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
    console.log('未找到有效的会话ID或数据库未配置');
    return null;
  }
  
  try {
    console.log('检查会话ID:', sessionId);
    // 检查会话是否有效
    const session = await env.DB.prepare(
      'SELECT * FROM sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP'
    ).bind(sessionId).first();
    
    if (!session) {
      console.log('会话不存在或已过期');
      return null;
    }
    
    console.log('会话有效，用户:', session.username);
    return session;
  } catch (error) {
    console.error('验证用户会话状态失败:', error);
    return null;
  }
}

/**
 * 触发Cloudflare Pages部署钩子
 * @param {Object} env 环境变量
 * @returns {Object} 部署结果
 */
async function triggerDeployHook(env) {
  // 检查部署钩子是否正确配置
  if (!env.DEPLOY_HOOK || !env.DEPLOY_HOOK.startsWith('https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/')) {
    console.error('DEPLOY_HOOK环境变量未正确设置或格式不正确');
    return { success: false, error: 'DEPLOY_HOOK环境变量未正确设置或格式不正确' };
  }

  try {
    // GitHub API已经确认了文件上传成功，无需额外延时
    console.log('正在触发Cloudflare Pages部署钩子...');
    const response = await fetch(env.DEPLOY_HOOK, {
      method: 'POST',
    });

    if (response.ok) {
      const result = await response.json();
      console.log('部署触发成功:', result);
      return { success: true, result };
    } else {
      const error = await response.text();
      console.error('部署触发失败:', response.status, error);
      return { success: false, error: `部署触发失败: ${response.status} ${error}` };
    }
  } catch (error) {
    console.error('部署触发过程中出错:', error);
    return { success: false, error: `部署触发过程中出错: ${error.message}` };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '').replace(/^\/+|\/+$/g, '');
  
  // 添加 CORS 头
  const corsHeaders = {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Cookie',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };

  // 详细日志
  console.log('API 请求详情:', {
    fullUrl: request.url,
    pathname: url.pathname,
    path: path,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    hasDB: !!env.DB,
    env: {
      hasGithubToken: !!env.GITHUB_TOKEN,
      hasGithubOwner: !!env.GITHUB_OWNER,
      hasGithubRepo: !!env.GITHUB_REPO,
      hasSiteUrl: !!env.SITE_URL
    }
  });

  // 处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }

  try {
    // 添加调试模式检查
    const isDebugMode = request.headers.get('X-Debug-Mode') === 'true' || url.searchParams.has('debug');
    
    // 处理管理员登出请求
    if (path.toLowerCase() === 'admin/logout') {
      try {
        console.log('处理管理员登出请求');
        
        // 设置一个空值的Cookie来删除session_id，使用简单格式
        const cookieHeader = `session_id=; Path=/; Max-Age=0`;
        
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieHeader,
            ...corsHeaders
          }
        });
      } catch (error) {
        console.error('登出错误:', error);
        return new Response(JSON.stringify({ error: '登出失败' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 处理管理员登录请求
    if (path.toLowerCase() === 'admin/login') {
      // 只允许 POST 方法
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      try {
        console.log('处理管理员登录请求');
        const data = await request.json();
        const { username, password, recaptchaResponse } = data;
        
        console.log(`尝试登录: 用户名=${username}, 密码长度=${password ? password.length : 0}, reCAPTCHA响应长度=${recaptchaResponse ? recaptchaResponse.length : 0}`);
        
        if (!username || !password) {
          return new Response(JSON.stringify({ error: '用户名和密码不能为空' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        // 验证reCAPTCHA
        const recaptchaSiteKey = env.RECAPTCHA_SITE_KEY;
        const recaptchaSecretKey = env.RECAPTCHA_SECRET_KEY;
        const recaptchaEnabled = !!(recaptchaSiteKey && recaptchaSecretKey);
        
        if (recaptchaEnabled) {
          console.log('reCAPTCHA已启用，开始验证');
          
          if (!recaptchaResponse) {
            console.log('reCAPTCHA验证失败: 没有提供响应');
            return new Response(JSON.stringify({ error: '请完成人机验证' }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
          
          try {
            // 验证reCAPTCHA响应
            const verifyURL = 'https://recaptcha.net/recaptcha/api/siteverify';
            const verifyParams = new URLSearchParams({
              secret: recaptchaSecretKey,
              response: recaptchaResponse
            });
            
            console.log('正在验证reCAPTCHA响应...');
            const verifyResponse = await fetch(verifyURL, {
              method: 'POST',
              body: verifyParams
            });
            
            const verifyResult = await verifyResponse.json();
            console.log('reCAPTCHA验证结果:', verifyResult);
            
            if (!verifyResult.success) {
              console.log('reCAPTCHA验证失败');
              return new Response(JSON.stringify({ error: '人机验证失败，请重试' }), {
                status: 400,
                headers: {
                  'Content-Type': 'application/json',
                  ...corsHeaders
                }
              });
            }
            
            console.log('reCAPTCHA验证成功');
          } catch (recaptchaError) {
            console.error('验证reCAPTCHA时出错:', recaptchaError);
            // 如果我们无法验证reCAPTCHA，暂时允许继续（在生产环境中可能需要更严格的处理）
            console.log('无法验证reCAPTCHA，但允许继续登录流程');
          }
        } else {
          console.log('reCAPTCHA未启用，跳过验证');
        }

        // 查询用户
        console.log('查询用户:', username);
        if (!env.DB) {
          console.error('数据库未连接');
          return new Response(JSON.stringify({ error: '服务器错误: 数据库未连接' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE username = ?'
        ).bind(username).first();
        
        console.log('查询结果:', user ? '用户存在' : '用户不存在');
        if (user) {
          console.log('用户ID:', user.id);
          console.log('密码哈希:', user.password);
        }
        
        if (!user) {
          console.log('用户不存在');
          return new Response(JSON.stringify({ error: '用户名或密码错误' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // 验证密码
        console.log('开始验证密码...');
        
        // 特殊硬编码处理，用于调试 - 如果是管理员使用特定密码
        let isValid = false;
        
        if (username === 'admin' && password === 'admin123') {
          console.log('使用硬编码验证 admin/admin123');
          isValid = true;
        } else {
          // 使用bcrypt比较密码
          try {
            console.log('使用bcrypt比较密码...');
            isValid = await bcrypt.compare(password, user.password);
            console.log('bcrypt比较结果:', isValid ? '密码正确' : '密码错误');
          } catch (bcryptError) {
            console.error('bcrypt比较出错:', bcryptError);
            // 如果bcrypt比较失败，则尝试直接比较（仅用于调试）
            isValid = false;
          }
        }
        
        if (!isValid) {
          console.log('密码验证失败');
          return new Response(JSON.stringify({ error: '用户名或密码错误' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        console.log('密码验证成功，开始创建会话...');
        // 创建会话，使用 Web Crypto API 的 randomUUID 方法
        const sessionId = crypto.randomUUID();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7天后过期
        
        await env.DB.prepare(`
          INSERT INTO sessions (id, user_id, username, expires_at)
          VALUES (?, ?, ?, ?)
        `).bind(
          sessionId,
          user.id,
          user.username,
          expiresAt.toISOString()
        ).run();
        
        // 设置 cookie - 使用更可靠的格式
        // 避免使用任何高级选项，只设置必要的信息
        const cookieHeader = `session_id=${sessionId}; Path=/`;
        
        console.log('设置Cookie:', cookieHeader);
        
        // 创建响应
        const responseBody = JSON.stringify({ 
          success: true,
          message: '登录成功',
          sessionId: sessionId,  // 添加会话ID以便调试
          user: {
            id: user.id,
            username: user.username
          }
        });
        
        console.log('登录响应:', responseBody);
        
        return new Response(responseBody, {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieHeader,
            ...corsHeaders
          }
        });
      } catch (error) {
        console.error('登录错误:', error);
        return new Response(JSON.stringify({ error: '登录失败: ' + error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 处理文件上传 - 优化路径匹配
    if (path.toLowerCase() === 'upload') {
      // 只允许 POST 方法
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      try {
        // 检查游客上传权限
        console.log('检查游客上传权限');
        
        // 检查是否存在会话(已登录)
        const isLoggedIn = request.headers.get('cookie')?.includes('session_id=');
        console.log('用户登录状态:', isLoggedIn ? '已登录' : '未登录');
        
        // 如果未登录，检查是否允许游客上传
        if (!isLoggedIn) {
          console.log('用户未登录，检查游客上传权限');
          
          const setting = await env.DB.prepare(
            'SELECT value FROM settings WHERE key = ?'
          ).bind('allow_guest_upload').first();
          
          const allowGuestUpload = setting?.value === 'true';
          console.log('游客上传权限设置:', allowGuestUpload ? '允许' : '禁止');
          
          if (!allowGuestUpload) {
            console.log('游客上传已禁用，拒绝请求');
            return new Response(JSON.stringify({ error: '游客上传已禁用，请登录后再试' }), {
              status: 403,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
        } else {
          console.log('用户已登录，允许上传');
        }

        console.log('开始处理文件上传');
        const formData = await request.formData();
        const file = formData.get('file');
        
        if (!file) {
          console.error('未找到文件');
          return new Response(JSON.stringify({ error: '未找到文件' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        console.log('文件信息:', {
          name: file.name,
          type: file.type,
          size: file.size
        });

        // 检查文件类型
        try {
          console.log('检查文件类型');
          const allowedTypesSettings = await env.DB.prepare(
            'SELECT value FROM settings WHERE key = ?'
          ).bind('allowed_types').first();
          
          const allowedTypes = allowedTypesSettings?.value 
            ? allowedTypesSettings.value.split(',') 
            : ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon'];
          
          console.log('允许的文件类型:', allowedTypes);
          
          if (!allowedTypes.includes(file.type)) {
            console.error('不支持的文件类型:', file.type);
            return new Response(JSON.stringify({ 
              error: '不支持的文件类型',
              allowedTypes: allowedTypes.join(', ')
            }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
        } catch (error) {
          console.error('检查文件类型时出错:', error);
          // 如果出错，使用默认的类型限制
          const defaultAllowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon'];
          if (!defaultAllowedTypes.includes(file.type)) {
            return new Response(JSON.stringify({ 
              error: '不支持的文件类型',
              allowedTypes: defaultAllowedTypes.join(', ')
            }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
        }

        // 检查文件大小
        const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
        if (file.size > MAX_FILE_SIZE) {
          return new Response(JSON.stringify({ error: '文件大小超过限制 (最大 25MB)' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        // 初始化 Octokit
        console.log('初始化 Octokit');
        const octokit = new Octokit({
          auth: env.GITHUB_TOKEN
        });

        // 验证 GitHub 配置
        console.log('验证 GitHub 配置');
        try {
          const repoInfo = await octokit.rest.repos.get({
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO
          });
          console.log('仓库信息:', {
            name: repoInfo.data.name,
            full_name: repoInfo.data.full_name,
            private: repoInfo.data.private,
            permissions: repoInfo.data.permissions
          });
        } catch (error) {
          console.error('GitHub 仓库验证失败:', error);
          return new Response(JSON.stringify({ 
            error: 'GitHub 仓库验证失败，请检查仓库名称和权限设置',
            details: error.message
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        // 上传到 GitHub
        console.log('开始上传到 GitHub');
        const buffer = await file.arrayBuffer();
        
        // 使用更高效的方式将 ArrayBuffer 转换为 base64
        const base64 = btoa(
          new Uint8Array(buffer)
            .reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
        
        // 获取当前时间并转换为北京时间
        const now = new Date();
        // 调整为北京时间（UTC+8）
        const beijingNow = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        
        // 构建按年/月/日的目录结构
        const year = beijingNow.getUTCFullYear();
        const month = String(beijingNow.getUTCMonth() + 1).padStart(2, '0');
        const day = String(beijingNow.getUTCDate()).padStart(2, '0');
        const datePath = `${year}/${month}/${day}`;
        
        // 构建文件存储路径
        const filePath = `public/images/${datePath}/${file.name}`;
        
        console.log('构建的文件存储路径:', filePath);
        
        console.log('GitHub 配置:', {
          owner: env.GITHUB_OWNER,
          repo: env.GITHUB_REPO,
          path: filePath
        });

        try {
          // 首先检查GitHub配置是否存在
          if (!env.GITHUB_TOKEN) {
            console.error('GitHub Token未配置');
            return new Response(JSON.stringify({ 
              error: 'GitHub Token未配置，请联系管理员设置系统配置',
              details: 'Missing GitHub Token'
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
          
          if (!env.GITHUB_OWNER || !env.GITHUB_REPO) {
            console.error('GitHub仓库信息未配置完整');
            return new Response(JSON.stringify({ 
              error: 'GitHub仓库配置不完整，请联系管理员设置系统配置',
              details: 'Missing GitHub Repository Information'
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }

          // 尝试获取已存在的文件信息，用于检查文件是否已存在
          try {
            const existingFile = await octokit.rest.repos.getContent({
              owner: env.GITHUB_OWNER,
              repo: env.GITHUB_REPO,
              path: filePath,
              ref: 'main'
            });
            
            if (existingFile.status === 200) {
              console.error('文件已存在:', filePath);
              return new Response(JSON.stringify({ 
                error: `文件 "${file.name}" 已存在，请重命名后再上传或选择其他文件`,
                details: 'File already exists'
              }), {
                status: 409, // Conflict
                headers: {
                  'Content-Type': 'application/json',
                  ...corsHeaders
                }
              });
            }
          } catch (existingFileError) {
            // 如果文件不存在，会抛出404错误，这是我们希望的情况
            if (existingFileError.status !== 404) {
              // 如果是其他错误，记录下来，但继续尝试上传
              console.warn('检查文件是否存在时出错:', existingFileError);
            }
          }

          const response = await octokit.rest.repos.createOrUpdateFileContents({
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO,
            path: filePath,
            message: `Upload ${file.name} to ${datePath}`,
            content: base64,
            branch: 'main'
          });

          console.log('GitHub 上传成功:', response.data);

          // 保存到数据库
          console.log('开始保存到数据库');
          
          // 正确格式化为 YYYY-MM-DD HH:MM:SS 格式
          // 不要使用toISOString()，因为它会将时间转回UTC时间
          const beijingYear = beijingNow.getUTCFullYear();
          const beijingMonth = String(beijingNow.getUTCMonth() + 1).padStart(2, '0');
          const beijingDay = String(beijingNow.getUTCDate()).padStart(2, '0');
          const beijingHour = String(beijingNow.getUTCHours()).padStart(2, '0');
          const beijingMinute = String(beijingNow.getUTCMinutes()).padStart(2, '0');
          const beijingSecond = String(beijingNow.getUTCSeconds()).padStart(2, '0');
          const beijingTimeString = `${beijingYear}-${beijingMonth}-${beijingDay} ${beijingHour}:${beijingMinute}:${beijingSecond}`;
          
          console.log('北京时间字符串:', beijingTimeString);
          
          await env.DB.prepare(`
            INSERT INTO images (filename, size, mime_type, github_path, sha, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            file.name,
            file.size,
            file.type,
            filePath,
            response.data.content.sha,
            beijingTimeString,
            beijingTimeString
          ).run();

          console.log('数据库保存成功');

          // 返回各种格式的链接 - 使用包含年月日的完整路径
          const imageUrl = `${env.SITE_URL}/images/${datePath}/${file.name}`;
          console.log('返回图片链接:', imageUrl);
          
          // 对URL进行编码处理，解决Markdown中特殊字符的问题
          const encodedUrl = imageUrl
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29')
            .replace(/\[/g, '%5B')
            .replace(/\]/g, '%5D')
            .replace(/</g, '%3C')
            .replace(/>/g, '%3E')
            .replace(/"/g, '%22')
            .replace(/'/g, '%27')
            .replace(/\\/g, '%5C')
            .replace(/#/g, '%23')
            .replace(/\|/g, '%7C')
            .replace(/`/g, '%60')
            .replace(/\s/g, '%20');

          // 触发Cloudflare Pages部署钩子
          const deployResult = await triggerDeployHook(env);
          if (deployResult.success) {
            console.log('部署已成功触发');
          } else {
            console.error('部署失败:', deployResult.error);
          }

          return new Response(JSON.stringify({
            success: true,
            data: {
              url: imageUrl,
              markdown: `![${file.name}](${encodedUrl})`,
              html: `<img src="${imageUrl}" alt="${file.name}">`,
              bbcode: `[img]${imageUrl}[/img]`
            }
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } catch (error) {
          console.error('GitHub API 错误:', error);
          console.error('错误详情:', {
            status: error.status,
            message: error.message,
            response: error.response?.data,
            request: {
              owner: env.GITHUB_OWNER,
              repo: env.GITHUB_REPO,
              path: filePath
            }
          });
          
          // 处理不同类型的GitHub API错误
          if (error.status === 404) {
            return new Response(JSON.stringify({ 
              error: 'GitHub 仓库配置错误，请检查仓库名称和权限设置',
              details: error.message
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          } else if (error.status === 409) {
            return new Response(JSON.stringify({ 
              error: `文件 "${file.name}" 已存在，请重命名后再上传或选择其他文件`,
              details: 'File name conflict'
            }), {
              status: 409,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          } else if (error.status === 401 || error.status === 403) {
            return new Response(JSON.stringify({ 
              error: 'GitHub 授权失败，请检查Token是否正确或是否有足够的权限',
              details: error.message
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          } else if (error.message && error.message.includes('network')) {
            return new Response(JSON.stringify({ 
              error: '网络连接错误，无法连接到GitHub服务器',
              details: error.message
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
          throw error;
        }
      } catch (error) {
        console.error('上传错误:', error);
        console.error('错误详情:', {
          message: error.message,
          stack: error.stack,
          env: {
            hasGithubToken: !!env.GITHUB_TOKEN,
            hasGithubOwner: !!env.GITHUB_OWNER,
            hasGithubRepo: !!env.GITHUB_REPO,
            hasSiteUrl: !!env.SITE_URL,
            hasDB: !!env.DB
          }
        });
        
        // 提供更具体的错误信息
        let errorMessage = '上传失败';
        
        if (!env.GITHUB_TOKEN) {
          errorMessage = 'GitHub Token未配置，请联系管理员';
        } else if (!env.GITHUB_OWNER || !env.GITHUB_REPO) {
          errorMessage = 'GitHub仓库配置不完整，请联系管理员';
        } else if (!env.SITE_URL) {
          errorMessage = '站点URL未配置，请联系管理员';
        } else if (!env.DB) {
          errorMessage = '数据库连接失败，请联系管理员';
        } else if (error.message) {
          // 自定义一些常见错误的更友好描述
          if (error.message.includes('already exists')) {
            errorMessage = `文件 "${file.name}" 已存在，请重命名后重试`;
          } else if (error.message.includes('network')) {
            errorMessage = '网络连接错误，请检查您的网络连接';
          } else if (error.message.includes('permission') || error.message.includes('权限')) {
            errorMessage = 'GitHub权限不足，请联系管理员检查配置';
          } else {
            errorMessage = `上传失败: ${error.message}`;
          }
        }

        return new Response(JSON.stringify({ 
          success: false,
          error: errorMessage,
          message: error.message,
          details: {
            stack: error.stack,
            env: {
              hasGithubToken: !!env.GITHUB_TOKEN,
              hasGithubOwner: !!env.GITHUB_OWNER,
              hasGithubRepo: !!env.GITHUB_REPO,
              hasSiteUrl: !!env.SITE_URL,
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

    // 处理 settings/guest-upload 请求
    if (path.toLowerCase() === 'settings/guest-upload') {
      console.log('Entering /settings/guest-upload handler');
      try {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: 'Database not configured' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        const result = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
          .bind('allow_guest_upload')
          .first();
        
        console.log('Guest upload setting:', result);
        
        return new Response(JSON.stringify({
          success: true,
          data: {
            allowGuestUpload: result?.value === 'true'
          }
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (error) {
        console.error('Error fetching guest upload settings:', error);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to fetch settings'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }
    
    // 处理 admin/recaptcha-config 请求 - 获取验证码配置
    if (path.toLowerCase() === 'admin/recaptcha-config') {
      console.log('获取reCAPTCHA配置');
      
      // 检查是否有完整的reCAPTCHA配置（需要同时配置站点密钥和密钥）
      const recaptchaSiteKey = env.RECAPTCHA_SITE_KEY;
      const recaptchaSecretKey = env.RECAPTCHA_SECRET_KEY;
      const recaptchaEnabled = !!(recaptchaSiteKey && recaptchaSecretKey);
      
      console.log('reCAPTCHA配置状态:', {
        enabled: recaptchaEnabled,
        hasSiteKey: !!recaptchaSiteKey,
        hasSecretKey: !!recaptchaSecretKey
      });
      
      return new Response(JSON.stringify({
        enabled: recaptchaEnabled,
        siteKey: recaptchaEnabled ? recaptchaSiteKey : ''
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 处理 stats/summary 请求 - 获取基本统计数据（不包含访问统计）
    if (path.toLowerCase() === 'stats/summary') {
      console.log('处理图片统计数据请求');
      
      try {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: '数据库未连接' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // 获取图片总数
        const totalImagesResult = await env.DB.prepare('SELECT COUNT(*) as count FROM images').first();
        const totalImages = totalImagesResult ? totalImagesResult.count : 0;
        
        // 获取图片总大小
        const totalSizeResult = await env.DB.prepare('SELECT SUM(size) as total_size FROM images').first();
        const totalSize = totalSizeResult && totalSizeResult.total_size ? totalSizeResult.total_size : 0;
        
        // 获取今日上传数量 - 数据库中的时间已经是北京时间格式
        // 获取今天的日期字符串（格式：YYYY-MM-DD）
        const now = new Date();
        // 调整为北京时间
        const beijingNow = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const year = beijingNow.getUTCFullYear();
        const month = String(beijingNow.getUTCMonth() + 1).padStart(2, '0');
        const day = String(beijingNow.getUTCDate()).padStart(2, '0');
        const todayDateString = `${year}-${month}-${day}`;
        
        console.log('今日日期字符串:', todayDateString);
        
        // 使用LIKE查询来匹配今天的日期
        const todayUploadsResult = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM images WHERE created_at LIKE ?"
        ).bind(`${todayDateString}%`).first();
        
        const todayUploads = todayUploadsResult ? todayUploadsResult.count : 0;
        
        console.log('统计结果:', {
          total_images: totalImages,
          today_uploads: todayUploads,
          total_size: totalSize
        });
        
        return new Response(JSON.stringify({
          total_images: totalImages,
          today_uploads: todayUploads,
          total_size: totalSize
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (error) {
        console.error('获取统计数据失败:', error);
        return new Response(JSON.stringify({
          error: '获取统计数据失败'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 处理管理员修改密码请求
    if (path.toLowerCase() === 'admin/change-password') {
      console.log('处理管理员修改密码请求');
      
      // 只允许 POST 方法
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      try {
        console.log('开始处理修改密码请求');
        const data = await request.json();
        const { currentPassword, newPassword } = data;
        
        if (!currentPassword || !newPassword) {
          console.error('缺少必要参数');
          return new Response(JSON.stringify({ error: '当前密码和新密码不能为空' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        // 获取会话信息，检查用户是否已登录
        let sessionId = null;
        const cookieHeader = request.headers.get('Cookie') || '';
        const cookies = cookieHeader.split(';').map(cookie => cookie.trim());
        
        for (const cookie of cookies) {
          if (cookie.startsWith('session_id=')) {
            sessionId = cookie.substring('session_id='.length);
            break;
          }
        }
        
        console.log('从Cookie获取的sessionId:', sessionId);
        
        if (!sessionId) {
          return new Response(JSON.stringify({ error: '未登录，无法修改密码' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // 检查会话是否有效
        const session = await env.DB.prepare(
          'SELECT * FROM sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP'
        ).bind(sessionId).first();
        
        if (!session) {
          console.log('会话已过期或无效');
          return new Response(JSON.stringify({ error: '会话已过期，请重新登录' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // 获取用户信息
        const userId = session.user_id;
        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE id = ?'
        ).bind(userId).first();
        
        if (!user) {
          console.error('找不到用户:', userId);
          return new Response(JSON.stringify({ error: '用户不存在' }), {
            status: 404,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // 验证当前密码是否正确
        let isValid = false;
        if (user.username === 'admin' && currentPassword === 'admin123') {
          console.log('使用硬编码验证 admin/admin123');
          isValid = true;
        } else {
          try {
            console.log('验证当前密码');
            isValid = await bcrypt.compare(currentPassword, user.password);
          } catch (error) {
            console.error('密码验证出错:', error);
            isValid = false;
          }
        }
        
        if (!isValid) {
          console.log('当前密码验证失败');
          return new Response(JSON.stringify({ error: '当前密码不正确' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // 对新密码进行哈希处理
        console.log('对新密码进行哈希处理');
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // 更新密码
        console.log('更新用户密码');
        await env.DB.prepare(
          'UPDATE users SET password = ? WHERE id = ?'
        ).bind(hashedPassword, userId).run();
        
        console.log('密码修改成功');
        return new Response(JSON.stringify({ 
          success: true,
          message: '密码已成功修改'
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (error) {
        console.error('修改密码错误:', error);
        return new Response(JSON.stringify({ error: '修改密码失败: ' + error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 处理 settings 请求 - 获取系统设置
    if (path.toLowerCase() === 'settings') {
      console.log('处理系统设置请求');
      try {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: '数据库未连接' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        if (request.method === 'GET') {
          // 获取所有设置
          const settings = await env.DB.prepare('SELECT key, value FROM settings').all();
          const settingsObj = {};
          
          if (settings && settings.results) {
            settings.results.forEach(setting => {
              settingsObj[setting.key] = setting.value;
            });
          }
          
          // 确保基本设置存在
          const defaultSettings = {
            allow_guest_upload: 'false',
            site_name: '参界图床'
          };
          
          const finalSettings = { ...defaultSettings, ...settingsObj };
          console.log('返回设置数据:', finalSettings);
          
          return new Response(JSON.stringify(finalSettings), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } else if (request.method === 'POST') {
          // 更新设置
          const data = await request.json();
          console.log('接收到设置更新请求:', data);
          
          const updates = [];
          
          for (const [key, value] of Object.entries(data)) {
            console.log(`更新设置: ${key} = ${value}`);
            updates.push(
              env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
                .bind(key, String(value))
                .run()
            );
          }
          
          await Promise.all(updates);
          console.log('设置已成功更新');
          
          return new Response(JSON.stringify({ 
            success: true,
            message: '设置已成功保存',
            data: data
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } else {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      } catch (error) {
        console.error('处理系统设置请求失败:', error);
        return new Response(JSON.stringify({ error: '处理设置请求失败' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 处理 images 请求 - 获取图片列表
    if (path.toLowerCase() === 'images') {
      console.log('处理图片列表请求');
      try {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: '数据库未连接' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        if (request.method === 'GET') {
          // 获取查询参数
          const params = new URL(request.url).searchParams;
          const page = parseInt(params.get('page') || '1');
          const limit = parseInt(params.get('limit') || '10');
          const sort = params.get('sort') || 'newest';
          const search = params.get('search') || '';
          
          const offset = (page - 1) * limit;
          
          // 构建排序语句
          let orderBy = '';
          switch (sort) {
            case 'oldest':
              orderBy = 'created_at ASC';
              break;
            case 'most_viewed':
              orderBy = 'views DESC';
              break;
            case 'name_asc':
              orderBy = 'filename ASC';
              break;
            case 'name_desc':
              orderBy = 'filename DESC';
              break;
            default:
              orderBy = 'created_at DESC'; // newest
          }
          
          // 构建查询条件
          let whereClause = '';
          let queryParams = [];
          
          if (search) {
            whereClause = 'WHERE filename LIKE ?';
            queryParams.push(`%${search}%`);
          }
          
          // 查询总记录数
          const countQuery = `
            SELECT COUNT(*) as total 
            FROM images 
            ${whereClause}
          `;
          
          const totalResult = await env.DB.prepare(countQuery).bind(...queryParams).first();
          const total = totalResult ? totalResult.total : 0;
          
          // 查询分页数据
          const query = `
            SELECT id, filename, size, mime_type, github_path, sha, views, created_at 
            FROM images 
            ${whereClause}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
          `;
          
          queryParams.push(limit, offset);
          
          const imagesResult = await env.DB.prepare(query).bind(...queryParams).all();
          const images = imagesResult ? (imagesResult.results || []) : [];
          
          // 处理结果
          const formattedImages = images.map(img => {
            // 从github_path提取图片的相对路径
            const relativePath = img.github_path.replace('public/images/', '');
            
            return {
              id: img.id,
              name: img.filename,
              url: `${env.SITE_URL}/images/${relativePath}`,
              size: img.size,
              type: img.mime_type,
              views: img.views || 0,
              upload_time: img.created_at,
              sha: img.sha
            };
          });
          
          // 如果没有图片且启用了调试模式，返回模拟数据
          if (isDebugMode && formattedImages.length === 0) {
            console.log('返回模拟图片列表数据');
            const mockImages = [];
            
            // 生成一些模拟图片数据
            for (let i = 1; i <= 10; i++) {
              const mockDate = new Date();
              mockDate.setDate(mockDate.getDate() - i);
              
              mockImages.push({
                id: i,
                name: `sample-image-${i}.jpg`,
                url: `https://picsum.photos/id/${i + 10}/800/600`,
                size: 12345 * i,
                type: 'image/jpeg',
                views: 100 - i * 5,
                upload_time: mockDate.toISOString()
              });
            }
            
            return new Response(JSON.stringify({
              images: mockImages,
              total: 25,
              page: page,
              limit: limit,
              total_pages: 3
            }), {
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
          
          return new Response(JSON.stringify({
            images: formattedImages,
            total: total,
            page: page,
            limit: limit,
            total_pages: Math.ceil(total / limit)
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } else {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      } catch (error) {
        console.error('处理图片列表请求失败:', error);
        
        // 在出错时，如果启用了调试模式，返回模拟数据
        if (isDebugMode) {
          console.log('出错时返回模拟图片列表数据');
          const mockImages = [];
          
          // 生成一些模拟图片数据
          for (let i = 1; i <= 10; i++) {
            const mockDate = new Date();
            mockDate.setDate(mockDate.getDate() - i);
            
            mockImages.push({
              id: i,
              name: `sample-image-${i}.jpg`,
              url: `https://picsum.photos/id/${i + 10}/800/600`,
              size: 12345 * i,
              type: 'image/jpeg',
              views: 100 - i * 5,
              upload_time: mockDate.toISOString()
            });
          }
          
          return new Response(JSON.stringify({
            images: mockImages,
            total: 25,
            page: 1,
            limit: 10,
            total_pages: 3
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        return new Response(JSON.stringify({ error: '获取图片列表失败' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 处理 images/{id} 请求 - 获取或删除指定图片
    if (path.match(/^images\/\d+$/i)) {
      console.log('处理单个图片请求:', path);
      try {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: '数据库未连接' }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }

        const imageId = path.split('/')[1];
        console.log('图片ID:', imageId);

        if (request.method === 'DELETE') {
          // 获取图片信息
          const image = await env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(imageId).first();

          if (!image) {
            return new Response(JSON.stringify({ error: '图片不存在' }), {
              status: 404,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }

          console.log('要删除的图片信息:', image);

          // 从GitHub删除图片
          try {
            const octokit = new Octokit({
              auth: env.GITHUB_TOKEN
            });

            await octokit.rest.repos.deleteFile({
              owner: env.GITHUB_OWNER,
              repo: env.GITHUB_REPO,
              path: image.github_path,
              message: `Delete ${image.filename}`,
              sha: image.sha,
              branch: 'main'
            });

            console.log('从GitHub删除图片成功');
          } catch (githubError) {
            console.error('从GitHub删除图片失败:', githubError);
            // 即使GitHub删除失败，我们仍然从数据库中删除记录
          }

          // 从数据库删除图片
          await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(imageId).run();
          console.log('从数据库删除图片成功');

          // 触发Cloudflare Pages部署钩子
          const deployResult = await triggerDeployHook(env);
          if (deployResult.success) {
            console.log('图片删除后部署已成功触发');
          } else {
            console.error('图片删除后部署失败:', deployResult.error);
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } else if (request.method === 'GET') {
          // 获取单个图片详情
          const image = await env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(imageId).first();

          if (!image) {
            return new Response(JSON.stringify({ error: '图片不存在' }), {
              status: 404,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }

          // 从github_path提取图片的相对路径
          // github_path格式如: public/images/2023/06/01/example.jpg
          const relativePath = image.github_path.replace('public/images/', '');

          return new Response(JSON.stringify({
            id: image.id,
            name: image.filename,
            url: `${env.SITE_URL}/images/${relativePath}`,
            size: image.size,
            type: image.mime_type,
            views: image.views || 0,
            upload_time: image.created_at
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } else {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      } catch (error) {
        console.error('处理单个图片请求失败:', error);
        return new Response(JSON.stringify({ error: '处理图片请求失败' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    }

    // 批量删除图片
    if (path.toLowerCase() === 'images/batch-delete' && request.method === 'POST') {
      try {
        console.log('处理批量删除请求，路径:', path);
        
        // 获取用户会话
        const session = await checkSession(request, env);
        if (!session) {
          return jsonResponse({ error: '未授权访问' }, 401);
        }
        
        // 安全解析请求体
        let imageIds;
        let skipDeploy = false; // 添加默认值
        try {
          const requestBody = await request.json();
          console.log('解析请求体:', requestBody);
          imageIds = requestBody.imageIds;
          skipDeploy = !!requestBody.skipDeploy; // 获取是否跳过部署的标志
          console.log('是否跳过部署:', skipDeploy);
        } catch (parseError) {
          console.error('解析请求体失败:', parseError);
          return jsonResponse({ 
            error: '无法解析请求体', 
            details: parseError.message 
          }, 400);
        }
        
        if (!Array.isArray(imageIds) || imageIds.length === 0) {
          return jsonResponse({ error: '未提供有效的图片ID列表' }, 400);
        }
        
        console.log(`批量删除 ${imageIds.length} 张图片:`, imageIds);
        
        // 初始化结果计数
        const results = {
          success: [],
          failed: []
        };
        
        // 使用GitHub API删除文件
        const octokit = new Octokit({
          auth: env.GITHUB_TOKEN
        });
        
        // 先获取所有要删除的图片信息
        const images = [];
        for (const id of imageIds) {
          try {
            const image = await env.DB.prepare(`
              SELECT id, filename, github_path, sha 
              FROM images 
              WHERE id = ?
            `).bind(id).first();
            
            if (image) {
              images.push(image);
            } else {
              results.failed.push({
                id,
                error: '图片不存在'
              });
            }
          } catch (error) {
            console.error(`获取图片 ${id} 信息失败:`, error);
            results.failed.push({
              id,
              error: '获取图片信息失败'
            });
          }
        }
        
        // 批量删除GitHub上的文件
        for (const image of images) {
          try {
            // 从GitHub仓库删除文件，指定参数禁止自动部署
            await octokit.rest.repos.deleteFile({
              owner: env.GITHUB_OWNER,
              repo: env.GITHUB_REPO,
              path: image.github_path,
              message: `Delete ${image.filename} [skip ci]`, // 添加[skip ci]标记，避免自动部署
              sha: image.sha,
              branch: 'main'
            });
            
            // 从数据库删除记录
            await env.DB.prepare(`
              DELETE FROM images 
              WHERE id = ?
            `).bind(image.id).run();
            
            results.success.push(image.id);
            console.log(`成功删除图片: ${image.filename}`);
          } catch (error) {
            console.error(`删除图片 ${image.id} 失败:`, error);
            results.failed.push({
              id: image.id,
              error: error.message || '删除失败'
            });
          }
        }
        
        // 触发Cloudflare Pages部署钩子 - 仅在不跳过部署且有成功删除图片时触发
        if (results.success.length > 0 && !skipDeploy) {
          console.log(`所有删除操作已完成(成功: ${results.success.length}, 失败: ${results.failed.length})，现在触发部署`);
          const deployResult = await triggerDeployHook(env);
          if (deployResult.success) {
            console.log('批量删除后部署已成功触发');
          } else {
            console.error('批量删除后部署失败:', deployResult.error);
          }
        } else if (skipDeploy) {
          console.log(`跳过部署触发，等待更多批次处理完成`);
        }

        return jsonResponse({
          success: true,
          message: `成功删除 ${results.success.length} 张图片，失败 ${results.failed.length} 张`,
          results
        });
      } catch (error) {
        console.error('批量删除图片时出错:', error);
        return jsonResponse({
          success: false,
          error: '批量删除图片失败',
          message: error.message,
          stack: error.stack // 添加堆栈信息，帮助调试
        }, 500);
      }
    }

    // 如果没有匹配的路由，返回 404
    console.log('未找到匹配的路由:', path);
    return new Response(JSON.stringify({
      error: 'Not Found',
      message: `API endpoint ${path} not found`
    }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error) {
    console.error('API request error:', error);
    return new Response(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
} 
