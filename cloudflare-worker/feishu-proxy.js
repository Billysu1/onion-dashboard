/**
 * 洋葱学习机售后质量看板 - 飞书API代理 Worker
 * 
 * 部署步骤:
 * 1. 注册 Cloudflare 账号 (免费): https://dash.cloudflare.com/sign-up
 * 2. 进入 Workers & Pages → 创建 Worker
 * 3. 粘贴此代码 → 保存并部署
 * 4. 设置环境变量: Settings → Variables:
 *    - FEISHU_APP_ID = cli_aaa0359cffb9dceb
 *    - FEISHU_APP_SECRET = (向你的飞书应用管理员获取)
 * 5. 复制 Worker URL (形如 https://xxx.xxx.workers.dev)
 * 6. 更新看板 CONFIG.SYNC_API_URL 为该 URL
 */

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// 日期字段名列表（用于将时间戳转为日期字符串）
const DATE_FIELD_NAMES = ['维修完成日期', '完成维修日期', '完成日期', '日期', '客诉日期', '客诉时间'];

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // 仅允许 GET
    if (request.method !== 'GET') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/records') {
        return await handleRecords(env, url);
      } else if (path === '/api/sync') {
        // 一键同步所有表
        return await handleSyncAll(env);
      } else if (path === '/api/health') {
        return jsonResponse({ ok: true, message: 'Feishu proxy is running' });
      } else {
        return jsonResponse({ ok: false, error: 'Unknown endpoint' }, 404);
      }
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
  },
};

async function handleRecords(env, url) {
  const baseToken = url.searchParams.get('base_token');
  const tableId = url.searchParams.get('table_id');

  if (!baseToken || !tableId) {
    return jsonResponse({ ok: false, error: 'Missing base_token or table_id' }, 400);
  }

  const token = await getTenantToken(env);
  const allItems = [];
  let pageToken = undefined;
  let fetchCount = 0;

  do {
    const result = await fetchRecordsPage(token, baseToken, tableId, pageToken);
    if (result.items) {
      // 转换日期字段时间戳为字符串
      for (const item of result.items) {
        convertDateFields(item.fields || {});
        allItems.push(item);
      }
    }
    pageToken = result.has_more ? result.page_token : undefined;
    fetchCount++;
    // 安全限制：最多拉取100页
    if (fetchCount > 100) break;
  } while (pageToken);

  return jsonResponse({
    ok: true,
    data: {
      items: allItems,
      total: allItems.length,
    },
  });
}

async function handleSyncAll(env) {
  const tables = [
    { source: 'Q20', baseToken: 'bascn80aFxeTcZOdvR8N8IBX13e', tableId: 'tblx0ERBvEosZFyT' },
    { source: 'S30', baseToken: 'bascnYME3DgpOBpWZyWJvH2ecLc', tableId: 'tbl2TE6d8FXW5lvA' },
    { source: 'P30', baseToken: 'ZGLCbfcWDaqOvBsqFo7cbfRSnAe', tableId: 'tbllzpBkdKYtEq0X' },
  ];

  const token = await getTenantToken(env);
  const results = {};

  for (const table of tables) {
    const allItems = [];
    let pageToken = undefined;
    let fetchCount = 0;

    do {
      const result = await fetchRecordsPage(token, table.baseToken, table.tableId, pageToken);
      if (result.items) {
        for (const item of result.items) {
          convertDateFields(item.fields || {});
          allItems.push(item);
        }
      }
      pageToken = result.has_more ? result.page_token : undefined;
      fetchCount++;
      if (fetchCount > 100) break;
    } while (pageToken);

    results[table.source] = allItems;
  }

  return jsonResponse({
    ok: true,
    data: results,
  });
}

async function getTenantToken(env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID or FEISHU_APP_SECRET not configured');
  }

  const res = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu auth failed: ${data.msg} (code: ${data.code})`);
  }
  return data.tenant_access_token;
}

async function fetchRecordsPage(token, baseToken, tableId, pageToken) {
  let url = `${FEISHU_API_BASE}/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=500`;
  if (pageToken) {
    url += `&page_token=${encodeURIComponent(pageToken)}`;
  }

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu API error: ${data.msg} (code: ${data.code})`);
  }
  return data.data || {};
}

function convertDateFields(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (DATE_FIELD_NAMES.includes(key) && typeof value === 'number') {
      // 将时间戳(ms)转为 YYYY/MM/DD 格式（与飞书原始格式一致）
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        fields[key] = `${y}/${m}/${d}`;
      }
    }
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
