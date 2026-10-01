'use strict';
/**
 * 数据层：Node.js 内置 SQLite（node:sqlite），关系型存储，数据落本地文件。
 * 启动时自动建表（初始化），空库时可选写入演示数据（SEED_DEMO=0 关闭）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS shows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 执行单版本：draft 可改，published 不可变
CREATE TABLE IF NOT EXISTS versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id        INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at   TEXT,
  UNIQUE (show_id, version_number)
);

-- 提示：deps 为 JSON 数组，存放前置提示的编号（label）
-- require_review 为"需双人复核"标记，仅草稿可改，发布后随版本锁定；
-- 历史版本（旧库迁移、既有提示）默认 0，按无需复核处理
CREATE TABLE IF NOT EXISTS cues (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  label          TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('light','sound','set','other')),
  description    TEXT NOT NULL DEFAULT '',
  deps           TEXT NOT NULL DEFAULT '[]',
  require_review INTEGER NOT NULL DEFAULT 0 CHECK (require_review IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_cues_version ON cues(version_id, seq);

-- 每场演出：锁定一个已发布版本，独立记录
CREATE TABLE IF NOT EXISTS performances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL REFERENCES shows(id),
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  name        TEXT NOT NULL DEFAULT '',
  started_by  TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 执行流水：触发 / 跳过 / 撤回 全量留痕；同一演出同一提示的"当前有效结果"
-- 由最新一条事件推导（retracted 表示已撤回、当前无有效结果），
-- 并发一致性由 BEGIN IMMEDIATE 事务内"读最新事件→判定→写入"保证
CREATE TABLE IF NOT EXISTS cue_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  cue_id         INTEGER NOT NULL REFERENCES cues(id),
  action         TEXT NOT NULL CHECK (action IN ('fired','skipped','retracted','review_fired')),
  operator       TEXT NOT NULL,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cue_events_perf ON cue_events(performance_id, cue_id, id);

-- 双人复核触发申请（仅针对发布版本中 require_review=1 的提示）
-- status: pending 待处理 / confirmed 已确认（确认时同时写入 review_fired 流水）/
--         cancelled 申请人撤销 / rejected 他人填原因驳回
-- 同一演出同一提示至多存在一条 pending 申请（部分唯一索引），
-- 确认 / 撤销 / 驳回并发时只可能有一个结局
CREATE TABLE IF NOT EXISTS review_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  performance_id      INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  cue_id              INTEGER NOT NULL REFERENCES cues(id),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','cancelled','rejected')),
  applicant           TEXT NOT NULL,
  applied_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmer           TEXT,
  confirmed_at        TEXT,
  cancel_operator     TEXT,
  cancelled_at        TEXT,
  reject_operator     TEXT,
  rejected_at         TEXT,
  reject_reason       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_pending
  ON review_requests(performance_id, cue_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_review_perf ON review_requests(performance_id, id);
`);

/**
 * 旧库迁移：
 * 1) 早期 cue_events 带 UNIQUE(performance_id, cue_id) 且不含 retracted 动作；
 *    本轮再增加 review_fired 动作（双人复核确认后的有效触发）。
 *    检测到结构过旧即重建表（保留全部既有记录），新库此函数为空操作。
 * 2) cues 缺少 require_review 列时补齐，既有提示（旧版本）默认 0 = 无需复核。
 */
function migrateSchemaIfNeeded() {
  const cuesRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cues'").get();
  const needCueColumn = cuesRow && !cuesRow.sql.includes('require_review');

  const eventsRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cue_events'").get();
  const needEventsRebuild = !eventsRow || !eventsRow.sql.includes('review_fired');

  if (!needCueColumn && !needEventsRebuild) return;

  db.exec('PRAGMA foreign_keys = OFF');
  withTx(() => {
    if (needCueColumn) {
      db.exec("ALTER TABLE cues ADD COLUMN require_review INTEGER NOT NULL DEFAULT 0");
      console.log('[init] 已迁移 cues 表：新增 require_review 列（既有提示默认无需复核）');
    }
    if (needEventsRebuild) {
      db.exec(`
        CREATE TABLE cue_events_mig (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
          cue_id         INTEGER NOT NULL REFERENCES cues(id),
          action         TEXT NOT NULL CHECK (action IN ('fired','skipped','retracted','review_fired')),
          operator       TEXT NOT NULL,
          reason         TEXT,
          created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO cue_events_mig (id, performance_id, cue_id, action, operator, reason, created_at)
          SELECT id, performance_id, cue_id, action, operator, reason, created_at FROM cue_events;
        DROP TABLE cue_events;
        ALTER TABLE cue_events_mig RENAME TO cue_events;
        CREATE INDEX IF NOT EXISTS idx_cue_events_perf ON cue_events(performance_id, cue_id, id);
      `);
      console.log('[init] 已迁移 cue_events 表：支持撤回与双人复核流水（保留全部历史记录）');
    }
  });
  db.exec('PRAGMA foreign_keys = ON');
}

migrateSchemaIfNeeded();

/** 事务包装：BEGIN IMMEDIATE 保证写操作串行，冲突时整体回滚 */
function withTx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

/** 空库初始化演示数据（便于一键启动后直接体验） */
function seedDemoIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM shows').get();
  if (row.n > 0) return;

  const insertShow = db.prepare('INSERT INTO shows (name) VALUES (?)');
  const insertVersion = db.prepare(
    "INSERT INTO versions (show_id, version_number, status, note, published_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
  );
  const insertDraft = db.prepare(
    'INSERT INTO versions (show_id, version_number, status, note) VALUES (?,?,?,?)'
  );
  const insertCue = db.prepare(
    'INSERT INTO cues (version_id, seq, label, type, description, deps, require_review) VALUES (?,?,?,?,?,?,?)'
  );

  withTx(() => {
    const showId = Number(insertShow.run('示例剧目《夜航》').lastInsertRowid);

    // [编号, 类型, 描述, 前置, 是否需双人复核]：大幕升起等关键提示标 1
    const demoCues = [
      ['L1', 'light', '开场灯渐亮', '[]', 0],
      ['S1', 'sound', '开场音乐起', '["L1"]', 0],
      ['B1', 'set', '大幕升起', '["S1"]', 1],
      ['L2', 'light', '追光打在主角位', '["L1"]', 0],
      ['S2', 'sound', '远雷声', '["B1"]', 0],
      ['B2', 'set', '船台推出', '["B1","L2"]', 0],
    ];

    const v1 = Number(insertVersion.run(showId, 1, 'published', '首演版').lastInsertRowid);
    demoCues.forEach((c, i) => insertCue.run(v1, i + 1, c[0], c[1], c[2], c[3], c[4]));

    const v2 = Number(insertDraft.run(showId, 2, 'draft', '排演修改中').lastInsertRowid);
    demoCues.forEach((c, i) => insertCue.run(v2, i + 1, c[0], c[1], c[2], c[3], c[4]));
    insertCue.run(v2, demoCues.length + 1, 'S3', 'sound', '雨声渐入（新增）', '["S2"]', 0);
  });

  console.log('[init] 已写入演示数据（SEED_DEMO=0 可关闭）');
}

if (process.env.SEED_DEMO !== '0') {
  seedDemoIfEmpty();
}

module.exports = { db, withTx, DB_PATH };
