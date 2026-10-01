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
CREATE TABLE IF NOT EXISTS cues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('light','sound','set','other')),
  description TEXT NOT NULL DEFAULT '',
  deps        TEXT NOT NULL DEFAULT '[]'
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
  action         TEXT NOT NULL CHECK (action IN ('fired','skipped','retracted')),
  operator       TEXT NOT NULL,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cue_events_perf ON cue_events(performance_id, cue_id, id);
`);

/**
 * 旧库迁移：早期 cue_events 带 UNIQUE(performance_id, cue_id) 且不含 retracted 动作，
 * 无法记录多条流水。检测后重建表（保留全部既有记录），新库此函数为空操作。
 */
function migrateCueEventsIfNeeded() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cue_events'").get();
  if (!row || row.sql.includes('retracted')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  withTx(() => {
    db.exec(`
      CREATE TABLE cue_events_mig (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
        cue_id         INTEGER NOT NULL REFERENCES cues(id),
        action         TEXT NOT NULL CHECK (action IN ('fired','skipped','retracted')),
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
  });
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[init] 已迁移 cue_events 表：支持撤回流水（保留全部历史记录）');
}

migrateCueEventsIfNeeded();

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
    'INSERT INTO cues (version_id, seq, label, type, description, deps) VALUES (?,?,?,?,?,?)'
  );

  withTx(() => {
    const showId = Number(insertShow.run('示例剧目《夜航》').lastInsertRowid);

    const demoCues = [
      ['L1', 'light', '开场灯渐亮', '[]'],
      ['S1', 'sound', '开场音乐起', '["L1"]'],
      ['B1', 'set', '大幕升起', '["S1"]'],
      ['L2', 'light', '追光打在主角位', '["L1"]'],
      ['S2', 'sound', '远雷声', '["B1"]'],
      ['B2', 'set', '船台推出', '["B1","L2"]'],
    ];

    const v1 = Number(insertVersion.run(showId, 1, 'published', '首演版').lastInsertRowid);
    demoCues.forEach((c, i) => insertCue.run(v1, i + 1, c[0], c[1], c[2], c[3]));

    const v2 = Number(insertDraft.run(showId, 2, 'draft', '排演修改中').lastInsertRowid);
    demoCues.forEach((c, i) => insertCue.run(v2, i + 1, c[0], c[1], c[2], c[3]));
    insertCue.run(v2, demoCues.length + 1, 'S3', 'sound', '雨声渐入（新增）', '["S2"]');
  });

  console.log('[init] 已写入演示数据（SEED_DEMO=0 可关闭）');
}

if (process.env.SEED_DEMO !== '0') {
  seedDemoIfEmpty();
}

module.exports = { db, withTx, DB_PATH };
