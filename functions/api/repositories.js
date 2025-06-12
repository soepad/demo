import { Octokit } from 'octokit';
import { 
  getActiveRepository, 
  getAllRepositories, 
  createNewRepository,
  updateRepositorySizeEstimate,
  syncRepositoryFileCount,
  syncAllRepositoriesFileCount
} from './repository-manager.js';

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
    
    // 检查是否达到阈值
    const thresholdSetting = await env.DB.prepare(`
      SELECT value FROM settings WHERE key = 'repository_size_threshold'
    `).first();
    
    // 确保解析为整数，使用默认值900MB如果没有设置
    const repoSizeThreshold = thresholdSetting && !isNaN(parseInt(thresholdSetting.value)) ? 
      parseInt(thresholdSetting.value) : 
      900 * 1024 * 1024; // 默认900MB
    
    console.log(`使用仓库大小阈值: ${repoSizeThreshold} 字节 (${Math.round(repoSizeThreshold / (1024 * 1024))}MB)`);
    console.log(`当前仓库实际大小: ${actualSize} 字节 (${Math.round(actualSize / (1024 * 1024))}MB)`);
    
    // 如果达到或超过阈值，更新状态
    if (actualSize >= repoSizeThreshold) {
      await env.DB.prepare(`
        UPDATE repositories SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(repoId).run();
      
      console.log(`仓库 ${repo.name} 已达到大小阈值 ${Math.round(repoSizeThreshold / (1024 * 1024))}MB，状态更新为 'inactive'`);
    } else if (actualSize < repoSizeThreshold && repo.status === 'inactive') {
      // 如果之前标记为不活跃但现在未满，恢复状态
      await env.DB.prepare(`
        UPDATE repositories SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(repoId).run();
      
      console.log(`仓库 ${repo.name} 大小低于阈值 ${Math.round(repoSizeThreshold / (1024 * 1024))}MB，状态更新为 'active'`);
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
      
      // 获取每个仓库的文件数量和总大小
      for (const repo of repos) {
        const stats = await env.DB.prepare(`
          SELECT 
            COUNT(*) as file_count,
            COALESCE(SUM(size), 0) as total_size
          FROM images 
          WHERE repository_id = ?
        `).bind(repo.id).first();
        
        repo.file_count = stats.file_count;
        repo.total_size = stats.total_size;
        
        // 获取仓库大小阈值
        const thresholdSetting = await env.DB.prepare(`
          SELECT value FROM settings WHERE key = 'repository_size_threshold'
        `).first();
        
        repo.size_limit = thresholdSetting && !isNaN(parseInt(thresholdSetting.value)) ? 
          parseInt(thresholdSetting.value) : 
          900 * 1024 * 1024; // 默认900MB
      }
      
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
        error: error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 同步仓库文件计数
  if (path.startsWith('/sync-file-count/') && request.method === 'POST') {
    try {
      const repoId = parseInt(path.replace('/sync-file-count/', ''));
      
      if (isNaN(repoId)) {
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
      
      console.log(`同步仓库(ID: ${repoId})的文件计数`);
      const result = await syncRepositoryFileCount(env, repoId);
      
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('同步仓库文件计数失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '同步仓库文件计数失败: ' + error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
  
  // 同步所有仓库文件计数
  if (path === '/sync-all-file-counts' && request.method === 'POST') {
    try {
      console.log('同步所有仓库的文件计数');
      const result = await syncAllRepositoriesFileCount(env);
      
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('同步所有仓库文件计数失败:', error);
      return new Response(JSON.stringify({
        success: false,
        error: '同步所有仓库文件计数失败: ' + error.message
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
      
      try {
        const data = await request.json();
        if (data && data.baseName) {
          baseName = data.baseName;
        }
        console.log('解析请求JSON成功:', data);
      } catch (parseError) {
        console.warn('解析请求JSON失败，使用默认仓库名称:', parseError);
      }
      
      console.log(`创建新仓库，使用基础名称: ${baseName}`);
      
      try {
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
        const newRepo = await createNewRepository(env, baseName);
        
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
  
  // 简化创建仓库的API端点已移除，只使用标准GitHub API创建仓库
  
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
