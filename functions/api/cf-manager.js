/**
 * Cloudflare API 管理器 - 用于管理 Cloudflare Pages 项目的环境变量
 */

/**
 * 更新 Cloudflare Pages 项目的环境变量
 * @param {Object} env - 环境变量
 * @param {string} key - 环境变量名称
 * @param {string} value - 环境变量值
 * @returns {Promise<Object>} - 返回更新结果
 */
export async function updateEnvironmentVariable(env, key, value) {
  try {
    // 检查必要的环境变量
    if (!env.CF_API_TOKEN) {
      throw new Error('缺少 Cloudflare API 令牌(CF_API_TOKEN)环境变量');
    }
    
    if (!env.CF_ACCOUNT_ID) {
      throw new Error('缺少 Cloudflare 账户 ID(CF_ACCOUNT_ID)环境变量');
    }
    
    if (!env.CF_PROJECT_NAME) {
      throw new Error('缺少 Cloudflare Pages 项目名称(CF_PROJECT_NAME)环境变量');
    }
    
    console.log(`准备更新环境变量: ${key}=${value}`);
    
    // 获取当前环境变量
    const currentVars = await getEnvironmentVariables(env);
    
    // 准备新的环境变量列表
    const updatedVars = [];
    let varExists = false;
    
    // 遍历当前环境变量，更新目标变量或保持其他变量不变
    for (const envVar of currentVars) {
      if (envVar.name === key) {
        // 更新目标变量
        updatedVars.push({
          name: key,
          value: value,
          type: envVar.type || 'plain_text'
        });
        varExists = true;
      } else {
        // 保持其他变量不变
        updatedVars.push(envVar);
      }
    }
    
    // 如果目标变量不存在，添加它
    if (!varExists) {
      updatedVars.push({
        name: key,
        value: value,
        type: 'plain_text'
      });
    }
    
    // 调用 Cloudflare API 更新环境变量
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PROJECT_NAME}/deployments/settings/environment_variables`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatedVars)
    });
    
    const result = await response.json();
    
    if (!response.ok || !result.success) {
      console.error('更新环境变量失败:', result);
      throw new Error(`更新环境变量失败: ${result.errors?.[0]?.message || '未知错误'}`);
    }
    
    console.log(`环境变量 ${key} 更新成功`);
    return {
      success: true,
      message: `环境变量 ${key} 更新成功`,
      result
    };
  } catch (error) {
    console.error('更新环境变量时出错:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 获取 Cloudflare Pages 项目的环境变量
 * @param {Object} env - 环境变量
 * @returns {Promise<Array>} - 返回环境变量列表
 */
export async function getEnvironmentVariables(env) {
  try {
    // 检查必要的环境变量
    if (!env.CF_API_TOKEN) {
      throw new Error('缺少 Cloudflare API 令牌(CF_API_TOKEN)环境变量');
    }
    
    if (!env.CF_ACCOUNT_ID) {
      throw new Error('缺少 Cloudflare 账户 ID(CF_ACCOUNT_ID)环境变量');
    }
    
    if (!env.CF_PROJECT_NAME) {
      throw new Error('缺少 Cloudflare Pages 项目名称(CF_PROJECT_NAME)环境变量');
    }
    
    // 调用 Cloudflare API 获取环境变量
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PROJECT_NAME}/deployments/settings/environment_variables`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    
    if (!response.ok || !result.success) {
      console.error('获取环境变量失败:', result);
      throw new Error(`获取环境变量失败: ${result.errors?.[0]?.message || '未知错误'}`);
    }
    
    return result.result || [];
  } catch (error) {
    console.error('获取环境变量时出错:', error);
    throw error;
  }
}

/**
 * 更新 REPOS 环境变量
 * @param {Object} env - 环境变量
 * @param {string} repoName - 要添加的仓库名称
 * @returns {Promise<Object>} - 返回更新结果
 */
export async function updateReposVariable(env, repoName) {
  try {
    // 获取当前 REPOS 环境变量
    let currentRepos = env.REPOS || '';
    
    // 检查仓库是否已存在于列表中
    const repoList = currentRepos.split(',').map(repo => repo.trim()).filter(repo => repo);
    
    if (!repoList.includes(repoName)) {
      // 添加新仓库到列表
      repoList.push(repoName);
      
      // 更新环境变量
      const newReposValue = repoList.join(',');
      console.log(`更新 REPOS 环境变量: ${currentRepos} -> ${newReposValue}`);
      
      return await updateEnvironmentVariable(env, 'REPOS', newReposValue);
    } else {
      console.log(`仓库 ${repoName} 已存在于 REPOS 环境变量中`);
      return {
        success: true,
        message: `仓库 ${repoName} 已存在于 REPOS 环境变量中`,
        noChange: true
      };
    }
  } catch (error) {
    console.error('更新 REPOS 环境变量时出错:', error);
    return {
      success: false,
      error: error.message
    };
  }
} 
