'use strict';
/* 舞台监督提示单系统 —— 前端单页应用（原生 JS，hash 路由） */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const connEl = document.getElementById('conn');

const TYPE_TEXT = { light: '灯光', sound: '音效', set: '布景', other: '其他' };
const STATUS_TEXT = { pending: '待执行', fired: '已触发', skipped: '已跳过', blocked: '受阻' };

let toastTimer = null;
let pollTimer = null;

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString('zh-CN', { hour12: false });
}

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4200);
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    connEl.textContent = '连接失败';
    throw new Error('无法连接服务器');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  connEl.textContent = '';
  return data;
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function getOperator() {
  return (document.getElementById('operator-input') || {}).value ||
    localStorage.getItem('operator') || '';
}

/* ---------- 路由 ---------- */

function route() {
  stopPolling();
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').filter(Boolean);
  if (parts.length === 0) return renderShows();
  if (parts[0] === 'shows' && parts[1]) return renderShow(parts[1]);
  if (parts[0] === 'versions' && parts[1]) return renderVersion(parts[1]);
  if (parts[0] === 'performances' && parts[1]) return renderPerformance(parts[1]);
  renderShows();
}
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

/* ---------- 视图：场次列表 ---------- */

async function renderShows() {
  app.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { shows } = await api('/api/shows');
    app.innerHTML = `
      <h1>场次（剧目）</h1>
      <div class="panel row">
        <input id="new-show-name" type="text" placeholder="新场次名称，如《茶馆》2026 巡演" class="grow">
        <button id="create-show">新建场次</button>
      </div>
      <div class="panel">
        ${shows.length === 0 ? '<p class="muted">还没有场次，请先新建。</p>' : `
        <table>
          <thead><tr><th>名称</th><th>版本数</th><th>已发布</th><th>演出场次</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            ${shows.map(s => `
              <tr>
                <td>${esc(s.name)}</td>
                <td>${s.version_count}</td>
                <td>${s.published_count}</td>
                <td>${s.performance_count}</td>
                <td class="muted">${fmtTime(s.created_at)}</td>
                <td><a href="#/shows/${s.id}">进入 →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>`;
    document.getElementById('create-show').onclick = async () => {
      const name = document.getElementById('new-show-name').value.trim();
      if (!name) return toast('请输入场次名称', true);
      try {
        const { show } = await api('/api/shows', { method: 'POST', body: { name } });
        location.hash = `#/shows/${show.id}`;
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

/* ---------- 视图：场次详情（版本 + 演出） ---------- */

async function renderShow(id) {
  app.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { show, versions, performances } = await api(`/api/shows/${id}`);
    const published = versions.filter(v => v.status === 'published');
    app.innerHTML = `
      <h1>${esc(show.name)}</h1>

      <h2>执行单版本</h2>
      <div class="panel">
        <div class="row" style="margin-bottom:12px">
          <button id="new-draft">＋ 新建草稿（基于最新版本）</button>
          <span class="muted">发布后内容不可变；修改请新建草稿再发布新版本</span>
        </div>
        ${versions.length === 0 ? '<p class="muted">暂无版本。</p>' : `
        <table>
          <thead><tr><th>版本</th><th>状态</th><th>备注</th><th>创建时间</th><th>发布时间</th><th></th></tr></thead>
          <tbody>
            ${versions.map(v => `
              <tr>
                <td>v${v.version_number}</td>
                <td><span class="badge ${v.status}">${v.status === 'published' ? '已发布' : '草稿'}</span></td>
                <td class="muted">${esc(v.note || '')}</td>
                <td class="muted">${fmtTime(v.created_at)}</td>
                <td class="muted">${v.published_at ? fmtTime(v.published_at) : '-'}</td>
                <td><a href="#/versions/${v.id}">${v.status === 'draft' ? '编辑' : '查看'} →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>

      <h2>启动演出</h2>
      <div class="panel row">
        ${published.length === 0
          ? '<span class="muted">无已发布版本，请先在上方编辑并发布执行单。</span>'
          : `
          <select id="perf-version">
            ${published.map(v => `<option value="${v.id}">v${v.version_number}${v.note ? '（' + esc(v.note) + '）' : ''}</option>`).join('')}
          </select>
          <input id="perf-name" type="text" placeholder="演出名称，如 9月30日 晚场">
          <input id="perf-operator" type="text" placeholder="启动人">
          <button id="start-perf">启动演出</button>`}
      </div>

      <h2>演出记录</h2>
      <div class="panel">
        ${performances.length === 0 ? '<p class="muted">暂无演出记录。</p>' : `
        <table>
          <thead><tr><th>#</th><th>名称</th><th>执行单版本</th><th>启动人</th><th>开始时间</th><th></th></tr></thead>
          <tbody>
            ${performances.map(p => `
              <tr>
                <td>${p.id}</td>
                <td>${esc(p.name || '（未命名）')}</td>
                <td>v${p.version_number}</td>
                <td>${esc(p.started_by || '-')}</td>
                <td class="muted">${fmtTime(p.started_at)}</td>
                <td><a href="#/performances/${p.id}">进入执行台 →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>`;

    document.getElementById('new-draft').onclick = async () => {
      try {
        const { version } = await api(`/api/shows/${id}/versions`, { method: 'POST', body: {} });
        toast(`已创建草稿 v${version.version_number}`);
        location.hash = `#/versions/${version.id}`;
      } catch (e) { toast(e.message, true); }
    };

    const startBtn = document.getElementById('start-perf');
    if (startBtn) startBtn.onclick = async () => {
      try {
        const { performance } = await api(`/api/shows/${id}/performances`, {
          method: 'POST',
          body: {
            version_id: Number(document.getElementById('perf-version').value),
            name: document.getElementById('perf-name').value.trim(),
            operator: document.getElementById('perf-operator').value.trim(),
          },
        });
        location.hash = `#/performances/${performance.id}`;
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

/* ---------- 视图：版本（草稿编辑器 / 已发布快照） ---------- */

let editorCues = null; // 当前草稿编辑内容

function collectEditorCues() {
  return editorCues.map(c => ({
    label: c.label.trim(),
    type: c.type,
    description: c.description.trim(),
    deps: c.depsText.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
  }));
}

function renderEditorTable() {
  const tbody = document.getElementById('editor-tbody');
  tbody.innerHTML = editorCues.map((c, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td><input type="text" class="label-input" data-i="${i}" data-f="label" value="${esc(c.label)}" placeholder="如 L1"></td>
      <td>
        <select data-i="${i}" data-f="type">
          ${Object.entries(TYPE_TEXT).map(([k, t]) =>
            `<option value="${k}" ${c.type === k ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" data-i="${i}" data-f="description" value="${esc(c.description)}" placeholder="提示内容描述"></td>
      <td><input type="text" class="deps-input" data-i="${i}" data-f="depsText" value="${esc(c.depsText)}" placeholder="前置编号，逗号分隔"></td>
      <td style="white-space:nowrap">
        <button class="ghost small" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="ghost small" data-act="down" data-i="${i}" ${i === editorCues.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="danger small" data-act="del" data-i="${i}">删</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('input,select').forEach(el => {
    el.onchange = el.oninput = () => {
      const i = Number(el.dataset.i);
      editorCues[i][el.dataset.f] = el.value;
    };
  });
  tbody.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i);
      const act = btn.dataset.act;
      if (act === 'del') editorCues.splice(i, 1);
      else if (act === 'up' && i > 0) [editorCues[i - 1], editorCues[i]] = [editorCues[i], editorCues[i - 1]];
      else if (act === 'down' && i < editorCues.length - 1) [editorCues[i + 1], editorCues[i]] = [editorCues[i], editorCues[i + 1]];
      renderEditorTable();
    };
  });
}

function showErrors(errors) {
  const box = document.getElementById('validate-result');
  if (!box) return;
  if (!errors || errors.length === 0) {
    box.innerHTML = '<div class="ok-box">✓ 校验通过：无缺失引用、无循环依赖</div>';
  } else {
    box.innerHTML = `<div class="error-list"><b>发现 ${errors.length} 个问题：</b><ul>${
      errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  }
}

async function renderVersion(id) {
  app.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { version, cues } = await api(`/api/versions/${id}`);
    const isDraft = version.status === 'draft';

    if (!isDraft) {
      // 已发布：只读快照（历史按当时版本回看）
      app.innerHTML = `
        <h1>执行单 v${version.version_number} <span class="badge published">已发布 · 不可变</span></h1>
        <p class="muted">发布于 ${fmtTime(version.published_at)}　${esc(version.note || '')}</p>
        <div class="panel">
          <table>
            <thead><tr><th>#</th><th>编号</th><th>类型</th><th>描述</th><th>前置提示</th></tr></thead>
            <tbody>
              ${cues.map(c => `
                <tr>
                  <td class="muted">${c.seq}</td>
                  <td><b>${esc(c.label)}</b></td>
                  <td>${TYPE_TEXT[c.type] || c.type}</td>
                  <td>${esc(c.description)}</td>
                  <td>${c.deps.length ? c.deps.map(d => `<span class="dep-chip">${esc(d)}</span>`).join('') : '<span class="muted">无</span>'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="row">
          <a href="#/shows/${version.show_id}">← 返回场次</a>
          <button class="ghost" id="copy-draft">以此版本为基准新建草稿</button>
        </div>`;
      document.getElementById('copy-draft').onclick = async () => {
        try {
          const r = await api(`/api/shows/${version.show_id}/versions`, {
            method: 'POST', body: { from_version_id: version.id },
          });
          toast(`已创建草稿 v${r.version.version_number}`);
          location.hash = `#/versions/${r.version.id}`;
        } catch (e) { toast(e.message, true); }
      };
      return;
    }

    // 草稿编辑器
    editorCues = cues.map(c => ({
      label: c.label, type: c.type, description: c.description, depsText: c.deps.join(', '),
    }));

    app.innerHTML = `
      <h1>执行单 v${version.version_number} <span class="badge draft">草稿</span></h1>
      <p class="muted">前置提示填写其他提示的编号（逗号分隔）。保存不影响已开始的演出。</p>
      <div class="panel">
        <table class="editor-table">
          <thead><tr><th>#</th><th>编号</th><th>类型</th><th>描述</th><th>前置提示</th><th>操作</th></tr></thead>
          <tbody id="editor-tbody"></tbody>
        </table>
        <div class="row" style="margin-top:12px">
          <button class="ghost" id="add-cue">＋ 添加提示</button>
        </div>
      </div>
      <div id="validate-result"></div>
      <div class="row">
        <button id="save-draft">保存草稿</button>
        <button class="ghost" id="validate-btn">校验</button>
        <button class="big" id="publish-btn">校验并发布</button>
        <a href="#/shows/${version.show_id}" style="margin-left:auto">← 返回场次</a>
      </div>`;

    renderEditorTable();

    document.getElementById('add-cue').onclick = () => {
      editorCues.push({ label: '', type: 'light', description: '', depsText: '' });
      renderEditorTable();
    };

    document.getElementById('save-draft').onclick = async () => {
      try {
        const r = await api(`/api/versions/${id}/cues`, {
          method: 'PUT', body: { cues: collectEditorCues() },
        });
        toast('草稿已保存');
        showErrors(r.errors);
      } catch (e) { toast(e.message, true); }
    };

    document.getElementById('validate-btn').onclick = async () => {
      try {
        const r = await api(`/api/versions/${id}/validate`, {
          method: 'POST', body: { cues: collectEditorCues() },
        });
        showErrors(r.errors);
      } catch (e) { toast(e.message, true); }
    };

    document.getElementById('publish-btn').onclick = async () => {
      try {
        // 先保存当前编辑内容，再发布
        const saved = await api(`/api/versions/${id}/cues`, {
          method: 'PUT', body: { cues: collectEditorCues() },
        });
        if (saved.errors && saved.errors.length) {
          showErrors(saved.errors);
          return toast('校验未通过，无法发布', true);
        }
        await api(`/api/versions/${id}/publish`, { method: 'POST', body: {} });
        toast('已发布，执行单不可再修改');
        renderVersion(id);
      } catch (e) {
        if (e.data && e.data.errors) showErrors(e.data.errors);
        toast(e.message, true);
      }
    };
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

/* ---------- 视图：演出执行台 ---------- */

async function renderPerformance(id) {
  try {
    const data = await api(`/api/performances/${id}`);
    drawPerformance(id, data);
    if (!pollTimer) {
      pollTimer = setInterval(async () => {
        try {
          const d = await api(`/api/performances/${id}`);
          drawPerformance(id, d);
        } catch (e) { connEl.textContent = '刷新失败'; }
      }, 2500);
    }
  } catch (e) { app.innerHTML = `<div class="error-list">${esc(e.message)}</div>`; }
}

function drawPerformance(id, { performance: perf, cues, events }) {
  const counts = { pending: 0, fired: 0, skipped: 0, blocked: 0 };
  cues.forEach(c => counts[c.status]++);

  const opVal = document.getElementById('operator-input')
    ? document.getElementById('operator-input').value
    : (localStorage.getItem('operator') || '');

  app.innerHTML = `
    <div class="perf-head">
      <h1 style="margin:4px 0">${esc(perf.show_name)} · ${esc(perf.name || '演出 #' + perf.id)}</h1>
      <div class="row muted" style="font-size:13px">
        <span>执行单 v${perf.version_number}（已发布快照）</span>
        <span>开始：${fmtTime(perf.started_at)}</span>
        <span>启动人：${esc(perf.started_by || '-')}</span>
        <span class="status pending">待执行 ${counts.pending}</span>
        <span class="status fired">已触发 ${counts.fired}</span>
        <span class="status skipped">已跳过 ${counts.skipped}</span>
        <span class="status blocked">受阻 ${counts.blocked}</span>
        <span class="grow"></span>
        <label>操作人 <input id="operator-input" type="text" value="${esc(opVal)}" placeholder="姓名" style="width:110px"></label>
        <a href="#/shows/${perf.show_id}">返回场次</a>
      </div>
    </div>
    <div class="grid-2">
      <div id="cue-list">
        ${cues.map(c => cueCard(id, c)).join('')}
      </div>
      <div class="panel event-log">
        <b>执行记录（最新在上）</b>
        ${events.length === 0 ? '<p class="muted">暂无记录</p>' : `
        <ul>
          ${events.map(e => `
            <li>
              <span class="status ${e.action}">${ACTION_TEXT(e.action)}</span>
              <b>${esc(e.label)}</b><br>
              <span class="muted">${esc(e.operator)} · ${fmtTime(e.created_at)}${e.reason ? '<br>原因：' + esc(e.reason) : ''}</span>
            </li>`).join('')}
        </ul>`}
      </div>
    </div>`;

  const opInput = document.getElementById('operator-input');
  opInput.onchange = opInput.oninput = () => localStorage.setItem('operator', opInput.value.trim());

  cues.forEach(c => {
    const fireBtn = document.getElementById(`fire-${c.id}`);
    const skipBtn = document.getElementById(`skip-${c.id}`);
    const retractBtn = document.getElementById(`retract-${c.id}`);
    if (fireBtn) fireBtn.onclick = () => doFire(id, c.id);
    if (skipBtn) skipBtn.onclick = () => doSkip(id, c.id);
    if (retractBtn) retractBtn.onclick = () => doRetract(id, c.id);
  });
}

function ACTION_TEXT(a) {
  return a === 'fired' ? '已触发' : a === 'skipped' ? '已跳过' : '已撤回';
}

function cueCard(perfId, c) {
  const depsHtml = c.deps.length
    ? c.deps.map(d => `<span class="dep-chip ${c.unmet.includes(d) ? 'unmet-chip' : 'met'}">${esc(d)}</span>`).join('')
    : '<span class="muted">无前置</span>';
  const eventHtml = c.event
    ? `<div class="cue-event">${ACTION_TEXT(c.event.action)} · ${esc(c.event.operator)} · ${fmtTime(c.event.created_at)}${c.event.reason ? ' · 原因：' + esc(c.event.reason) : ''}</div>`
    : '';
  const blockedHtml = c.status === 'blocked'
    ? `<div class="cue-event"><span class="unmet">受阻：前置 ${c.unmet.map(esc).join('、')} 未触发</span></div>`
    : '';
  const canAct = c.status === 'pending';
  const done = c.status === 'fired' || c.status === 'skipped';
  const canRetract = c.status === 'fired';
  return `
    <div class="cue-card ${c.status}">
      <div class="cue-seq">${c.seq}</div>
      <div class="cue-main">
        <div class="cue-title">
          <span class="cue-label">${esc(c.label)}</span>
          <span class="cue-type">${TYPE_TEXT[c.type] || c.type}</span>
          <span class="status ${c.status}">${STATUS_TEXT[c.status]}</span>
        </div>
        ${c.description ? `<div class="cue-desc">${esc(c.description)}</div>` : ''}
        <div class="cue-deps">前置：${depsHtml}</div>
        ${blockedHtml}
        ${eventHtml}
      </div>
      <div class="cue-actions">
        <button id="fire-${c.id}" ${canAct ? '' : 'disabled'}>触发</button>
        <button id="skip-${c.id}" class="ghost" ${done ? 'disabled' : ''}>跳过</button>
        <button id="retract-${c.id}" class="danger" ${canRetract ? '' : 'disabled'}>撤回</button>
      </div>
    </div>`;
}

async function doFire(perfId, cueId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  try {
    await api(`/api/performances/${perfId}/cues/${cueId}/fire`, { method: 'POST', body: { operator } });
  } catch (e) {
    toast(e.message, true); // 409 冲突 / 422 受阻等，消息含当前状态
  }
  stopPolling();
  renderPerformance(perfId);
}

async function doSkip(perfId, cueId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  const reason = window.prompt('请填写跳过原因（必填）：');
  if (reason == null) return;
  if (!reason.trim()) return toast('跳过必须填写原因', true);
  try {
    await api(`/api/performances/${perfId}/cues/${cueId}/skip`, {
      method: 'POST', body: { operator, reason: reason.trim() },
    });
  } catch (e) {
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}

async function doRetract(perfId, cueId) {
  const operator = getOperator();
  if (!operator) { toast('请先填写操作人', true); return document.getElementById('operator-input').focus(); }
  const reason = window.prompt('请填写撤回原因（必填，如：误触发）：');
  if (reason == null) return;
  if (!reason.trim()) return toast('撤回必须填写原因', true);
  try {
    await api(`/api/performances/${perfId}/cues/${cueId}/retract`, {
      method: 'POST', body: { operator, reason: reason.trim() },
    });
    toast('已撤回，该提示可重新执行');
  } catch (e) {
    // 409：当前状态不允许撤回，或下游仍有已触发提示（消息含受影响编号）
    toast(e.message, true);
  }
  stopPolling();
  renderPerformance(perfId);
}
