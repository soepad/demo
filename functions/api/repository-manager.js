import { Octokit } from 'octokit';
import { v4 as uuidv4 } from 'uuid';

/**
 * 获取当前活跃仓库
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} - 返回活跃仓库信息
 */
export async function getActiveRepository(env) {
  try {
    // 查询数据库中的活跃仓库
    const repo = await env.DB.prepare(`
      SELECT * FROM repositories 
      WHERE status = 'active' 
      ORDER BY priority ASC, id ASC 
      LIMIT 1
    `).first();
    
    // 如果没有找到活跃仓库
    if (!repo) {
      console.log('没有找到活跃仓库，尝试创建默认仓库');
      
      // 检查是否有环境变量定义的仓库信息
      if (env.GITHUB_REPO && env.GITHUB_OWNER) {
        // 创建默认仓库记录
        await env.DB.prepare(`
          INSERT INTO repositories (name, owner, status, is_default, priority)
          VALUES (?, ?, 'active', 1, 0)
        `).bind(env.GITHUB_REPO, env.GITHUB_OWNER).run();
        
        // 更新设置
        await env.DB.prepare(`
          INSERT OR REPLACE INTO settings (key, value, updated_at)
          VALUES ('initial_repository_name', ?, CURRENT_TIMESTAMP)
        `).bind(env.GITHUB_REPO).run();
        
        await env.DB.prepare(`
          INSERT OR REPLACE INTO settings (key, value, updated_at)
          VALUES ('initial_repository_owner', ?, CURRENT_TIMESTAMP)
        `).bind(env.GITHUB_OWNER).run();
        
        // 重新查询
        const newRepo = await env.DB.prepare(`
          SELECT * FROM repositories 
          WHERE name = ? AND owner = ?
        `).bind(env.GITHUB_REPO, env.GITHUB_OWNER).first();
        
        if (newRepo) {
          return {
            id: newRepo.id,
            owner: newRepo.owner,
            repo: newRepo.name,
            token: newRepo.token || env.GITHUB_TOKEN,
            deployHook: newRepo.deploy_hook || env.DEPLOY_HOOK
          };
        }
      }
      
      throw new Error('没有可用的活跃仓库，且无法创建默认仓库');
    }
    
    // 返回仓库信息
    return {
      id: repo.id,
      owner: repo.owner || env.GITHUB_OWNER,
      repo: repo.name,
      token: repo.token || env.GITHUB_TOKEN,
      deployHook: repo.deploy_hook || env.DEPLOY_HOOK
    };
  } catch (error) {
    console.error('获取活跃仓库失败:', error);
    
    // 回退到环境变量
    if (env.GITHUB_REPO && env.GITHUB_OWNER) {
      return {
        id: null,
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        token: env.GITHUB_TOKEN,
        deployHook: env.DEPLOY_HOOK
      };
    }
    
    throw error;
  }
}

/**
 * 创建新的GitHub仓库
 * @param {Object} env - 环境变量
 * @param {string} currentRepoName - 当前仓库名称
 * @returns {Promise<Object>} - 返回新仓库信息
 */
export async function createNewRepository(env, currentRepoName) {
  try {
    const octokit = new Octokit({
      auth: env.GITHUB_TOKEN
    });
    
    // 获取命名规则设置
    const nameTemplateSetting = await env.DB.prepare(`
      SELECT value FROM settings WHERE key = 'repository_name_template'
    `).first();
    
    // 决定基础仓库名称
    let baseRepoName;
    if (nameTemplateSetting && nameTemplateSetting.value && nameTemplateSetting.value.trim() !== '') {
      // 使用设置中的命名规则
      baseRepoName = nameTemplateSetting.value.trim();
      console.log(`使用设置的命名规则: ${baseRepoName}`);
    } else {
      // 使用当前仓库名称作为基础
      baseRepoName = currentRepoName.replace(/-\d+$/, '');
      console.log(`使用默认命名规则，基于当前仓库: ${baseRepoName}`);
    }
    
    // 获取已存在的同名仓库
    let maxNumber = 0;
    try {
      // 查询数据库中已存在的同名仓库
      const existingRepos = await env.DB.prepare(`
        SELECT name FROM repositories WHERE name LIKE ?
      `).bind(`${baseRepoName}-%`).all();
      
      // 找出最大序号
      for (const repo of existingRepos.results || []) {
        const match = repo.name.match(/-(\d+)$/);
        if (match) {
          const num = parseInt(match[1]);
          if (num > maxNumber) {
            maxNumber = num;
          }
        }
      }
    } catch (error) {
      console.warn('查询已存在仓库失败，使用默认序号:', error);
    }
    
    // 生成新序号
    const newRepoNumber = maxNumber + 1;
    const newRepoName = `${baseRepoName}-${newRepoNumber}`;
    
    console.log(`尝试创建新仓库: ${newRepoName}`);
    
    // 检查仓库是否已存在
    try {
      const existingRepo = await octokit.rest.repos.get({
        owner: env.GITHUB_OWNER,
        repo: newRepoName
      });
      
      if (existingRepo.status === 200) {
        console.log(`仓库 ${newRepoName} 已存在，跳过创建`);
      }
    } catch (error) {
      if (error.status === 404) {
        // 仓库不存在，创建新仓库
        await octokit.rest.repos.createInOrg({
          org: env.GITHUB_OWNER,
          name: newRepoName,
          auto_init: true,
          private: true,
          description: `图片存储仓库 #${newRepoNumber}`
        });
        
        console.log(`成功创建新仓库: ${newRepoName}`);
        
        // 创建必要的目录结构
        await octokit.rest.repos.createOrUpdateFileContents({
          owner: env.GITHUB_OWNER,
          repo: newRepoName,
          path: 'public/images/.gitkeep',
          message: '初始化图片目录',
          content: Buffer.from('').toString('base64')
        });
      } else {
        throw error;
      }
    }
    
    // 保存到数据库
    const result = await env.DB.prepare(`
      INSERT INTO repositories (name, owner, status, created_at, updated_at, priority)
      VALUES (?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 
        (SELECT COALESCE(MIN(priority), 0) - 1 FROM repositories))
      RETURNING id
    `).bind(newRepoName, env.GITHUB_OWNER).first();
    
    // 查询新创建的仓库记录
    const newRepo = await env.DB.prepare(`
      SELECT * FROM repositories WHERE id = ?
    `).bind(result.id).first();
    
    return {
      id: newRepo.id,
      owner: newRepo.owner,
      repo: newRepo.name,
      token: env.GITHUB_TOKEN,
      deployHook: env.DEPLOY_HOOK
    };
  } catch (error) {
    console.error('创建新仓库失败:', error);
    throw error;
  }
}

/**
 * 检查仓库空间并处理分配
 * @param {Object} env - 环境变量
 * @param {number} totalUploadSize - 上传文件总大小
 * @returns {Promise<Object>} - 返回分配结果
 */
export async function checkRepositorySpaceAndAllocate(env, totalUploadSize) {
  try {
    // 获取仓库大小阈值设置
    const thresholdSetting = await env.DB.prepare(`
      SELECT value FROM settings WHERE key = 'repository_size_threshold'
    `).first();
    
    const repoSizeThreshold = thresholdSetting ? 
      parseInt(thresholdSetting.value) : 
      900 * 1024 * 1024; // 默认900MB
    
    // 获取当前活跃仓库
    const activeRepo = await env.DB.prepare(`
      SELECT * FROM repositories 
      WHERE status = 'active' 
      ORDER BY priority ASC, id ASC 
      LIMIT 1
    `).first();
    
    if (!activeRepo) {
      console.log('没有可用的活跃仓库，尝试创建新仓库');
      
      // 尝试获取默认仓库名称
      const nameTemplateSetting = await env.DB.prepare(`
        SELECT value FROM settings WHERE key = 'repository_name_template'
      `).first();
      
      let baseName = nameTemplateSetting?.value || 'images-repo';
      
      try {
        // 创建新仓库
        const newRepo = await createNewRepository(env, baseName);
        
        return {
          canUpload: true,
          repository: newRepo,
          needNewRepo: true
        };
      } catch (createError) {
        console.error('自动创建仓库失败:', createError);
        throw new Error('没有可用的活跃仓库，且自动创建失败: ' + createError.message);
      }
    }
    
    const remainingSpace = repoSizeThreshold - activeRepo.size_estimate;
    
    // 如果剩余空间足够
    if (remainingSpace >= totalUploadSize) {
      return {
        canUpload: true,
        repository: {
          id: activeRepo.id,
          owner: activeRepo.owner || env.GITHUB_OWNER,
          repo: activeRepo.name,
          token: activeRepo.token || env.GITHUB_TOKEN,
          deployHook: activeRepo.deploy_hook || env.DEPLOY_HOOK
        },
        needNewRepo: false
      };
    }
    
    // 如果剩余空间不足，查找其他活跃仓库
    const otherRepos = await env.DB.prepare(`
      SELECT * FROM repositories 
      WHERE status = 'active' AND id != ? 
      ORDER BY priority ASC, id ASC
    `).bind(activeRepo.id).all();
    
    // 如果有其他活跃仓库，检查是否有足够空间
    for (const repo of otherRepos.results || []) {
      const repoRemainingSpace = repoSizeThreshold - repo.size_estimate;
      if (repoRemainingSpace >= totalUploadSize) {
        return {
          canUpload: true,
          repository: {
            id: repo.id,
            owner: repo.owner || env.GITHUB_OWNER,
            repo: repo.name,
            token: repo.token || env.GITHUB_TOKEN,
            deployHook: repo.deploy_hook || env.DEPLOY_HOOK
          },
          needNewRepo: false
        };
      }
    }
    
    // 如果没有足够空间的仓库，创建新仓库
    const newRepo = await createNewRepository(env, activeRepo.name);
    
    // 如果当前仓库接近阈值，更新其状态为不活跃
    if (remainingSpace < totalUploadSize && remainingSpace < repoSizeThreshold * 0.1) {
      await env.DB.prepare(`
        UPDATE repositories SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(activeRepo.id).run();
      
      console.log(`仓库 ${activeRepo.name} 已接近大小阈值，状态更新为 'inactive'`);
    }
    
    return {
      canUpload: true,
      repository: newRepo,
      needNewRepo: true
    };
  } catch (error) {
    console.error('检查仓库空间失败:', error);
    return {
      canUpload: false,
      error: error.message
    };
  }
}

/**
 * 更新仓库大小估算
 * @param {Object} env - 环境变量
 * @param {number} repositoryId - 仓库ID
 * @param {number} fileSize - 文件大小
 * @returns {Promise<Object>} - 返回更新结果，包括是否创建了新仓库
 */
export async function updateRepositorySizeEstimate(env, repositoryId, fileSize) {
  try {
    // 更新仓库大小估算
    await env.DB.prepare(`
      UPDATE repositories 
      SET size_estimate = size_estimate + ?, 
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(fileSize, repositoryId).run();
    
    // 检查是否达到阈值
    const thresholdSetting = await env.DB.prepare(`
      SELECT value FROM settings WHERE key = 'repository_size_threshold'
    `).first();
    
    const repoSizeThreshold = thresholdSetting ? 
      parseInt(thresholdSetting.value) : 
      900 * 1024 * 1024; // 默认900MB
    
    // 获取更新后的仓库信息
    const repo = await env.DB.prepare(`
      SELECT * FROM repositories WHERE id = ?
    `).bind(repositoryId).first();
    
    let newRepoCreated = false;
    
    // 如果达到或超过阈值，更新状态为不活跃
    if (repo && repo.size_estimate >= repoSizeThreshold && repo.status === 'active') {
      console.log(`仓库 ${repo.name} 已达到大小阈值，状态更新为 'inactive'`);
      
      // 更新当前仓库状态为不活跃
      await env.DB.prepare(`
        UPDATE repositories SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(repositoryId).run();
      
      // 尝试创建新仓库并设置为活跃
      try {
        const nameTemplateSetting = await env.DB.prepare(`
          SELECT value FROM settings WHERE key = 'repository_name_template'
        `).first();
        
        let baseName = nameTemplateSetting?.value || repo.name;
        
        // 创建新仓库
        const newRepo = await createNewRepository(env, baseName);
        newRepoCreated = true;
        
        console.log(`已自动创建新仓库: ${newRepo.repo}`);
      } catch (createError) {
        console.error('自动创建新仓库失败:', createError);
      }
    }
    
    return {
      updated: true,
      newRepoCreated,
      repositoryId
    };
  } catch (error) {
    console.error('更新仓库大小估算失败:', error);
    throw error;
  }
}

/**
 * 获取所有仓库列表
 * @param {Object} env - 环境变量
 * @returns {Promise<Array>} - 返回仓库列表
 */
export async function getAllRepositories(env) {
  try {
    const repos = await env.DB.prepare(`
      SELECT * FROM repositories ORDER BY priority ASC, id ASC
    `).all();
    
    return repos.results || [];
  } catch (error) {
    console.error('获取仓库列表失败:', error);
    return [];
  }
}

/**
 * 触发所有仓库的部署钩子
 * @param {Object} env - 环境变量
 * @returns {Promise<Object>} - 返回部署结果
 */
export async function triggerAllRepositoriesDeployHooks(env) {
  const results = [];
  
  try {
    // 获取所有仓库的部署钩子
    const repos = await env.DB.prepare(`
      SELECT id, name, deploy_hook FROM repositories
      WHERE status != 'inactive'
    `).all();
    
    for (const repo of repos.results || []) {
      const deployHook = repo.deploy_hook || env.DEPLOY_HOOK;
      
      if (!deployHook) {
        results.push({
          repoId: repo.id,
          repoName: repo.name,
          success: false,
          error: '没有配置部署钩子'
        });
        continue;
      }
      
      try {
        console.log(`触发仓库 ${repo.name} 的部署钩子...`);
        const response = await fetch(deployHook, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          const result = await response.json();
          results.push({
            repoId: repo.id,
            repoName: repo.name,
            success: true,
            result
          });
        } else {
          const errorText = await response.text();
          results.push({
            repoId: repo.id,
            repoName: repo.name,
            success: false,
            error: `部署触发失败: ${response.status} ${errorText}`
          });
        }
      } catch (error) {
        results.push({
          repoId: repo.id,
          repoName: repo.name,
          success: false,
          error: `部署钩子请求异常: ${error.message}`
        });
      }
    }
    
    return {
      success: results.some(r => r.success),
      results
    };
  } catch (error) {
    console.error('触发所有仓库部署钩子失败:', error);
    return {
      success: false,
      error: error.message,
      results
    };
  }
} 
