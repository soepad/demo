import { Hono } from 'hono';
import { Octokit } from 'octokit';
import bcrypt from 'bcryptjs';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono();
const api = new Hono();

// 错误处理中间件
app.use('*', async (c, next) => {
    try {
        await next();
    } catch (err) {
        console.error('Error:', err);
        return c.json({ error: 'Internal Server Error' }, 500);
    }
});

// 请求日志中间件
app.use('*', async (c, next) => {
    console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}`);
    await next();
});

// 应用中间件
app.use('*', sessionMiddleware);
app.use('*', checkAdminAccess);
app.use('*', checkGuestUpload);

// 添加调试中间件
app.use('/api/*', async (c, next) => {
    console.log('API Request:', {
        method: c.req.method,
        path: c.req.path,
        headers: Object.fromEntries(c.req.headers.entries())
    });
    await next();
});

// 挂载 API 路由
app.route('/api', api);

// 处理静态文件
app.use('/*', serveStatic({ root: './' }));

// 验证 reCAPTCHA
async function verifyRecaptcha(token, c) {
    if (!token || !c.env.RECAPTCHA_SECRET_KEY) {
        return true; // 如果没有配置 reCAPTCHA，直接返回 true
    }

    try {
        const response = await fetch('https://recaptcha.net/recaptcha/api/siteverify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `secret=${c.env.RECAPTCHA_SECRET_KEY}&response=${token}`
        });

        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('reCAPTCHA verification error:', error);
        return false;
    }
}

// 中间件：会话管理
async function sessionMiddleware(c, next) {
    const sessionId = getCookie(c, 'session_id');
    
    if (sessionId) {
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

// 中间件：检查管理后台访问权限
async function checkAdminAccess(c, next) {
    // 只检查 /admin/ 路径，且排除登录页面和API
    if (c.req.path.startsWith('/admin/') && 
        !c.req.path.includes('/admin/login.html') && 
        !c.req.path.includes('/api/admin/login')) {
        const session = c.get('session');
        if (!session || !session.userId) {
            return c.redirect('/admin/login.html');
        }
    }
    await next();
}

// 中间件：检查是否允许游客上传
async function checkGuestUpload(c, next) {
    // 只检查上传路径
    if (c.req.path === '/api/upload' && c.req.method === 'POST') {
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

// 中间件：管理员验证
async function requireAdmin(c, next) {
    const session = await c.get('session');
    if (!session || !session.userId) {
        return c.json({ error: '请先登录' }, 401);
    }
    await next();
}

// API routes
api.get('/settings/guest-upload', async (c) => {
    console.log('Entering /settings/guest-upload handler');
    try {
        if (!c.env.DB) {
            console.error('Database not bound!');
            return c.json({
                success: false,
                error: 'Database not configured'
            }, 500);
        }

        const result = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
            .bind('allow_guest_upload')
            .first();
        
        console.log('Guest upload setting:', result);
        
        // 设置正确的 Content-Type
        c.header('Content-Type', 'application/json');
        
        return c.json({
            success: true,
            data: {
                allowGuestUpload: result?.value === 'true'
            }
        });
    } catch (error) {
        console.error('Error fetching guest upload settings:', error);
        // 确保错误响应也是 JSON 格式
        c.header('Content-Type', 'application/json');
        return c.json({
            success: false,
            error: 'Failed to fetch settings'
        }, 500);
    }
});

api.post('/upload', async (c) => {
    try {
        const formData = await c.req.formData();
        const file = formData.get('file');
        
        if (!file) {
            return c.json({ 
                success: false,
                error: '未找到文件' 
            }, 400);
        }

        // 初始化 Octokit
        const octokit = new Octokit({
            auth: c.env.GITHUB_TOKEN
        });
        
        // 检查文件是否已存在
        const filePath = `images/${file.name}`;
        try {
            const existingFile = await octokit.rest.repos.getContent({
                owner: c.env.GITHUB_OWNER,
                repo: c.env.GITHUB_REPO,
                path: filePath,
                ref: 'main'
            });
            
            // 如果没有抛出错误，说明文件存在
            return c.json({ 
                success: false,
                error: `文件 "${file.name}" 已存在，请重命名后重试`,
                details: 'File already exists'
            }, 409);
        } catch (existingFileError) {
            // 如果是404错误，说明文件不存在，可以继续上传
            if (existingFileError.status !== 404) {
                // 如果是其他错误，记录下来，但继续尝试上传
                console.warn('检查文件是否存在时出错:', existingFileError);
            }
        }

        // 上传到 GitHub
        const buffer = await file.arrayBuffer();
        const content = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        
        const response = await octokit.rest.repos.createOrUpdateFileContents({
            owner: c.env.GITHUB_OWNER,
            repo: c.env.GITHUB_REPO,
            path: filePath,
            message: `Upload ${file.name}`,
            content: content,
            branch: 'main'
        });

        // 保存到数据库
        await c.env.DB.prepare(`
            INSERT INTO images (filename, size, mime_type, github_path, sha, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime(?), datetime(?))
        `).bind(
            file.name,
            file.size,
            file.type,
            filePath,
            response.data.content.sha,
            formatBeijingTimeString(new Date(Date.now() + 8 * 60 * 60 * 1000)),
            formatBeijingTimeString(new Date(Date.now() + 8 * 60 * 60 * 1000))
        ).run();

        // 返回各种格式的链接
        const imageUrl = `${c.env.SITE_URL}/images/${file.name}`;
        return c.json({
            success: true,
            data: {
                url: imageUrl,
                markdown: `![${file.name}](${imageUrl})`,
                html: `<img src="${imageUrl}" alt="${file.name}">`,
                bbcode: `[img]${imageUrl}[/img]`
            }
        });
    } catch (error) {
        console.error('Upload error:', error);
        
        // 处理特定错误类型
        if (error.message && error.message.includes('already exists')) {
            return c.json({ 
                success: false, 
                error: `文件 "${file.name}" 已存在，请重命名后重试`,
                details: 'File already exists'
            }, 409);
        } else if (error.status === 403 || error.status === 401) {
            return c.json({ 
                success: false, 
                error: 'GitHub授权失败，请检查Token是否正确',
                message: error.message
            }, error.status);
        }
        
        // 一般错误
        return c.json({ 
            success: false, 
            error: '上传失败', 
            message: error.message,
            details: {
                stack: error.stack,
                env: {
                    hasGithubToken: !!c.env.GITHUB_TOKEN,
                    hasGithubOwner: !!c.env.GITHUB_OWNER,
                    hasGithubRepo: !!c.env.GITHUB_REPO,
                    hasSiteUrl: !!c.env.SITE_URL,
                    hasDB: !!c.env.DB
                }
            }
        }, 500);
    }
});

api.post('/admin/login', async (c) => {
    try {
        const { username, password, recaptchaResponse } = await c.req.json();
        
        // 验证 reCAPTCHA
        if (c.env.RECAPTCHA_SECRET_KEY) {
            if (!recaptchaResponse) {
                return c.json({ error: '请完成人机验证' }, 400);
            }
            
            const isValid = await verifyRecaptcha(recaptchaResponse, c);
            if (!isValid) {
                return c.json({ error: '人机验证失败' }, 400);
            }
        }
        
        // 查询用户
        const user = await c.env.DB.prepare(
            'SELECT * FROM users WHERE username = ?'
        ).bind(username).first();
        
        if (!user) {
            return c.json({ error: '用户名或密码错误' }, 401);
        }
        
        // 验证密码
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return c.json({ error: '用户名或密码错误' }, 401);
        }
        
        // 创建会话
        const sessionId = crypto.randomUUID();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7天后过期
        
        await c.env.DB.prepare(`
            INSERT INTO sessions (id, user_id, username, expires_at)
            VALUES (?, ?, ?, ?)
        `).bind(
            sessionId,
            user.id,
            user.username,
            expiresAt.toISOString()
        ).run();
        
        // 设置 cookie
        setCookie(c, 'session_id', sessionId, {
            httpOnly: true,
            secure: true,
            sameSite: 'Strict',
            expires: expiresAt,
            path: '/'
        });
        
        return c.json({ success: true });
    } catch (error) {
        console.error('Login error:', error);
        return c.json({ error: '登录失败' }, 500);
    }
});

// 导出处理函数
export default app;

// 辅助函数：格式化北京时间为字符串
function formatBeijingTimeString(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
} 
