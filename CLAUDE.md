# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概覽

「MBTI × 桌遊配對」— 桌遊玩家 MBTI 配對社群平台。純前端靜態網站（vanilla HTML/CSS/JS），無建構工具、無框架、無 npm。後端 API 由 Cloudflare Worker + D1 SQLite 提供。

- **正式站**：Genspark 託管（`ba3d09ec-fb6a-466f-83dd-38bfd12bd437.vip.gensparksite.com`）
- **API**：相對路徑 `/tables/{table_name}`，前端直接 fetch

## 架構

### API 層（Cloudflare Worker）

`public/cloudflare/worker.js` — 完整 CRUD REST API，對接 Cloudflare D1：
- `GET /tables/{table}` — 列表（支援 page, limit, search, sort）
- `GET /tables/{table}/{id}` — 單筆
- `POST /tables/{table}` — 新增
- `PUT /tables/{table}/{id}` — 完整更新
- `DELETE /tables/{table}/{id}` — 刪除
- **PATCH 不可用**（405）— 一律使用 `safePatch()`

`public/cloudflare/proxy-worker.js` — 舊版 API proxy（轉發到 Genspark），已被 worker.js 取代。

### safePatch — 最關鍵的更新模式

因 API 不支援 PATCH，所有部分更新必須走 `safePatch()`（定義於 `public/js/app.js:136`）：

```
1. GET 取回完整資料
2. 移除系統欄位（gs_*, _rid, created_at, updated_at 等）
3. 合併 patchData
4. 序列化 array/object 為 JSON 字串
5. PUT 送出合併後的資料
```

**禁止直接使用 `fetch(url, { method: 'PATCH' })`**。PUT 不能送不存在於 D1 schema 的欄位，否則 500。

### 前端 JS 模組（全域物件，非 ES Module）

| 檔案 | 全域物件 | 職責 |
|---|---|---|
| `js/app.js` | `window.GameMBTI` | 核心：MBTI 資料、使用者 CRUD、safePatch、成就系統、遊戲化（XP/等級） |
| `js/google-auth.js` | `window.GoogleAuth` | Google OAuth 登入/登出、使用者建立/更新 |
| `js/admin-auth.js` | `window.AdminAuth` | 管理員白名單驗證、admin 頁面存取控制 |
| `js/game-names.js` | `window.GameNames` | 桌遊多語言名稱對照（中/英/日）、封面圖片、LocalStorage 快取 |
| `js/gamification.js` | （直接函式） | XP 規則、等級計算、每日任務 |
| `js/nickname-manager.js` | `window.NicknameManager` | 隨機暱稱生成、暱稱驗證與設定彈窗 |
| `js/write-guard.js` | `window.WriteGuard` | 寫入防護層（目前未被任何頁面載入） |
| `js/show-admin-link.js` | `window.AdminLinkCache` | 前台自動檢查管理員身份並在 navbar 顯示後台連結 |

### 資料表（D1 SQLite）

主要表：`users`, `user_stats`, `game_database`, `game_aliases`, `game_votes`, `user_collections`, `achievements`, `quiz_attempts`, `daily_quests`, `site_stats`, `admin_whitelist`

陣列欄位（如 `liked_games`, `unlocked_badges`）存為 JSON 字串。讀取後需用 `JSON.parse()` 還原，寫入前需 `JSON.stringify()`。safePatch 已自動處理序列化。

### 驗證機制

- **使用者登入**：Google OAuth → JWT 存 `localStorage('google_id_token')` → 使用者資料存 `localStorage('currentUser')`
- **管理員驗證**：Google ID 比對 `admin_whitelist` 表 + 硬編碼超級管理員 ID → 驗證狀態快取 4 小時
- admin 頁面載入 `admin-auth.js` 時自動隱藏 body，驗證通過才顯示

## 開發注意事項

- 沒有建構步驟，直接編輯 `public/` 下的 HTML/CSS/JS
- 所有頁面透過 `<script>` 標籤載入 JS，依賴順序重要（app.js 須在其他模組前載入）
- API 呼叫使用相對路徑 `tables/...`，本地開發需有 proxy 或部署到 Genspark 環境
- `public/backups/` 保存歷史版本備份，帶日期標籤（如 `*.20260303-PERFECT.bak`）
- `_test_*.html` 和 `_debug_*.html` 為開發除錯用頁面
