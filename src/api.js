'use strict';
/**
 * API 路由与业务逻辑。
 * 错误约定：返回 { error: 消息, ... } ，状态码语义：
 *   400 参数/前置条件错误（含无已发布版本、版本未发布、跳过/撤回/驳回缺原因）
 *   404 资源不存在
 *   409 冲突（提示已有结果、版本已发布不可改、撤回时当前状态不允许或下游仍已触发、
 *       复核申请重复/已处置/处置人身份不符、待复核期间跳过或撤回）
 *   422 校验未通过（缺失引用/循环依赖）或前置未触发（受阻，含复核确认时前置失效）
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

const ACTION_TEXT = { fired: '已触发', skipped: '已跳过', retracted: '已撤回' };
const REQUEST_STATUS_TEXT = { pending: '待复核', confirmed: '已确认', cancelled: '已撤销', rejected: '已驳回' };

function sanitizeCue(raw) {
  const deps = Array.isArray(raw && raw.deps) ? raw.deps : [];
  return {
    label: String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50),
    type: CUE_TYPES.includes(raw && raw.type) ? raw.type : 'other',
    description: String((raw && raw.description) != null ? raw.description : '').trim().slice(0, 500),
    deps: [...new Set(deps.map((d) => String(d).trim()).filter(Boolean))].slice(0, 50),
    needs_review: raw && raw.needs_review ? 1 : 0,
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
    .map((c) => ({ ...c, deps: JSON.parse(c.deps) }));
}

function conflictError(existing) {
  return new HttpError(
    409,
    `该提示已有结果：${ACTION_TEXT[existing.action]}（操作人 ${existing.operator}，时间 ${existing.created_at}）`,
    { current: existing }
  );
}

/**
 * 演出内各提示的最新一条事件（cue_id -> event）。
 * 当前有效结果规则：最新事件为 fired/skipped 即有效；retracted（已撤回）或无事件 = 无有效结果。
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

/** 演出与提示的存在性校验（提示须属于演出锁定的版本），供各写操作复用 */
function getPerfCue(performanceId, cueId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
  if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');
  return { perf, cue };
}

/** 该演出某提示当前待复核的申请（无则 null）。须在事务内调用以保证判定一致 */
function pendingRequestFor(performanceId, cueId) {
  return db.prepare(
    "SELECT * FROM cue_review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(performanceId, cueId) || null;
}

/** 当前有效结果为"已触发"的提示编号集合（已撤回的不算） */
function firedLabelSet(versionId, latestByCue) {
  const rows = db.prepare('SELECT id, label FROM cues WHERE version_id = ?').all(versionId);
  return new Set(
    rows.filter((r) => {
      const e = latestByCue.get(r.id);
      return e && e.action === 'fired';
    }).map((r) => r.label)
  );
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
      const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review) VALUES (?,?,?,?,?,?,?)');
      for (const c of cues) ins.run(newId, c.seq, c.label, c.type, c.description, c.deps, c.needs_review);
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
    const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review) VALUES (?,?,?,?,?,?,?)');
    cues.forEach((c, i) => ins.run(version.id, i + 1, c.label, c.type, c.description, JSON.stringify(c.deps), c.needs_review));
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
  // 完整流水（含撤回），按时间升序；返回时倒序（最新在上）
  const events = db.prepare(`
    SELECT e.*, c.label, c.seq FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id
  `).all(perf.id);

  // 归约当前有效结果：fired/skipped 生效，retracted 清除该提示的有效结果
  const eventByCue = new Map();
  for (const e of events) {
    if (e.action === 'retracted') eventByCue.delete(e.cue_id);
    else eventByCue.set(e.cue_id, e);
  }
  const firedLabels = new Set();
  for (const e of eventByCue.values()) {
    if (e.action === 'fired') firedLabels.add(e.label);
  }

  const cueStates = cues.map((c) => {
    const event = eventByCue.get(c.id) || null;
    let status;
    let unmet = [];
    if (event) {
      status = event.action; // fired / skipped
    } else {
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = unmet.length ? 'blocked' : 'pending';
    }
    return { ...c, status, unmet, event };
  });

  // 双人复核申请流水（最新在上）；待复核申请同时挂到对应提示上，便于执行台禁用操作
  const reviewRequests = db.prepare(`
    SELECT r.*, c.label, c.seq FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id DESC
  `).all(perf.id);
  const pendingByCue = new Map();
  for (const r of reviewRequests) {
    if (r.status === 'pending' && !pendingByCue.has(r.cue_id)) pendingByCue.set(r.cue_id, r);
  }
  for (const c of cueStates) c.pending_request = pendingByCue.get(c.id) || null;

  return { performance: perf, cues: cueStates, events: events.slice().reverse(), review_requests: reviewRequests };
});

/* ---- 触发 / 跳过 / 撤回（并发安全：BEGIN IMMEDIATE 事务内读最新事件再判定写入） ---- */

function recordEvent(performanceId, cueId, action, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 待复核申请处理前，该提示禁止跳过（fire 对需复核提示已在路由层转为登记申请，不会走到这里）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能${action === 'skipped' ? '跳过' : '触发'}`,
        { request: pending }
      );
    }

    if (action === 'fired') {
      const deps = JSON.parse(cue.deps);
      if (deps.length) {
        // 前置是否满足以"当前有效结果为已触发"判定（已撤回的前置不算）
        const fired = firedLabelSet(perf.version_id, latestByCue);
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
    const { perf, cue } = getPerfCue(performanceId, cueId);

    // 待复核申请处理前禁止撤回（此时提示本就无有效结果，这里给出更明确的错误）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能撤回`,
        { request: pending }
      );
    }

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
    if (current !== 'fired') {
      throw new HttpError(409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
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
        if (e && e.action === 'fired') affected.push(child.label);
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

/* ---- 双人复核：触发申请 / 确认 / 撤销 / 驳回 ---- */

/**
 * 登记触发申请：仅登记申请人与时间，提示不算已触发、下游前置仍受阻。
 * 重复申请（已有待复核）或提示已有结果时 409。前置是否满足在确认时才判定，申请阶段不限制。
 */
function createReviewRequest(performanceId, cueId, operator) {
  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    const existing = pendingRequestFor(performanceId, cueId);
    if (existing) {
      throw new HttpError(
        409,
        `该提示已存在待复核的触发申请（申请人 ${existing.requested_by}，时间 ${existing.requested_at}），请勿重复申请`,
        { request: existing }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_review_requests (performance_id, cue_id, requested_by) VALUES (?,?,?)'
    ).run(performanceId, cueId, operator);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/** 取申请并校验属于该演出 */
function getReviewRequest(performanceId, requestId) {
  const req = db.prepare(
    'SELECT * FROM cue_review_requests WHERE id = ? AND performance_id = ?'
  ).get(requestId, performanceId);
  if (!req) throw new HttpError(404, '复核申请不存在');
  return req;
}

function requestConflict(req) {
  return new HttpError(
    409,
    `该申请已处置：${REQUEST_STATUS_TEXT[req.status]}（处置人 ${req.resolved_by || '-'}，时间 ${req.resolved_at || '-'}）`,
    { request: req }
  );
}

/**
 * 确认申请：须为申请人之外的另一操作人；且前置当前均已触发，否则 422 且申请保持待复核。
 * 确认与撤销/驳回在同一事务内判定，并发只有一种结局。确认后写入有效 fired 流水并关联申请。
 */
function confirmReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '复核确认人不能与申请人相同，须由另一操作人确认', { request: req });
    }

    const { perf, cue } = getPerfCue(performanceId, req.cue_id);
    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(req.cue_id) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 前置失效（未触发或已撤回）时拒绝确认，申请保持待复核
    const deps = JSON.parse(cue.deps);
    if (deps.length) {
      const fired = firedLabelSet(perf.version_id, latestByCue);
      const unmet = deps.filter((d) => !fired.has(d));
      if (unmet.length) {
        throw new HttpError(422, `前置提示未触发，无法确认：${unmet.join('、')}`, { unmet, request: req });
      }
    }

    const evInfo = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, req.cue_id, 'fired', operator, `双人复核确认（申请人：${req.requested_by}）`);
    const eventId = Number(evInfo.lastInsertRowid);
    db.prepare(
      "UPDATE cue_review_requests SET status = 'confirmed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), event_id = ? WHERE id = ?"
    ).run(operator, eventId, req.id);
    return {
      request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id),
      event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(eventId),
    };
  });
}

/** 撤销申请：仅申请人本人可撤销待复核申请 */
function cancelReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by !== operator) {
      throw new HttpError(409, `只能由申请人本人（${req.requested_by}）撤销该申请`, { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'cancelled', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(operator, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

/** 驳回申请：申请人之外的其他人填写原因驳回 */
function rejectReviewRequest(performanceId, requestId, operator, reason) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '申请人请使用撤销；驳回须由其他操作人执行', { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolve_reason = ? WHERE id = ?"
    ).run(operator, reason, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/fire', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  // 需双人复核的提示：触发接口转为登记复核申请，不能绕过复核直接写入触发流水；
  // 普通提示保持原有行为与响应（{ event }）
  const { cue } = getPerfCue(perfId, cueId);
  if (cue.needs_review) return createReviewRequest(perfId, cueId, operator);
  return recordEvent(perfId, cueId, 'fired', operator, null);
});

route('POST', '/api/performances/:id/cues/:cueId/review-requests', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  const { cue } = getPerfCue(perfId, cueId);
  if (!cue.needs_review) {
    throw new HttpError(400, `提示「${cue.label}」未标记需双人复核，可直接触发`);
  }
  return createReviewRequest(perfId, cueId, operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/confirm', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return confirmReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/cancel', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return cancelReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/reject', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '驳回必须填写原因');
  return rejectReviewRequest(Number(p.id), Number(p.reqId), operator, reason);
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
