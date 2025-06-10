import { Octokit } from 'octokit';
import { 
  getActiveRepository, 
  getAllRepositories, 
  createNewRepository,
  updateRepositorySizeEstimate
} from './repository-manager.js';

/**
 * 创建简单仓库（不调用GitHub API）
 * @param {Object} env - 环境变量
 * @param {string} repoName - 仓库名称
 * @returns {Promise<Object>} - 返回仓库信息
 */
async function createSimpleRepository(env, repoName) {
  try {
    console.log('创建简单仓库（不调用GitHub API）:', repoName);
    
    // 检查数据库中是否已存在同名仓库
    const existingRepo = await env.DB.prepare(`
      SELECT * FROM repositories WHERE name = ?
    `).bind(repoName).first();
    
    if (existingRepo) {
      console.log(`仓库 ${repoName} 已存在，返回现有仓库`);
      return {
        id: existingRepo.id,
        owner: existingRepo.owner || env.GITHUB_OWNER || 'default-owner',
        repo: existingRepo.name,
        status: existingRepo.status
      };
    }
    
    // 检查repositories表是否存在
    try {
      const tableExists = await env.DB.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='repositories'
      `).first();
      
      if (!tableExists) {
        console.log('repositories表不存在，创建表');
        
        // 创建repositories表
        await env.DB.exec(`
          CREATE TABLE IF NOT EXISTS repositories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            owner TEXT NOT NULL,
            token TEXT,
            deploy_hook TEXT,
            status TEXT DEFAULT 'active',
            size_estimate INTEGER DEFAULT 0,
            file_count INTEGER DEFAULT 0,
            priority INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        
        console.log('repositories表创建成功');
      }
    } catch (tableError) {
      console.error('检查或创建表失败:', tableError);
      // 继续尝试插入，可能表已经存在
    }
    
    // 先将所有仓库设置为非活跃
    try {
      await env.DB.prepare(`
        UPDATE repositories SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active'
      `).run();
      console.log('将所有现有仓库设置为非活跃');
    } catch (updateError) {
      console.warn('更新现有仓库状态失败，可能没有现有仓库:', updateError);
      // 继续创建新仓库
    }
    
    // 插入新仓库记录
    const owner = env.GITHUB_OWNER || 'default-owner';
    let result;
    
    try {
      result = await env.DB.prepare(`
        INSERT INTO repositories (name, owner, status, created_at, updated_at)
        VALUES (?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
      `).bind(repoName, owner).first();
      
      console.log('插入仓库记录成功:', result);
    } catch (insertError) {
      console.error('插入仓库记录失败:', insertError);
      throw new Error(`创建仓库记录失败: ${insertError.message}`);
    }
    
    if (!result || !result.id) {
      throw new Error('创建仓库成功但未返回ID');
    }
    
    // 返回新仓库信息
    return {
      id: result.id,
      owner: owner,
      repo: repoName,
      status: 'active'
    };
  } catch (error) {
    console.error('创建简单仓库失败:', error);
    throw error;
  }
}

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
 * 获取仓库大小
 * @param {Object} env - 环境变量
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名称
 * @param {string} token - GitHub令牌
 * @returns {Promise<number>} - 仓库大小（字节）
 */
async function getRepositorySize(env, owner, repo, token) {
  try {
    const octokit = new Octokit({
      auth: token || env.GITHUB_TOKEN
    });
    
    // 获取仓库信息
    const repoInfo = await octokit.rest.repos.get({
      owner,
      repo
    });
    
    // 返回仓库大小（KB转换为字节）
    return repoInfo.data.size * 1024;
  } catch (error) {
    console.error(`获取仓库 ${owner}/${repo} 大小失败:`, error);
    return 0;
  }
}

/**
 * 同步仓库大小
 * @param {Object} env - 环境变量
 * @param {number} repoId - 仓库ID
 * @returns {Promise<Object>} - 同步结果
 */
async function syncRepositorySize(env, repoId) {
  try {
    // 获取仓库信息
    const repo = await env.DB.prepare(`
      SELECT * FROM repositories WHERE id = ?
    `).bind(repoId).first();
    
    if (!repo) {
      return { success: false, error: '仓库不存在' };
    }
    
    // 获取实际仓库大小
    const actualSize = await getRepositorySize(
      env, 
      repo.owner, 
      repo.name, 
      repo.token || env.GITHUB_TOKEN
    );
    
    // 更新数据库中的大小估算
    await env.DB.prepare(`
      UPDATE repositories 
      SET size_estimate = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(actualSize, repoId).run();
    
    // 检查是否达到阈值
    const thresholdSetting = await env.DB.prepare(`
      SELECT value FROM settings WHERE key = 'repository_size_threshold'
    `).first();
    
    const repoSizeThreshold = thresholdSetting ? 
      parseInt(thresholdSetting.value) : 
      900 * 1024 * 1024; // 默认900MB
    
    // 如果达到或超过阈值，更新状态
    if (actualSize >= repoSizeThreshold && repo.status !== 'full') {
      await env.DB.prepare(`
        UPDATE repositories SET status = 'full', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(repoId).run();
      
      console.log(`仓库 ${repo.name} 已达到大小阈值，状态更新为 'full'`);
    } else if (actualSize < repoSizeThreshold && repo.status === 'full') {
      // 如果之前标记为满但现在未满，恢复状态
      await env.DB.prepare(`
        UPDATE repositories SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(repoId).run();
      
      console.log(`仓库 ${repo.name} 大小低于阈值，状态更新为 'active'`);
    }
    
    return { 
      success: true, 
      size: actualSize,
      threshold: repoSizeThreshold,
      isFull: actualSize >= repoSizeThreshold
    };
  } catch (error) {
    console.error('同步仓库大小失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 处理请求
 * @param {Object} context - 请求上下文
 * @returns {Promise<Response>} - 响应对象
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/repositories', '');
  
  console.log('处理仓库管理请求:', path);
  
  // 处理OPTIONS请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  
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
  
  // 获取所有仓库列表
  if (path === '' && request.method === 'GET') {
    try {
      const repos = await getAllRepositories(env);
      
      return new Response(JSON.stringify({
        success: true,
        data: repos
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('获取仓库列表失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '获取仓库列表失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 创建新仓库
  if ((path === '/create' || path === '') && request.method === 'POST') {
    try {
      console.log('收到创建仓库请求');
      
      // 检查数据库连接
      if (!env.DB) {
        console.error('缺少数据库连接');
        return new Response(JSON.stringify({
          success: false,
          error: '服务器配置错误: 数据库未连接'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 尝试检查数据库连接
      try {
        await env.DB.prepare('SELECT 1').first();
      } catch (dbTestError) {
        console.error('数据库连接测试失败:', dbTestError);
        return new Response(JSON.stringify({
          success: false,
          error: '数据库连接失败: ' + dbTestError.message
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      let baseName = 'images-repo';
      let useSimpleMode = true; // 默认使用简化模式
      
      try {
        const data = await request.json();
        if (data && data.baseName) {
          baseName = data.baseName;
        }
        if (data && typeof data.useSimpleMode === 'boolean') {
          useSimpleMode = data.useSimpleMode;
        }
        console.log('解析请求JSON成功:', data);
      } catch (parseError) {
        console.warn('解析请求JSON失败，使用默认仓库名称:', parseError);
      }
      
      console.log(`创建新仓库，使用基础名称: ${baseName}, 简化模式: ${useSimpleMode}`);
      
      try {
        let newRepo;
        
        if (useSimpleMode) {
          // 使用简化模式创建仓库（不调用GitHub API）
          const repoName = `${baseName}-${Date.now()}`;
          newRepo = await createSimpleRepository(env, repoName);
        } else {
          // 检查GitHub相关环境变量
          if (!env.GITHUB_TOKEN) {
            console.error('缺少GITHUB_TOKEN环境变量');
            return new Response(JSON.stringify({
              success: false,
              error: '服务器配置错误: 缺少GitHub令牌'
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
          
          if (!env.GITHUB_OWNER) {
            console.error('缺少GITHUB_OWNER环境变量');
            return new Response(JSON.stringify({
              success: false,
              error: '服务器配置错误: 缺少GitHub所有者'
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
          
          // 使用GitHub API创建仓库
          newRepo = await createNewRepository(env, baseName);
        }
        
        console.log('仓库创建成功:', newRepo);
        
        return new Response(JSON.stringify({
          success: true,
          data: newRepo
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (repoError) {
        console.error('创建仓库失败:', repoError);
        return new Response(JSON.stringify({
          success: false,
          error: '创建仓库失败: ' + repoError.message
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    } catch (error) {
      console.error('处理创建仓库请求失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '处理创建仓库请求失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 添加简化创建仓库的API端点
  if (path === '/create-simple' && request.method === 'POST') {
    try {
      console.log('收到简化创建仓库请求');
      
      // 检查数据库连接
      if (!env.DB) {
        console.error('缺少数据库连接');
        return new Response(JSON.stringify({
          success: false,
          error: '服务器配置错误: 数据库未连接'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      let repoName = `images-repo-${Date.now()}`;
      
      try {
        const data = await request.json();
        if (data && data.repoName) {
          repoName = data.repoName;
        }
        console.log('解析请求JSON成功:', data);
      } catch (parseError) {
        console.warn('解析请求JSON失败，使用默认仓库名称:', parseError);
      }
      
      console.log('创建简化仓库，使用名称:', repoName);
      
      try {
        const newRepo = await createSimpleRepository(env, repoName);
        
        console.log('简化仓库创建成功:', newRepo);
        
        return new Response(JSON.stringify({
          success: true,
          data: newRepo
        }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      } catch (repoError) {
        console.error('创建简化仓库失败:', repoError);
        return new Response(JSON.stringify({
          success: false,
          error: '创建简化仓库失败: ' + repoError.message
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
    } catch (error) {
      console.error('处理创建简化仓库请求失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '处理创建简化仓库请求失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 更新仓库状态
  if (path.startsWith('/status/') && request.method === 'PUT') {
    try {
      const repoId = parseInt(path.replace('/status/', ''));
      const data = await request.json();
      const { status } = data;
      
      if (!repoId || isNaN(repoId)) {
        return new Response(JSON.stringify({
          success: false,
          error: '无效的仓库ID'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      if (!['active', 'inactive', 'full'].includes(status)) {
        return new Response(JSON.stringify({
          success: false,
          error: '无效的状态值，必须为 active、inactive 或 full'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 更新状态
      await env.DB.prepare(`
        UPDATE repositories 
        SET status = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).bind(status, repoId).run();
      
      return new Response(JSON.stringify({
        success: true,
        message: `仓库状态已更新为 ${status}`
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('更新仓库状态失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '更新仓库状态失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 同步仓库大小
  if (path.startsWith('/sync-size/') && request.method === 'POST') {
    try {
      const repoId = parseInt(path.replace('/sync-size/', ''));
      
      if (!repoId || isNaN(repoId)) {
        return new Response(JSON.stringify({
          success: false,
          error: '无效的仓库ID'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      const result = await syncRepositorySize(env, repoId);
      
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('同步仓库大小失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '同步仓库大小失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 同步所有仓库大小
  if (path === '/sync-all-sizes' && request.method === 'POST') {
    try {
      const repos = await getAllRepositories(env);
      const results = [];
      
      for (const repo of repos) {
        const result = await syncRepositorySize(env, repo.id);
        results.push({
          id: repo.id,
          name: repo.name,
          ...result
        });
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: results
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('同步所有仓库大小失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '同步所有仓库大小失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 激活仓库
  if (path.match(/^\/\d+\/activate$/) && request.method === 'POST') {
    try {
      const repoId = parseInt(path.replace('/activate', '').substring(1));
      
      if (!repoId || isNaN(repoId)) {
        return new Response(JSON.stringify({
          success: false,
          error: '无效的仓库ID'
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }
      
      // 先将所有仓库设置为非活跃
      await env.DB.prepare(`
        UPDATE repositories SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active'
      `).run();
      
      // 将指定仓库设置为活跃
      await env.DB.prepare(`
        UPDATE repositories SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(repoId).run();
      
      return new Response(JSON.stringify({
        success: true,
        message: '仓库已设置为活跃状态'
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('激活仓库失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '激活仓库失败: ' + error.message
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
