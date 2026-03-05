/**
 * MBTI × 桌遊配對 - Cloudflare Worker API
 * 模擬 Genspark tables/xxx API 格式，對接 Cloudflare D1
 * 
 * 路由：
 *   GET    /tables/{table}           - 列表（支援 page, limit, search, sort）
 *   GET    /tables/{table}/{id}      - 單筆
 *   POST   /tables/{table}           - 新增
 *   PUT    /tables/{table}/{id}      - 完整更新
 *   PATCH  /tables/{table}/{id}      - 部分更新
 *   DELETE /tables/{table}/{id}      - 刪除
 */

const ALLOWED_TABLES = [
  'users', 'user_stats', 'game_database', 'game_aliases', 'game_votes',
  'game_collections', 'collection_game_stats', 'user_collections',
  'user_collection_votes', 'achievements', 'admin_whitelist',
  'tester_whitelist', 'influencer_whitelist', 'publisher_badge_series',
  'quiz_collections', 'quiz_questions', 'quiz_attempts',
  'daily_quests', 'limited_events', 'event_progress', 'site_stats'
];

// 每頁最大筆數（依表格設定，game_database 允許較大分頁）
const TABLE_MAX_LIMIT = {
  game_database: 200,
  game_aliases: 200,
  default: 100
};

// CORS headers
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// 產生 UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 取得資料表欄位
async function getTableColumns(db, tableName) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return result.results.map(col => col.name);
  } catch (e) {
    return [];
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // OPTIONS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 解析路徑：/tables/{table} 或 /tables/{table}/{id}
    const pathMatch = url.pathname.match(/^\/tables\/([^\/]+)\/?([^\/]*)$/);
    if (!pathMatch) {
      return errorResponse('Invalid path. Use /tables/{table} or /tables/{table}/{id}', 404);
    }

    const tableName = pathMatch[1];
    const recordId = pathMatch[2] || null;

    // 驗證資料表名稱
    if (!ALLOWED_TABLES.includes(tableName)) {
      return errorResponse(`Table "${tableName}" not found`, 404);
    }

    const db = env.DB;

    try {
      // ── GET 列表 ──
      if (method === 'GET' && !recordId) {
        const page = parseInt(url.searchParams.get('page') || '1');
        const maxLimit = TABLE_MAX_LIMIT[tableName] || TABLE_MAX_LIMIT.default;
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), maxLimit);
        const search = url.searchParams.get('search') || '';
        const sort = url.searchParams.get('sort') || 'created_at';
        const offset = (page - 1) * limit;

        // 取得欄位列表
        const columns = await getTableColumns(db, tableName);
        
        // 計算總數
        // site_stats 沒有 deleted_at 欄位，直接查全部
        const hasDeletedAt = !['site_stats', 'game_database', 'game_aliases', 'achievements',
          'daily_quests', 'limited_events', 'admin_whitelist', 'tester_whitelist',
          'influencer_whitelist', 'publisher_badge_series'].includes(tableName);
        const whereBase = hasDeletedAt
          ? `WHERE (deleted_at IS NULL OR deleted_at = '')`
          : `WHERE 1=1`;
        let countQuery = `SELECT COUNT(*) as total FROM ${tableName} ${whereBase}`;
        let dataQuery = `SELECT * FROM ${tableName} ${whereBase}`;
        const params = [];

        // 搜尋（對 text 類型欄位做 LIKE）
        if (search) {
          const textCols = columns.filter(c => 
            !['id','created_at','updated_at'].includes(c)
          ).slice(0, 5); // 最多搜尋前 5 個欄位
          
          if (textCols.length > 0) {
            const searchConditions = textCols.map(c => `${c} LIKE ?`).join(' OR ');
            const searchVal = `%${search}%`;
            countQuery += ` AND (${searchConditions})`;
            dataQuery += ` AND (${searchConditions})`;
            textCols.forEach(() => params.push(searchVal));
          }
        }

        // 排序
        const validSort = columns.includes(sort) ? sort : 'created_at';
        dataQuery += ` ORDER BY ${validSort} DESC LIMIT ? OFFSET ?`;

        // 執行查詢
        const countResult = await db.prepare(countQuery).bind(...params).first();
        const total = countResult?.total || 0;

        const dataResult = await db.prepare(dataQuery).bind(...params, limit, offset).all();
        const rows = dataResult.results || [];

        // 解析 JSON 欄位
        const parsedRows = rows.map(row => parseJsonFields(row));

        // 取得 schema
        const schemaFields = columns
          .filter(c => !['created_at','updated_at','deleted_at'].includes(c))
          .map(c => ({ name: c, type: 'text' }));

        return jsonResponse({
          data: parsedRows,
          total,
          page,
          limit,
          table: tableName,
          schema: { fields: schemaFields }
        });
      }

      // ── GET 單筆 ──
      if (method === 'GET' && recordId) {
        const row = await db.prepare(
          `SELECT * FROM ${tableName} WHERE id = ?`
        ).bind(recordId).first();

        if (!row) return errorResponse('Record not found', 404);
        return jsonResponse(parseJsonFields(row));
      }

      // ── POST 新增 ──
      if (method === 'POST') {
        const body = await request.json();
        const id = body.id || generateUUID();
        const now = Date.now();

        const columns = await getTableColumns(db, tableName);
        const insertData = { ...body, id, created_at: now, updated_at: now };

        // 只保留 schema 中存在的欄位
        const validKeys = Object.keys(insertData).filter(k => columns.includes(k));
        const values = validKeys.map(k => serializeValue(insertData[k]));

        const placeholders = validKeys.map(() => '?').join(', ');
        const colNames = validKeys.join(', ');

        await db.prepare(
          `INSERT INTO ${tableName} (${colNames}) VALUES (${placeholders})`
        ).bind(...values).run();

        const created = await db.prepare(
          `SELECT * FROM ${tableName} WHERE id = ?`
        ).bind(id).first();

        return jsonResponse(parseJsonFields(created), 201);
      }

      // ── PUT 完整更新 ──
      if (method === 'PUT' && recordId) {
        const body = await request.json();
        const now = Date.now();

        const columns = await getTableColumns(db, tableName);
        const updateData = { ...body, updated_at: now };

        const validKeys = Object.keys(updateData).filter(k => 
          columns.includes(k) && k !== 'id'
        );
        const setClauses = validKeys.map(k => `${k} = ?`).join(', ');
        const values = validKeys.map(k => serializeValue(updateData[k]));

        await db.prepare(
          `UPDATE ${tableName} SET ${setClauses} WHERE id = ?`
        ).bind(...values, recordId).run();

        const updated = await db.prepare(
          `SELECT * FROM ${tableName} WHERE id = ?`
        ).bind(recordId).first();

        if (!updated) return errorResponse('Record not found', 404);
        return jsonResponse(parseJsonFields(updated));
      }

      // ── PATCH 部分更新 ──
      if (method === 'PATCH' && recordId) {
        const body = await request.json();
        const now = Date.now();

        const columns = await getTableColumns(db, tableName);
        const updateData = { ...body, updated_at: now };

        const validKeys = Object.keys(updateData).filter(k => 
          columns.includes(k) && k !== 'id'
        );

        if (validKeys.length === 0) {
          return errorResponse('No valid fields to update');
        }

        const setClauses = validKeys.map(k => `${k} = ?`).join(', ');
        const values = validKeys.map(k => serializeValue(updateData[k]));

        await db.prepare(
          `UPDATE ${tableName} SET ${setClauses} WHERE id = ?`
        ).bind(...values, recordId).run();

        const updated = await db.prepare(
          `SELECT * FROM ${tableName} WHERE id = ?`
        ).bind(recordId).first();

        if (!updated) return errorResponse('Record not found', 404);
        return jsonResponse(parseJsonFields(updated));
      }

      // ── DELETE 刪除 ──
      if (method === 'DELETE' && recordId) {
        const existing = await db.prepare(
          `SELECT id FROM ${tableName} WHERE id = ?`
        ).bind(recordId).first();

        if (!existing) return errorResponse('Record not found', 404);

        await db.prepare(
          `DELETE FROM ${tableName} WHERE id = ?`
        ).bind(recordId).run();

        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      return errorResponse('Method not allowed', 405);

    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse(`Internal server error: ${err.message}`, 500);
    }
  }
};

// JSON 陣列欄位解析（D1 存 TEXT，讀出來要還原成 array/object）
function parseJsonFields(row) {
  if (!row) return row;
  const result = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      // 嘗試解析 JSON array 或 object
      if ((value.startsWith('[') && value.endsWith(']')) ||
          (value.startsWith('{') && value.endsWith('}'))) {
        try {
          result[key] = JSON.parse(value);
        } catch (e) {
          // 不是 JSON，保留原值
        }
      }
      // 數字 1/0 轉 boolean（is_active, completed 等欄位）
    } else if (typeof value === 'number') {
      // 保留數字，不轉 boolean（讓前端自己判斷）
    }
  }
  return result;
}

// 序列化值：array/object 轉 JSON string
function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
