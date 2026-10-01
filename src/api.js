'use strict';
/**
 * API 路由与业务逻辑。
 * 错误约定：返回 { error: 消息, ... } ，状态码语义：
 *   400 参数/前置条件错误（含无已发布版本、版本未发布、跳过/撤回缺原因）
 *   404 资源不存在
 *   409 冲突（提示已有结果、版本已发布不可改、撤回时当前状态不允许或下游仍已触发）
 *   422 校验未通过（缺失引用/循环依赖）或前置未触发（受阻）
 */
const { db, withTx } = require('./db');
const { validateCues, CUE_TYPES } = require('./validate');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

/* ---------------- 工具 ---------------- */

// review_fired：双人复核确认后写入的有效触发流水，业务上与 fired 同等有效
const ACTION_TEXT = {
  fired: '已触发',
  review_fired: '已触发（双人复核）',
  skipped: '已跳过',
  retracted: '已撤回',
};

function isFiredAction(action) {
  return action === 'fired' || action === 'review_fired';
}

const REVIEW_STATUS_TEXT = {
  pending: '待处理',
  confirmed: '已确认',
  cancelled: '申请人已撤销',
  rejected: '已驳回',
};

function sanitizeCue(raw) {
  const deps = Array.isArray(raw && raw.deps) ? raw.deps : [];
  return {
    label: String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50),
    type: CUE_TYPES.includes(raw && raw.type) ? raw.type : 'other',
    description: String((raw && raw.description) != null ? raw.description : '').trim().slice(0, 500),
    deps: [...new Set(deps.map((d) => String(d).trim()).filter(Boolean))].slice(0, 50),
    // 需双人复核标记：仅草稿可设，发布后随版本锁定；缺省 false
    require_review: !!(raw && raw.require_review),
  };
}

function getShow(id) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!show) throw new HttpError(404, '场次不存在');
  return show;
}

function getVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) throw new HttpError(404, '版本不存在');
  return v;
}

function getVersionCues(versionId) {
  return db
    .prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq')
    .all(versionId)
    .map((c) => ({ ...c, deps: JSON.parse(c.deps), require_review: !!c.require_review }));
}

function conflictError(existing) {
  return new HttpError(
    409,
    `该提示已有结果：${ACTION_TEXT[existing.action] || existing.action}（操作人 ${existing.operator}，时间 ${existing.created_at}）`,
    { current: existing }
  );
}

/**
 * 演出内各提示的最新一条事件（cue_id -> event）。
 * 当前有效结果规则：最新事件为 fired/review_fired/skipped 即有效；
 * retracted（已撤回）或无事件 = 无有效结果。
 * 所有写操作在 BEGIN IMMEDIATE 事务内"读最新→判定→写入"，保证至多一个当前有效结果。
 */
function latestEventsByCue(performanceId) {
  const rows = db.prepare('SELECT * FROM cue_events WHERE performance_id = ? ORDER BY id').all(performanceId);
  const map = new Map();
  for (const e of rows) map.set(e.cue_id, e);
  return map;
}

function effectiveAction(latest) {
  return latest && latest.action !== 'retracted' ? latest.action : null;
}

/* ---------------- 路由表 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, rx, keys, handler });
}

/* ---- 场次 ---- */

route('GET', '/api/shows', () => {
  const shows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id) AS version_count,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id AND v.status = 'published') AS published_count,
      (SELECT COUNT(*) FROM performances p WHERE p.show_id = s.id) AS performance_count
    FROM shows s ORDER BY s.id DESC
  `).all();
  return { shows };
});

route('POST', '/api/shows', (body) => {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, '场次名称不能为空');
  const info = db.prepare('INSERT INTO shows (name) VALUES (?)').run(name);
  return { show: db.prepare('SELECT * FROM shows WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/shows/:id', (body, p) => {
  const show = getShow(p.id);
  const versions = db.prepare(
    'SELECT id, show_id, version_number, status, note, created_at, published_at FROM versions WHERE show_id = ? ORDER BY version_number DESC'
  ).all(show.id);
  const performances = db.prepare(`
    SELECT p.*, v.version_number FROM performances p
    JOIN versions v ON v.id = p.version_id
    WHERE p.show_id = ? ORDER BY p.id DESC
  `).all(show.id);
  return { show, versions, performances };
});

/* ---- 版本（执行单） ---- */

route('POST', '/api/shows/:id/versions', (body, p) => {
  const show = getShow(p.id);
  return withTx(() => {
    // 基准版本：指定 from_version_id，否则取最新版本；没有则建空白草稿
    let base = null;
    if (body.from_version_id != null) {
      base = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?')
        .get(body.from_version_id, show.id);
      if (!base) throw new HttpError(404, '基准版本不存在');
    } else {
      base = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_number DESC LIMIT 1')
        .get(show.id);
    }
    const nextNo = (db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM versions WHERE show_id = ?')
      .get(show.id).m) + 1;
    const info = db.prepare('INSERT INTO versions (show_id, version_number, status, note) VALUES (?,?,?,?)')
      .run(show.id, nextNo, 'draft', String(body.note || '').slice(0, 200));
    const newId = Number(info.lastInsertRowid);
    if (base) {
      const cues = db.prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq').all(base.id);
      const ins = db.prepare(
        'INSERT INTO cues (version_id, seq, label, type, description, deps, require_review) VALUES (?,?,?,?,?,?,?)'
      );
      for (const c of cues) ins.run(newId, c.seq, c.label, c.type, c.description, c.deps, c.require_review);
    }
    return { version: getVersion(newId), cues: getVersionCues(newId) };
  });
});

route('GET', '/api/versions/:id', (body, p) => {
  const version = getVersion(p.id);
  return { version, cues: getVersionCues(version.id) };
});

route('PUT', '/api/versions/:id/cues', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') {
    throw new HttpError(409, '该版本已发布，内容不可修改；请新建草稿版本');
  }
  if (!Array.isArray(body.cues)) throw new HttpError(400, '请求格式错误：cues 应为数组');
  if (body.cues.length > 500) throw new HttpError(400, '提示数量过多（上限 500）');

  const cues = body.cues.map(sanitizeCue);
  withTx(() => {
    db.prepare('DELETE FROM cues WHERE version_id = ?').run(version.id);
    const ins = db.prepare(
      'INSERT INTO cues (version_id, seq, label, type, description, deps, require_review) VALUES (?,?,?,?,?,?,?)'
    );
    cues.forEach((c, i) =>
      ins.run(version.id, i + 1, c.label, c.type, c.description, JSON.stringify(c.deps), c.require_review ? 1 : 0)
    );
  });
  // 草稿允许暂存不完整内容，同时返回校验结果供界面提示
  return { ok: true, errors: validateCues(cues), cues: getVersionCues(version.id) };
});

route('POST', '/api/versions/:id/validate', (body, p) => {
  getVersion(p.id);
  const cues = Array.isArray(body.cues) ? body.cues.map(sanitizeCue) : getVersionCues(p.id);
  return { errors: validateCues(cues) };
});

route('POST', '/api/versions/:id/publish', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') throw new HttpError(409, '该版本已发布');
  const cues = getVersionCues(version.id);
  const errors = validateCues(cues);
  if (errors.length) {
    throw new HttpError(422, '校验未通过，无法发布', { errors });
  }
  withTx(() => {
    db.prepare("UPDATE versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(version.id);
  });
  return { version: getVersion(version.id) };
});

/* ---- 演出 ---- */

route('POST', '/api/shows/:id/performances', (body, p) => {
  const show = getShow(p.id);
  let version;
  if (body.version_id != null) {
    version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?').get(body.version_id, show.id);
    if (!version) throw new HttpError(404, '版本不存在');
    if (version.status !== 'published') {
      throw new HttpError(400, `版本 v${version.version_number} 尚未发布，不能用于启动演出`);
    }
  } else {
    version = db.prepare(
      "SELECT * FROM versions WHERE show_id = ? AND status = 'published' ORDER BY version_number DESC LIMIT 1"
    ).get(show.id);
    if (!version) throw new HttpError(400, '无已发布版本，请先发布执行单后再启动演出');
  }
  const name = String(body.name || '').trim().slice(0, 100);
  const operator = String(body.operator || '').trim().slice(0, 50);
  const info = db.prepare('INSERT INTO performances (show_id, version_id, name, started_by) VALUES (?,?,?,?)')
    .run(show.id, version.id, name, operator);
  return { performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/performances/:id', (body, p) => {
  const perf = db.prepare(`
    SELECT p.*, s.name AS show_name, v.version_number
    FROM performances p
    JOIN shows s ON s.id = p.show_id
    JOIN versions v ON v.id = p.version_id
    WHERE p.id = ?
  `).get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');

  const cues = getVersionCues(perf.version_id);
  // 完整流水（含撤回 / 双人复核触发），按时间升序；返回时倒序（最新在上）
  const events = db.prepare(`
    SELECT e.*, c.label, c.seq FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id
  `).all(perf.id);

  // 归约当前有效结果：fired/review_fired/skipped 生效，retracted 清除该提示的有效结果
  const eventByCue = new Map();
  for (const e of events) {
    if (e.action === 'retracted') eventByCue.delete(e.cue_id);
    else eventByCue.set(e.cue_id, e);
  }
  const firedLabels = new Set();
  for (const e of eventByCue.values()) {
    if (isFiredAction(e.action)) firedLabels.add(e.label);
  }

  // 双人复核申请（含待处理与已处理），最新在上，附带提示编号
  const reviews = db.prepare(`
    SELECT r.*, c.label, c.seq
    FROM review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id DESC
  `).all(perf.id);
  const pendingByCue = new Map();
  for (const r of reviews) {
    if (r.status === 'pending') pendingByCue.set(r.cue_id, r);
  }

  const cueStates = cues.map((c) => {
    const event = eventByCue.get(c.id) || null;
    const review = pendingByCue.get(c.id) || null;
    let status;
    let unmet = [];
    if (event) {
      status = event.action; // fired / review_fired / skipped
    } else if (review) {
      // 申请已发起但尚未确认：提示不算已触发，状态随前置结果
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = 'review_pending';
    } else {
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = unmet.length ? 'blocked' : 'pending';
    }
    return { ...c, status, unmet, event, review_request: review };
  });

  return { performance: perf, cues: cueStates, events: events.slice().reverse(), reviews };
});

/* ---- 触发 / 跳过 / 撤回（并发安全：BEGIN IMMEDIATE 事务内读最新事件再判定写入） ---- */

function recordEvent(performanceId, cueId, action, operator, reason) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');

    const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
    if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 待处理的双人复核申请期间：拒绝跳过（也拒绝直接触发，下方另有复核专用拦截）与重复申请
    const pending = db.prepare(
      "SELECT * FROM review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending'"
    ).get(performanceId, cueId);

    // 直接调用既有触发接口不能绕过双人复核
    if (action === 'fired' && cue.require_review) {
      throw new HttpError(
        422,
        pending
          ? `该提示的双人复核申请正在处理中（申请人 ${pending.applicant}，时间 ${pending.applied_at}），请等待另一位操作人确认或驳回`
          : '该提示需双人复核：请先发起触发申请，由另一位操作人确认后才会触发',
        { review_required: true, review_request: pending || null }
      );
    }

    if (pending) {
      throw new HttpError(
        409,
        `该提示已有待处理的双人复核申请（申请人 ${pending.applicant}，时间 ${pending.applied_at}），待处理期间不能跳过；请先确认、撤销或驳回`,
        { review_request: pending }
      );
    }

    if (action === 'fired') {
      const deps = JSON.parse(cue.deps);
      if (deps.length) {
        // 前置是否满足以"当前有效结果为已触发"判定（已撤回的前置不算；双人复核确认的触发算）
        const labels = db.prepare('SELECT id, label FROM cues WHERE version_id = ?').all(perf.version_id);
        const fired = new Set(
          labels.filter((r) => {
            const e = latestByCue.get(r.id);
            return e && isFiredAction(e.action);
          }).map((r) => r.label)
        );
        const unmet = deps.filter((d) => !fired.has(d));
        if (unmet.length) {
          throw new HttpError(422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
        }
      }
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, action, operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/**
 * 撤回误触发：仅当前有效结果为"已触发"可撤回；已跳过 / 未触发（含已撤回）拒绝。
 * 若沿前置关系可达的后续提示仍有有效"已触发"，整体拒绝并列出受影响编号，任何记录都不改变。
 * 成功后写入 retracted 流水（原触发记录保留），提示回到 待执行 / 受阻，可再次触发或跳过。
 */
function retractEvent(performanceId, cueId, operator, reason) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');

    const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
    if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');

    const latestByCue = latestEventsByCue(performanceId);
    const latest = latestByCue.get(cueId) || null;
    const current = effectiveAction(latest);
    if (current === 'skipped') {
      throw new HttpError(
        409,
        `该提示当前结果为已跳过，不能撤回（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
        { current: latest }
      );
    }
    if (!isFiredAction(current)) {
      throw new HttpError(409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
    }
    // 已确认提示仍可撤回（沿用现有撤回规则）；但待处理申请期间不允许任何处置性操作
    const pending = db.prepare(
      "SELECT * FROM review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending'"
    ).get(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示已有待处理的双人复核申请（申请人 ${pending.applicant}），请先完成申请处置后再撤回`,
        { review_request: pending }
      );
    }

    // 反向 BFS：沿前置关系找出所有下游提示，其中仍有效"已触发"的即为受影响项
    const cues = getVersionCues(perf.version_id);
    const childrenOf = new Map();
    for (const c of cues) {
      for (const dep of c.deps) {
        if (!childrenOf.has(dep)) childrenOf.set(dep, []);
        childrenOf.get(dep).push(c);
      }
    }
    const affected = [];
    const visited = new Set([cue.label]);
    const queue = [cue.label];
    while (queue.length) {
      const curLabel = queue.shift();
      for (const child of childrenOf.get(curLabel) || []) {
        if (visited.has(child.label)) continue;
        visited.add(child.label);
        queue.push(child.label);
        const e = latestByCue.get(child.id);
        if (e && isFiredAction(e.action)) affected.push(child.label);
      }
    }
    if (affected.length) {
      throw new HttpError(
        409,
        `无法撤回：以下后续提示仍处于已触发状态，请先撤回：${affected.join('、')}`,
        { affected }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, 'retracted', operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/fire', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return recordEvent(Number(p.id), Number(p.cueId), 'fired', operator, null);
});

route('POST', '/api/performances/:id/cues/:cueId/skip', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '跳过必须填写原因');
  return recordEvent(Number(p.id), Number(p.cueId), 'skipped', operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/retract', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '撤回必须填写原因');
  return retractEvent(Number(p.id), Number(p.cueId), operator, reason);
});

/* ---- 双人复核（review） ----
 * 需复核提示（发布版本 cues.require_review=1）不能直接触发：
 *   申请人发起申请（不算触发、下游仍受阻）→ 另一位操作人确认（且前置当前均已触发）
 *   才写入有效触发流水 review_fired；申请人可撤销，其他人可填原因驳回，全程留痕。
 * 所有状态流转在 BEGIN IMMEDIATE 事务 + pending 部分唯一索引下串行完成，
 * 确认 / 撤销 / 驳回并发只可能有一个结局。
 */

/** 取出演出 + 版本内提示，不存在即 404 */
function getPerfCue(performanceId, cueId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
  if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');
  return { perf, cue };
}

/** 计算当前未触发的前置编号列表（已撤回不算；复核确认触发算） */
function unmetDeps(perfVersionId, deps, latestByCue) {
  if (!deps.length) return [];
  const labels = db.prepare('SELECT id, label FROM cues WHERE version_id = ?').all(perfVersionId);
  const fired = new Set(
    labels
      .filter((r) => {
        const e = latestByCue.get(r.id);
        return e && isFiredAction(e.action);
      })
      .map((r) => r.label)
  );
  return deps.filter((d) => !fired.has(d));
}

/** 附带提示编号返回申请 */
function getReviewRequest(id) {
  return db.prepare(`
    SELECT r.*, c.label, c.seq FROM review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.id = ?
  `).get(id);
}

route('POST', '/api/performances/:id/review-requests', (body, p) => {
  const performanceId = Number(p.id);
  const applicant = String(body.applicant || '').trim().slice(0, 50);
  if (!applicant) throw new HttpError(400, '请填写申请人');
  const cueId = Number(body.cue_id);
  if (!Number.isInteger(cueId) || cueId <= 0) throw new HttpError(400, '缺少 cue_id');

  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);
    if (!cue.require_review) {
      throw new HttpError(400, '该提示无需双人复核，可直接触发');
    }
    const latest = latestEventsByCue(performanceId).get(cueId) || null;
    if (effectiveAction(latest)) {
      // 已触发 / 已跳过 / 已确认提示不再受理申请
      throw conflictError(latest);
    }
    const existing = db.prepare(
      "SELECT * FROM review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending'"
    ).get(performanceId, cueId);
    if (existing) {
      throw new HttpError(
        409,
        `该提示已有待处理申请（申请人 ${existing.applicant}，时间 ${existing.applied_at}），待处理期间不能重复申请`,
        { review_request: getReviewRequest(existing.id) }
      );
    }

    let info;
    try {
      info = db.prepare(
        'INSERT INTO review_requests (performance_id, cue_id, status, applicant) VALUES (?,?,?,?)'
      ).run(performanceId, cueId, 'pending', applicant);
    } catch (err) {
      // 并发下部分唯一索引兜底：同一提示只允许一条 pending
      if (String(err && err.message).includes('UNIQUE')) {
        const race = db.prepare(
          "SELECT * FROM review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending'"
        ).get(performanceId, cueId);
        throw new HttpError(409, '该提示已有待处理申请，待处理期间不能重复申请', {
          review_request: race ? getReviewRequest(race.id) : null,
        });
      }
      throw err;
    }
    // 提示仍不算已触发：下游前置继续受阻，不产生 cue_events 流水
    return { review_request: getReviewRequest(Number(info.lastInsertRowid)) };
  });
});

route('POST', '/api/review-requests/:rid/confirm', (body, p) => {
  const rid = Number(p.rid);
  const confirmer = String(body.confirmer || '').trim().slice(0, 50);
  if (!confirmer) throw new HttpError(400, '请填写确认人');

  return withTx(() => {
    const req = db.prepare('SELECT * FROM review_requests WHERE id = ?').get(rid);
    if (!req) throw new HttpError(404, '复核申请不存在');
    if (req.status !== 'pending') {
      throw new HttpError(
        409,
        `该申请已处理：${REVIEW_STATUS_TEXT[req.status]}，不能重复确认`,
        { review_request: getReviewRequest(rid) }
      );
    }
    if (confirmer === req.applicant) {
      throw new HttpError(400, '确认人必须是申请人之外的另一位操作人');
    }

    // 前置当前均已触发才确认；前置失效（被撤回等）时拒绝，申请保持待处理
    const { cue } = getPerfCue(req.performance_id, req.cue_id);
    const deps = JSON.parse(cue.deps);
    const unmet = unmetDeps(cue.version_id, deps, latestEventsByCue(req.performance_id));
    if (unmet.length) {
      throw new HttpError(
        422,
        `前置提示当前未全部触发，不能确认：${unmet.join('、')}；申请保持待处理`,
        { unmet, review_request: getReviewRequest(rid) }
      );
    }
    // 双重保险：确认瞬间提示已被并发触发/跳过（理论上待处理申请会先拦截）
    const latest = latestEventsByCue(req.performance_id).get(req.cue_id) || null;
    if (effectiveAction(latest)) throw conflictError(latest);

    // 条件更新 + changes 校验：与撤销/驳回并发时只有一个结局
    const upd = db.prepare(`
      UPDATE review_requests
         SET status = 'confirmed', confirmer = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'pending'
    `).run(confirmer, rid);
    if (upd.changes === 0) {
      throw new HttpError(409, '该申请刚刚已被处理', { review_request: getReviewRequest(rid) });
    }
    // 此时才写入有效触发流水（操作人记确认人；申请记录保留申请人与申请时间）
    const evInfo = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(req.performance_id, req.cue_id, 'review_fired', confirmer, null);

    return {
      review_request: getReviewRequest(rid),
      event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(evInfo.lastInsertRowid)),
    };
  });
});

route('POST', '/api/review-requests/:rid/cancel', (body, p) => {
  const rid = Number(p.rid);
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');

  return withTx(() => {
    const req = db.prepare('SELECT * FROM review_requests WHERE id = ?').get(rid);
    if (!req) throw new HttpError(404, '复核申请不存在');
    if (req.status !== 'pending') {
      throw new HttpError(409, `该申请已处理：${REVIEW_STATUS_TEXT[req.status]}，不能撤销`, {
        review_request: getReviewRequest(rid),
      });
    }
    if (operator !== req.applicant) {
      throw new HttpError(403, '只有申请人本人可以撤销；其他人请使用驳回并填写原因');
    }
    const upd = db.prepare(`
      UPDATE review_requests
         SET status = 'cancelled', cancel_operator = ?, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'pending'
    `).run(operator, rid);
    if (upd.changes === 0) {
      throw new HttpError(409, '该申请刚刚已被处理', { review_request: getReviewRequest(rid) });
    }
    return { review_request: getReviewRequest(rid) };
  });
});

route('POST', '/api/review-requests/:rid/reject', (body, p) => {
  const rid = Number(p.rid);
  const operator = String(body.operator || '').trim().slice(0, 200);
  if (!operator) throw new HttpError(400, '请填写驳回操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '驳回必须填写原因');

  return withTx(() => {
    const req = db.prepare('SELECT * FROM review_requests WHERE id = ?').get(rid);
    if (!req) throw new HttpError(404, '复核申请不存在');
    if (req.status !== 'pending') {
      throw new HttpError(409, `该申请已处理：${REVIEW_STATUS_TEXT[req.status]}，不能驳回`, {
        review_request: getReviewRequest(rid),
      });
    }
    if (operator === req.applicant) {
      throw new HttpError(400, '申请人不能驳回自己的申请；如不继续请直接撤销');
    }
    const upd = db.prepare(`
      UPDATE review_requests
         SET status = 'rejected', reject_operator = ?, reject_reason = ?,
             rejected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'pending'
    `).run(operator, reason, rid);
    if (upd.changes === 0) {
      throw new HttpError(409, '该申请刚刚已被处理', { review_request: getReviewRequest(rid) });
    }
    return { review_request: getReviewRequest(rid) };
  });
});

/* ---------------- 分发 ---------------- */

async function handle(req, res, url, body) {
  const pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const result = await r.handler(body, params, req);
    return { status: 200, data: result };
  }
  throw new HttpError(404, '接口不存在');
}

module.exports = { handle, HttpError };
