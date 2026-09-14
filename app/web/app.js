// 前端逻辑：五个页面 + 任务日志流 + 弹窗确认
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let STATE = {
  config: null,
  presets: [],
  secretState: {},
  exports: [],
  allExports: [],
  summaries: [],
  social: [],
  compares: [],
  summaryFiles: [],
  docTemplates: [],
  jobLogs: new Map(),
  currentJob: '',
  flow: { steps: [], running: false, done: [], failedAt: '' },
};

// ------------------------------------------------------------------ 基础工具
async function api(path, { method = 'GET', body, silent = false, label = '' } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (!silent) reportFailure(label || `${method} ${path}`, `网络错误：${err.message}`);
    throw err;
  }
  const json = await res.json().catch(() => ({ ok: false, error: `返回不是 JSON（HTTP ${res.status}）` }));
  if (!json.ok) {
    const err = new Error(json.error || `请求失败（HTTP ${res.status}）`);
    if (!silent) reportFailure(label || `${method} ${path}`, err.message);
    throw err;
  }
  return json.data;
}

/** 统一的失败反馈：弹错误提示（15 秒、可点击关闭）并在日志区留痕 */
function reportFailure(label, message) {
  toast(`【${label}】${message}`, 'err');
  const box = $('#lastError');
  if (box) {
    box.style.display = '';
    box.textContent = `最近一次失败：${label} — ${message}（${new Date().toLocaleTimeString()}）`;
  }
  console.error(`[api] ${label}: ${message}`);
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.title = '点击关闭';
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 15000 : 4500);
}

/** 统一的动作包装：失败必给可见反馈（避免"点了没反应"的观感） */
async function action(name, fn) {
  try {
    return await fn();
  } catch (err) {
    toast(`【${name}】失败：${err.message}`, 'err');
    console.error(`[action] ${name}`, err);
    const box = $('#lastError');
    if (box) {
      box.style.display = '';
      box.textContent = `【${name}】${err.message}（${new Date().toLocaleTimeString()}）`;
    }
    return null;
  }
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
}

/** 刷新「当前进程」面板 */
/** 进程面板的 PID 列。
 *  注意：不是所有任务都有子进程 —— 关键词验证、一键流程这类是**进程内任务**（runTask，pid 为 null），
 *  它们 pidAlive 必然为 false，若直接按 pidAlive 判断就会给正在跑的任务错标「已退出」（实测踩过）。
 *  所以只在「确实有子进程、但进程已经没了」时才提示。 */
function renderProcPid(job) {
  if (!job.pid) return '<span class="muted" title="该任务在控制台进程内执行，没有独立子进程">内部任务</span>';
  return `${job.pid}${job.pidAlive ? '' : ' <span class="badge warn" title="子进程已不存在，任务可能卡住">已退出</span>'}`;
}

async function refreshProcesses() {
  try {
    const data = await api('/api/processes');
    const rows = data.running || [];
    const tbody = $('#procRows');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">当前没有正在运行的任务</td></tr>';
    } else {
      tbody.innerHTML = rows.map((job) => `
        <tr>
          <td><span class="badge ok">运行中</span></td>
          <td><b>${escapeHtml(job.title)}</b><div class="muted mono">${escapeHtml(job.kind)} · ${job.id.slice(0, 8)}</div></td>
          <td class="mono">${renderProcPid(job)}</td>
          <td class="mono">${fmtDuration(Date.now() - job.createdAt)}</td>
          <td class="mono" style="max-width:420px;word-break:break-all">${escapeHtml(job.commandLine || '')}</td>
          <td><button class="btn small danger" data-killjob="${job.id}">终止</button></td>
        </tr>`).join('');
    }
    const info = $('#procAppInfo');
    if (info) {
      info.textContent = `控制台自身进程 PID ${data.appPid}，已运行 ${fmtDuration(data.uptimeSec * 1000)}；当前运行中任务 ${data.runningCount} 个。`;
    }
  } catch { /* 轮询失败静默处理，不打扰用户 */ }
}

function initProcessPanel() {
  refreshProcesses();
  setInterval(refreshProcesses, 3000);
  const tbody = $('#procRows');
  if (!tbody) return;
  tbody.addEventListener('click', async (event) => {
    const id = event.target.dataset.killjob;
    if (!id) return;
    await action('终止任务', async () => {
      await api('/api/jobs/cancel', { method: 'POST', body: { id } });
      toast('已请求终止该任务');
      refreshProcesses();
    });
  });
}

function modal(html, { onOpen } = {}) {
  const backdrop = $('#modalBackdrop');
  $('#modalBox').innerHTML = html;
  backdrop.classList.add('show');
  backdrop.onclick = (event) => {
    if (event.target === backdrop) closeModal();
  };
  if (onOpen) onOpen($('#modalBox'));
}

function closeModal() {
  $('#modalBackdrop').classList.remove('show');
  $('#modalBox').innerHTML = '';
}

function confirmModal(title, html, confirmText = '确认') {
  return new Promise((resolve) => {
    modal(`
      <h3>${title}</h3>
      ${html}
      <div class="actions">
        <button class="btn" id="mCancel">取消</button>
        <button class="btn primary" id="mOk">${confirmText}</button>
      </div>`, {
      onOpen: () => {
        $('#mCancel').onclick = () => { closeModal(); resolve(false); };
        $('#mOk').onclick = () => { closeModal(); resolve(true); };
      },
    });
  });
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 带一个文本框的弹窗；取消返回 null（用于「另存为模板」这类需要输入名字的场景） */
function inputModal(title, hint, initial = '', placeholder = '') {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; closeModal(); resolve(value); } };
    modal(`
      <h3>${escapeHtml(title)}</h3>
      ${hint ? `<p class="muted">${escapeHtml(hint)}</p>` : ''}
      <input type="text" id="mInput" value="${escapeHtml(initial)}" placeholder="${escapeHtml(placeholder)}" style="width:100%">
      <div class="actions">
        <button class="btn" id="mCancel">取消</button>
        <button class="btn primary" id="mOk">确定</button>
      </div>`, {
      onOpen: () => {
        const box = $('#mInput');
        box.focus();
        box.select();
        box.onkeydown = (event) => {
          if (event.key === 'Enter') finish(box.value);
          if (event.key === 'Escape') finish(null);
        };
        $('#mCancel').onclick = () => finish(null);
        $('#mOk').onclick = () => finish(box.value);
      },
    });
  });
}

// ------------------------------------------------------------------ 日志流
function appendLog(jobId, line, stream) {
  if (!STATE.jobLogs.has(jobId)) STATE.jobLogs.set(jobId, []);
  const lines = STATE.jobLogs.get(jobId);
  lines.push({ line, stream, t: Date.now() });
  if (lines.length > 3000) lines.splice(0, lines.length - 3000);
  if (STATE.currentJob === jobId || !STATE.currentJob) {
    STATE.currentJob = jobId;
    renderLog();
  }
}

function renderLog() {
  const box = $('#logBox');
  const lines = STATE.jobLogs.get(STATE.currentJob) || [];
  box.innerHTML = lines.map((item) =>
    `<span class="${item.stream}">${escapeHtml(item.line)}</span>`).join('\n');
  box.scrollTop = box.scrollHeight;
}

function initStream() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type === 'log') {
      appendLog(data.jobId, data.line, data.stream);
    } else if (data.type === 'job') {
      refreshJobs();
      if (!STATE.currentJob) STATE.currentJob = data.job.id;
    } else if (data.type === 'status') {
      refreshJobs();
      const label = data.status === 'done' ? '完成'
        : data.status === 'failed' ? '失败'
          : data.status === 'cancelled' ? '已取消' : data.status;
      const kind = data.status === 'failed' ? 'err' : (data.status === 'cancelled' ? '' : 'ok');
      toast(`任务${label}${data.status === 'failed' && data.error ? `：${data.error}` : ''}`, kind);
      if (data.status === 'failed') STATE.flow.failedAt = STATE.flow.failedAt || data.jobId;
      onJobFinished(data);
    } else if (data.type === 'dsh-cleanup') {
      if (data.deleted) toast(`已清理 ${data.deleted} 个本次任务产生的 DSH 会话`);
      else if (data.kept) toast('DSH 会话无需清理');
    } else if (data.type === 'progress') {
      renderFlowProgress(data.progress);
    }
  };
  source.onerror = () => { /* 断线由浏览器自动重连 */ };
}

function onJobFinished(data) {
  const job = data.jobId;
  if (STATE.flow.running) return; // 一键流程内部自行推进
  for (const [, lines] of STATE.jobLogs) lines.push({ line: `—— 任务 ${job.slice(0, 8)} ${data.status} ——`, stream: 'sys', t: Date.now() });
  renderLog();
  const kind = data.result || {};
  if (kind.outFile) loadSummaryFiles();
  // 关键修复：任务完成/失败后按任务类型刷新列表（此前只在 result.outDir 存在时刷新，
  // 而汇总脚本的 stdout 里并没有 outDir 字段，导致"已汇总"标签不刷新）
  const meta = data.meta || {};
  const targets = Array.isArray(meta.refresh) ? meta.refresh : [];
  if (STATE.debug) console.debug('[job-finished]', data.status, 'refresh=', targets.join(',') || '（无）');
  if (targets.includes('summaries')) loadSummaries();
  if (targets.includes('exports')) loadExports();
  if (targets.includes('social')) loadSocial();
  if (targets.includes('compares')) loadCompareOptions();
  if (kind.keywords) renderKeywords(kind.keywords);
  if (typeof kind.changed === 'number') renderClassifyResult(kind);
  if (kind.counts) renderVerdicts(kind);
  // 关键词提取完成 / 验证完成 → 刷新对应视图
  if (meta.refresh?.includes('keywords') || /keywords/.test(job)) { refreshKeywordViews(); }
  if (meta.refresh?.includes('uploads') || /uploads|extract-files/.test(job)) { loadDocs(); }
  if (meta.refresh?.includes('docs') || /doc-summary/.test(job)) { loadDocs(); }
  if (meta.refresh?.includes('login') || /login-check/.test(job)) { loadLoginStatus(); }
  if (kind.partialFile) toast(`DSH 未生成报告，原始输出已存到 ${kind.partialFile}`, 'err');
}

/** 关键词相关视图刷新：候选词（提取完成后）与验证记录 */
async function refreshKeywordViews() {
  const summaryDir = $('#kvSummaryDir')?.value;
  if (summaryDir) {
    try {
      const res = await fetch(`/api/keywords?summaryDir=${encodeURIComponent(summaryDir)}`).then((r) => r.json());
      if (res?.ok && res.data?.ok) {
        KV.candidates = res.data.keywords || [];
        KV.selected.clear();
        KV.candidates.slice(0, 8).forEach((item) => KV.selected.add(item.keyword));
        renderKvCandidates();
        toast(`已提取 ${KV.candidates.length} 个候选关键词（默认勾选前 8 个）`, 'ok');
      }
    } catch { /* 忽略 */ }
  }
  loadKvResults();
}

async function refreshJobs() {
  try {
    const data = await api('/api/jobs');
    const pick = $('#jobPick');
    const previous = pick.value;
    pick.innerHTML = data.jobs.map((job) => {
      const pid = job.pid ? ` PID ${job.pid}` : '';
      const dur = job.status === 'running' ? ` · 运行中 ${fmtDuration(Date.now() - job.createdAt)}` : '';
      return `<option value="${job.id}">[${job.status}] ${escapeHtml(job.title)}${pid}${dur}</option>`;
    }).join('');
    if (previous && data.jobs.some((job) => job.id === previous)) pick.value = previous;
    else if (!STATE.currentJob && data.jobs[0]) STATE.currentJob = data.jobs[0].id;
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ 页面切换
const PAGE_TITLES = {
  exports: '导出与汇总', collect: '采集与关键词', compare: '交叉比对',
  summary: '总结', docs: '文件汇总', settings: '设置',
};

function switchPage(page) {
  $$('#nav button').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $('#pageTitle').textContent = PAGE_TITLES[page] || page;
  if (page === 'exports') { loadExports(); loadSummaries(); }
  if (page === 'collect') { loadSocial(); loadSummaryOptions(); loadKvResults(); renderKvPlatforms(); loadSummaryEngine(); }
  if (page === 'compare') { loadCompareOptions(); }
  if (page === 'summary') { loadSummaryOptions(); loadSummaryFiles(); loadDocs(); }
  if (page === 'docs') { loadDocs(); loadDocTemplates(); loadSummaryEngine(); }
  if (page === 'settings') { loadSettings(); loadLoginStatus(); }
}

// ------------------------------------------------------------------ ① 导出
async function loadExports() {
  try {
    const data = await api('/api/exports');
    STATE.exports = data.items.filter((item) => !$('#skipSummarized').checked || !item.summarized);
    STATE.allExports = data.items;
    const rows = STATE.exports.map((item) => `
      <tr>
        <td><input type="checkbox" class="exportPick" value="${escapeHtml(item.relFile)}"></td>
        <td><b>${escapeHtml(item.name)}</b><div class="muted mono">${escapeHtml(item.groupId)} · ${item.kind === 'scheduled' ? '定时导出' : '手动导出'}</div></td>
        <td class="mono">${item.timeRange ? `${(item.timeRange.start || '').slice(0, 10)} ~ ${(item.timeRange.end || '').slice(0, 10)}` : '—'}</td>
        <td>${item.messages ?? '—'}</td>
        <td>${item.sizeMB} MB</td>
        <td class="mono">${escapeHtml(item.exportedAt || item.mtime.slice(0, 16))}</td>
        <td>${item.summarized ? '<span class="badge ok">已汇总</span>' : '<span class="badge">未汇总</span>'}</td>
        <td>
          <button class="btn small" data-digest="${escapeHtml(item.relFile)}">汇总</button>
          ${item.summarized ? `<button class="btn small" data-open="${escapeHtml(item.summaryDir)}">打开产物</button>` : ''}
        </td>
      </tr>`).join('');
    const hiddenCount = data.items.length - STATE.exports.length;    const hiddenHint = hiddenCount > 0
      ? `已扫描到 <b>${data.items.length}</b> 条记录，其中 <b>${hiddenCount}</b> 条被上面的「隐藏已汇总」隐藏了（取消勾选即可看到）。`
      : '';
    $('#exportRows').innerHTML = rows || `<tr><td colspan="8" class="empty">${
      data.items.length
        ? hiddenHint
        : '这个目录里没有找到导出文件。检查「⑥ 设置 → 聊天记录读取位置」是否指向 QCE 实际导出的目录，然后点上面「扫描」。'
    }</td></tr>`;
    const countBadge = $('#skipSummarizedCount');
    if (countBadge) countBadge.textContent = hiddenCount ? `（已隐藏 ${hiddenCount} 条）` : '';
    renderOneDigestOptions();
  } catch (err) {
    toast(`读取导出失败：${err.message}`, 'err');
  }
}

// ------------------------------------------------------------------ 单条聊天记录汇总（①页新区域）
/** 用「扫描到的全部聊天记录」（不受「隐藏已汇总」影响）填充下拉框 */
function renderOneDigestOptions() {
  const pick = $('#oneDigestPick');
  if (!pick) return;
  const items = STATE.allExports || [];
  const previous = pick.value;
  if (!items.length) {
    pick.innerHTML = '<option value="">（没有扫描到导出记录，点「刷新列表」或先扫描）</option>';
    renderOneDigestInfo();
    return;
  }
  pick.innerHTML = items.map((item) => {
    const range = item.timeRange ? `${(item.timeRange.start || '').slice(0, 10)}~${(item.timeRange.end || '').slice(0, 10)}` : '时间未知';
    const tag = item.kind === 'scheduled' ? '定时' : '手动';
    return `<option value="${escapeHtml(item.relFile)}">[${tag}] ${escapeHtml(item.name)} · ${range} · ${item.messages ?? '?'} 条${item.summarized ? ' · 已汇总' : ''}</option>`;
  }).join('');
  pick.value = items.some((item) => item.relFile === previous) ? previous : items[0].relFile;
  renderOneDigestInfo();
}

function currentOneDigestItem() {
  const rel = $('#oneDigestPick')?.value || '';
  return (STATE.allExports || []).find((item) => item.relFile === rel) || null;
}

function renderOneDigestInfo() {
  const info = $('#oneDigestInfo');
  if (!info) return;
  const item = currentOneDigestItem();
  const openBtn = $('#btnOneDigestOpen');
  if (!item) {
    info.textContent = '（先选择一条聊天记录）';
    if (openBtn) { openBtn.disabled = true; openBtn.dataset.open = ''; }
    return;
  }
  const range = item.timeRange ? `${(item.timeRange.start || '').slice(0, 10)} ~ ${(item.timeRange.end || '').slice(0, 10)}` : '未知';
  const parts = [
    `群号 ${item.groupId || '—'}`,
    `消息 ${item.messages ?? '—'} 条`,
    `大小 ${item.sizeMB} MB`,
    `记录内时间范围 ${range}`,
    `导出时间 ${(item.exportedAt || item.mtime || '').slice(0, 16).replace('T', ' ')}`,
    item.summarized ? `已汇总：${item.summaryDir}` : '尚未汇总',
  ];
  info.textContent = parts.join(' ｜ ');
  if (openBtn) {
    openBtn.disabled = !item.summarized;
    openBtn.dataset.open = item.summaryDir || '';
  }
}

/** 跑一次「单条聊天记录汇总」 */
async function runOneDigest() {
  const item = currentOneDigestItem();
  if (!item) { toast('请先选择一条聊天记录', 'err'); return; }
  const dateFrom = $('#oneDigestFrom').value || '';
  const dateTo = $('#oneDigestTo').value || '';
  if (dateFrom && dateTo && dateFrom > dateTo) { toast('起始日期不能晚于结束日期', 'err'); return; }
  const outDir = $('#oneDigestOut').value.trim();
  const chat = $('#oneDigestChat').value.trim();
  try {
    const info = await api('/api/exports/digest', {
      method: 'POST',
      body: {
        file: item.relFile,
        dateFrom, dateTo, chat, outDir,
        mediaCheck: $('#oneDigestMedia').checked,
      },
      label: '单条汇总',
    });
    STATE.currentJob = info.jobId;
    toast(`已开始汇总「${info.name}」→ ${info.outDir}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadSummaries() {
  try {
    const data = await api('/api/summaries');
    STATE.summaries = data.items;
    const rows = data.items.map((item) => `
      <tr>
        <td><b>${escapeHtml(item.name)}</b>${item.building ? ' <span class="badge warn">生成中</span>' : ''}</td>
        <td class="mono">${item.digests.length} 天（${item.digests.map((d) => d.replace('.md', '')).join(', ') || '—'}）</td>
        <td class="mono">${[item.files.overall ? '整体汇总' : '', item.files.p1 ? 'p1待办' : '', item.files.media ? '媒体清单' : '', item.files.normalized ? '原文' : '', item.files.aiReview ? 'AI复判' : ''].filter(Boolean).join(' · ') || '—'}</td>
        <td class="mono">${(item.mtime || '').slice(0, 16).replace('T', ' ')}</td>
        <td>
          <button class="btn small" data-open="${escapeHtml(item.relDir)}">打开</button>
          <button class="btn small" data-preview="${escapeHtml(item.relDir)}">预览</button>
          <button class="btn small" data-review="${escapeHtml(item.relDir)}">AI 复判</button>
        </td>
      </tr>`).join('');
    $('#summaryRows').innerHTML = rows || '<tr><td colspan="5" class="empty">暂无汇总</td></tr>';
  } catch (err) {
    toast(`读取汇总失败：${err.message}`, 'err');
  }
}

function fillArtifactPicker(relDir, files) {
  const pick = $('#artifactPick');
  pick.innerHTML = files.map((file) => `<option value="${escapeHtml(file)}">${escapeHtml(file)}</option>`).join('');
}

// ------------------------------------------------------------------ ② 采集
function loadPlatforms() {
  const platforms = STATE.config?.config?.collect?.platforms || ['xhs', 'zhihu', 'bili'];
  const names = { xhs: '小红书', zhihu: '知乎', bili: 'B站', dy: '抖音', wb: '微博', ks: '快手', tieba: '贴吧' };
  $('#crawlPlatform').innerHTML = platforms.map((p) => `<option value="${p}">${names[p] || p}</option>`).join('');
}

async function loadSocial() {
  try {
    const data = await api('/api/social');
    STATE.social = data.items;
    $('#socialRows').innerHTML = data.items.map((item) => `
      <tr>
        <td><b>${escapeHtml(item.name)}</b><div class="muted mono">${escapeHtml(item.relDir)}</div></td>
        <td>${item.files}</td><td>${item.records}</td>
        <td class="mono">${item.mtime.slice(0, 16).replace('T', ' ')}</td>
        <td><button class="btn small" data-open="${escapeHtml(item.relDir)}">打开</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无采集结果</td></tr>';
  } catch (err) {
    toast(`读取采集批次失败：${err.message}`, 'err');
  }
}

function renderKeywords(keywords) {
  if (!keywords?.length) {
    $('#kwResults').innerHTML = '<div class="empty">没有拿到关键词</div>';
    return;
  }
  $('#kwResults').innerHTML = `
    <div class="muted">点击关键词填入采集框（可继续编辑）：</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
      ${keywords.map((kw) => `<button class="btn small" data-kw="${escapeHtml(kw)}">${escapeHtml(kw)}</button>`).join('')}
    </div>`;
}

// ------------------------------------------------------------------ ③ 比对
async function loadCompareOptions() {
  const [summaries, social, compares] = await Promise.all([
    api('/api/summaries'), api('/api/social'), api('/api/compares'),
  ]);
  STATE.summaries = summaries.items;
  STATE.social = social.items;
  STATE.compares = compares.items;
  const opts = (items) => items.map((item) => `<option value="${escapeHtml(item.relDir)}">${escapeHtml(item.name)}</option>`).join('');
  $('#cmpQqDir').innerHTML = opts(summaries.items);
  $('#cmpSocialDir').innerHTML = opts(social.items);
  $('#cmpResultDir').innerHTML = opts(compares.items);
  $('#compareRows').innerHTML = compares.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td class="mono">${[item.hasMd ? 'compare.md' : '', item.hasJson ? 'compare.json' : ''].filter(Boolean).join(' · ')}</td>
      <td><button class="btn small" data-open="${escapeHtml(item.relDir)}">打开</button></td>
    </tr>`).join('') || '<tr><td colspan="3" class="empty">暂无比对结果</td></tr>';
}

function renderVerdicts(result) {
  const counts = result.counts || {};
  toast(`AI 判定完成：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ')}`, 'ok');
  if (result.md) loadArtifact(result.md);
}

function renderClassifyResult(result) {
  toast(`AI 复判完成：复判 ${result.reviewed} 条，修改 ${result.changed} 条`, 'ok');
  if (result.outFile) loadArtifact(result.outFile);
}

// ------------------------------------------------------------------ ④ 总结
async function loadSummaryOptions() {
  const [summaries, compares] = await Promise.all([api('/api/summaries'), api('/api/compares')]);
  STATE.summaries = summaries.items;
  const opts = (items, emptyLabel) => (items.length ? '' : `<option value="">${emptyLabel}</option>`)
    + items.map((item) => `<option value="${escapeHtml(item.relDir)}">${escapeHtml(item.name)}</option>`).join('');
  $('#sumSummaryDir').innerHTML = opts(summaries.items, '（暂无汇总）');
  $('#sumCompareDir').innerHTML = `<option value="">（不使用比对结果）</option>` + opts(compares.items, '');
  $('#kwSummaryDir').innerHTML = opts(summaries.items, '（暂无汇总）');
  await refreshEngines();
}

async function refreshEngines() {
  try {
    const status = await api('/api/status');
    $('#dshEngineState').innerHTML = `DSH 状态：${status.dsh.running ? '<span class="badge ok">运行中</span>' : '<span class="badge warn">未运行</span>'} 端口 ${status.dsh.port}`;
  } catch { /* ignore */ }
  try {
    const active = STATE.config?.config?.ai?.providers?.find((p) => p.id === STATE.config.config.ai.activeProviderId);
    const ready = active && STATE.secretState[active.id];
    $('#apiEngineState').innerHTML = active
      ? `当前服务：<b>${escapeHtml(active.name)}</b> / ${escapeHtml(active.defaultModel || '未指定模型')} ${ready || STATE.presets.find((p) => p.id === active.presetId)?.noKey ? '<span class="badge ok">可用</span>' : '<span class="badge warn">缺少 Key</span>'}`
      : '未配置服务，请到「设置」页添加';
  } catch { /* ignore */ }
}

async function loadSummaryFiles() {
  try {
    const items = await api('/api/summary-files');
    STATE.summaryFiles = items.items || [];
    $('#summaryFileRows').innerHTML = STATE.summaryFiles.map((item) => `
      <tr>
        <td><b>${escapeHtml(item.name)}</b><div class="muted">${item.sizeKB} KB · ${item.mtime.slice(0, 16).replace('T', ' ')}</div></td>
        <td>
          <button class="btn small" data-file="${escapeHtml(item.relFile)}">查看</button>
          <button class="btn small" data-openfile="${escapeHtml(item.relFile)}">打开位置</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="2" class="empty">暂无总结文件</td></tr>';
  } catch (err) {
    toast(`读取总结列表失败：${err.message}`, 'err');
  }
}

// ------------------------------------------------------------------ ⑤ 设置
async function loadSettings() {
  const data = await api('/api/config');
  STATE.config = data;
  STATE.presets = data.presets;
  STATE.secretState = data.secretState;
  const cfg = data.config;
  $('#setProjectRoot').value = data.projectRoot;
  $('#setPort').value = cfg.server.port;
  $('#setDshPort').value = cfg.startup.dshPort;
  $('#setCdpPort').value = cfg.startup.cdpPort;
  $('#setAutoEdge').checked = cfg.startup.autoStartEdge;
  $('#setAutoDsh').checked = cfg.startup.autoStartDsh;
  $('#setOpenBrowser').checked = cfg.startup.openBrowser;
  $('#setConfirmSend').checked = cfg.ai.confirmBeforeSend;
  $('#setMaxChars').value = cfg.ai.maxCharsPerCall;
  $('#setClassifyMode').value = cfg.classify.mode;
  $('#setClassifyBatch').value = cfg.classify.batchSize;
  $('#setDefaultLimit').value = cfg.collect.defaultLimit;
  $('#setDefaultComments').value = cfg.collect.defaultComments;
  $('#setEngine').value = cfg.summarize.engine;
  $('#stepKeywords').value = cfg.ai.perStep?.keywords || '';
  $('#stepClassify').value = cfg.ai.perStep?.classify || '';
  $('#stepCompare').value = cfg.ai.perStep?.compare || '';
  $('#stepSummary').value = cfg.ai.perStep?.summary || '';

  const providers = cfg.ai.providers || [];
  $('#setActiveProvider').innerHTML = providers.length
    ? providers.map((p) => `<option value="${p.id}" ${p.id === cfg.ai.activeProviderId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">（尚未配置）</option>';
  $('#providerRows').innerHTML = providers.map((p) => `
    <tr>
      <td><b>${escapeHtml(p.name)}</b><div class="muted mono">${escapeHtml(p.id)}</div></td>
      <td>${p.format === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</td>
      <td class="mono">${escapeHtml(p.baseUrl)}</td>
      <td class="mono">${escapeHtml(p.defaultModel || (p.models || [])[0] || '—')}</td>
      <td>${STATE.secretState[p.id] ? '<span class="badge ok">已配置</span>' : '<span class="badge warn">未配置</span>'}</td>
      <td>
        <button class="btn small" data-edit="${p.id}">编辑</button>
        <button class="btn small" data-models="${p.id}">拉取模型</button>
        <button class="btn small danger" data-del="${p.id}">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">尚未配置</td></tr>';

  renderPriceBooks(cfg);
  await loadDirSettings();
}

function renderPriceBooks(cfg) {
  const books = cfg.ai.priceBooks || [];
  const active = cfg.ai.activePriceBook || books[0]?.name || '';
  $('#priceBookEditor').innerHTML = books.length ? books.map((book) => `
    <div class="card" style="margin:8px 0">
      <div class="row">
        <div class="field grow"><label>名称</label><input type="text" data-book-name="${escapeHtml(book.name)}" value="${escapeHtml(book.name)}"></div>
        <div class="field"><label>币种</label><input type="text" value="${escapeHtml(book.currency || 'CNY')}" data-book-cur="${escapeHtml(book.name)}"></div>
        <button class="btn small" data-book-active="${escapeHtml(book.name)}" ${book.name === active ? 'disabled' : ''}>${book.name === active ? '当前使用' : '设为当前'}</button>
        <button class="btn small" data-book-add="${escapeHtml(book.name)}">加一行</button>
        <button class="btn small danger" data-book-del="${escapeHtml(book.name)}">删除</button>
      </div>
      <table style="margin-top:8px">
        <thead><tr><th>模型名</th><th>输入（元/百万 token）</th><th>输出</th><th></th></tr></thead>
        <tbody>
        ${Object.entries(book.models || {}).map(([model, price]) => `
          <tr>
            <td class="mono">${escapeHtml(model)}</td>
            <td><input type="number" step="0.01" value="${price.in ?? ''}" data-price-in="${escapeHtml(book.name)}|${escapeHtml(model)}"></td>
            <td><input type="number" step="0.01" value="${price.out ?? ''}" data-price-out="${escapeHtml(book.name)}|${escapeHtml(model)}"></td>
            <td><button class="btn small danger" data-price-del="${escapeHtml(book.name)}|${escapeHtml(model)}">删</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="row" style="margin-top:8px">
        <input type="text" id="newModel_${escapeHtml(book.name)}" placeholder="新增模型名，如 deepseek-chat">
      </div>
      <button class="btn small primary" data-book-save="${escapeHtml(book.name)}" style="margin-top:8px">保存价格表</button>
    </div>`).join('') : '<div class="empty">还没有价格表，先「新建价格表」</div>';
}

/**
 * 绑定 AI 服务弹窗的交互（新增与编辑共用）。
 * 两个关键点：
 *  1) 「默认模型」提供下拉选项（来自模型名输入框），避免手打出一个服务商根本不存在的模型；
 *  2) **Key 留空 = 不修改**：只有真正填了才发送 apiKey；要清空必须勾「清除已保存的 Key」。
 *     此前把空串也发上去，后端按"清空"处理 → 改完模型界面就显示"未配置"（实测踩过）。
 */
function bindProviderForm({ provider = null } = {}) {
  const isEdit = Boolean(provider);
  const refreshDefaultPick = () => {
    const models = $('#pfModels').value.split(',').map((s) => s.trim()).filter(Boolean);
    const current = $('#pfDefault').value.trim();
    const pick = $('#pfDefaultPick');
    if (!pick) return;
    pick.innerHTML = '<option value="">（不指定 → 用列表第一个）</option>'
      + models.map((m) => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  };
  $('#pfModels').oninput = refreshDefaultPick;
  $('#pfDefaultPick').onchange = () => {
    const value = $('#pfDefaultPick').value;
    if (value) $('#pfDefault').value = value;
  };
  refreshDefaultPick();

  $('#pfCancel').onclick = closeModal;
  $('#pfSave').onclick = async () => {
    const models = $('#pfModels').value.split(',').map((s) => s.trim()).filter(Boolean);
    const defaultModel = $('#pfDefault').value.trim();
    if (defaultModel && models.length && !models.includes(defaultModel)) {
      toast(`默认模型「${defaultModel}」不在模型列表里，调用时会报模型不存在（可点表格里的「拉取模型」补全）`, 'err');
    }
    const payload = {
      provider: {
        ...(isEdit ? { id: provider.id } : {}),
        presetId: $('#pfPreset').value,
        name: $('#pfName').value || '未命名服务',
        baseUrl: $('#pfBase').value,
        format: $('#pfFormat').value,
        models,
        defaultModel,
      },
    };
    const typedKey = $('#pfKey')?.value || '';
    if (typedKey.trim()) payload.apiKey = typedKey.trim();
    else if ($('#pfClearKey')?.checked) payload.clearApiKey = true;

    try {
      const data = await api('/api/provider', { method: 'POST', body: payload });
      closeModal();
      const keyState = data.secretState ? '' : '（当前没有可用 Key，需要填一个）';
      toast(`已保存服务，共 ${data.providers.length} 个${keyState}`, 'ok');
      await loadSettings(); await refreshEngines();
    } catch (err) { toast(err.message, 'err'); }
  };
  return { refreshDefaultPick };
}

/** AI 服务弹窗的表单 HTML（新增 / 编辑共用） */
function providerForm(provider = null, apiKeyMask = '') {
  const isNew = !provider;
  return `
    <h3>${isNew ? '新增 AI 服务' : `编辑：${escapeHtml(provider.name)}`}</h3>
    <div class="row">
      <div class="field grow">
        <label>预设</label>
        <select id="pfPreset">
          ${STATE.presets.map((p) => `<option value="${p.id}" ${provider?.presetId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field grow"><label>显示名称</label><input type="text" id="pfName" value="${escapeHtml(provider?.name || '')}"></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="field grow"><label>Base URL</label><input type="text" id="pfBase" value="${escapeHtml(provider?.baseUrl || '')}" placeholder="https://api.deepseek.com/v1"></div>
      <div class="field"><label>接口格式</label>
        <select id="pfFormat">
          <option value="openai" ${provider?.format !== 'anthropic' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="anthropic" ${provider?.format === 'anthropic' ? 'selected' : ''}>Anthropic 原生</option>
        </select>
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="field grow"><label>模型名（逗号分隔，可点表格里的「拉取模型」自动补全）</label><input type="text" id="pfModels" value="${escapeHtml((provider?.models || []).join(', '))}"></div>
      <div class="field"><label>默认模型</label><input type="text" id="pfDefault" value="${escapeHtml(provider?.defaultModel || '')}"></div>
      <div class="field"><label>从已填模型里选</label><select id="pfDefaultPick"></select></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="field grow"><label>API Key ${apiKeyMask ? '（留空表示不修改）' : ''}</label><input type="password" id="pfKey" placeholder="${apiKeyMask || 'sk-...'}"></div>
      ${apiKeyMask ? '<label class="check"><input type="checkbox" id="pfClearKey"> 清除已保存的 Key</label>' : ''}
    </div>
    <div class="muted" style="margin-top:6px">
      默认模型必须能在上面的模型名里找到，否则调用会报「模型不存在」。保存后可用表格里的「拉取模型」从服务商拉全列表（会自动写入并修正默认模型）。
    </div>
    <div class="actions">
      <button class="btn" id="pfCancel">取消</button>
      <button class="btn primary" id="pfSave">保存</button>
    </div>`;
}

// ------------------------------------------------------------------ 一键流程
function renderFlowProgress(progress) {
  const map = {
    'ai-call': '正在调用 AI…',
    'ai-done': 'AI 调用完成',
    classify: `复判第 ${progress.batch}/${progress.total} 批`,
    verdict: `判定第 ${progress.batch}/${progress.total} 批`,
    day: `深度模式：第 ${progress.index}/${progress.total} 天（${progress.day}）`,
  };
  const text = map[progress.phase] || JSON.stringify(progress);
  $('#flowHint').textContent = `进度：${text}`;
  if (progress.total && progress.batch) {
    $('#flowProgressWrap').style.display = 'block';
    $('#flowProgress').style.width = `${Math.round((progress.batch / progress.total) * 100)}%`;
  }
}

async function startFlow() {
  const steps = [];
  if ($('#flowDigest').checked) steps.push('digest');
  if ($('#flowClassify').checked) steps.push('classify');
  if ($('#flowKeywords').checked) steps.push('keywords');
  if ($('#flowCrawl').checked) steps.push('crawl');
  if ($('#flowCompare').checked) steps.push('compare');
  if ($('#flowSummary').checked) steps.push('summary');
  if (!steps.length) { toast('请至少勾选一个步骤', 'err'); return; }
  STATE.flow = { steps, running: true, done: [], failedAt: '' };
  $('#btnCancelFlow').disabled = false;
  $('#flowProgressWrap').style.display = 'block';
  await runFlowSteps();
}

async function runFlowSteps() {
  const { steps } = STATE.flow;
  try {
    for (const step of steps) {
      if (STATE.flow.done.includes(step)) continue;
      $('#flowHint').textContent = `正在执行：${step}`;
      await runOneStep(step);
      STATE.flow.done.push(step);
      $('#flowProgress').style.width = `${Math.round((STATE.flow.done.length / steps.length) * 100)}%`;
      STATE.flow.running = true;
    }
    toast('一键流程全部完成', 'ok');
    $('#flowHint').textContent = '一键流程已完成。';
  } catch (err) {
    STATE.flow.failedAt = err.step || 'unknown';
    $('#flowHint').textContent = `在「${err.step}」步骤失败：${err.message}。可修正后点「从断点继续」。`;
    toast(`流程中断：${err.message}`, 'err');
  } finally {
    STATE.flow.running = false;
    $('#btnCancelFlow').disabled = true;
    loadExports(); loadSummaries(); loadSocial(); loadCompareOptions();
  }
}

function waitJobViaApi(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const handle = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.jobId !== jobId) return;
      if (data.type === 'progress') onProgress?.(data.progress, data.jobId);
      if (data.type === 'log') appendLog(jobId, data.line, data.stream);
      if (data.type === 'status') {
        source.removeEventListener('message', handle);
        if (data.status === 'done') resolve(data);
        else reject(Object.assign(new Error(data.error || data.status), { step: onProgress?.step }));
      }
    };
    const source = new EventSource('/api/events');
    source.addEventListener('message', handle);
  });
}

async function runOneStep(step) {
  const pick = $('#exportRows').querySelector('input.exportPick:checked')
    || $('#exportRows').querySelector('input.exportPick');
  const file = pick?.value || STATE.exports[0]?.relFile;
  if (step === 'digest') {
    if (!file) throw Object.assign(new Error('没有可用的导出文件'), { step });
    const info = await api('/api/exports/digest', { method: 'POST', body: { file } });
    STATE.currentJob = info.jobId;
    await waitJobViaApi(info.jobId, (p) => renderFlowProgress(p || {}));
    STATE.flow.summaryDir = info.outDir;
    return info;
  }
  if (step === 'classify') {
    const dir = STATE.flow.summaryDir || $('#sumSummaryDir').value;
    if (!dir) throw Object.assign(new Error('还没有群聊汇总'), { step });
    const info = await api('/api/summarize/classify', { method: 'POST', body: { summaryDir: dir } });
    STATE.currentJob = info.jobId;
    await waitJobViaApi(info.jobId, (p) => renderFlowProgress(p || {}));
    return info;
  }
  if (step === 'keywords') {
    const dir = STATE.flow.summaryDir || $('#sumSummaryDir').value;
    if (!dir) throw Object.assign(new Error('还没有群聊汇总'), { step });
    const info = await api('/api/collect/keywords', { method: 'POST', body: { summaryDir: dir } });
    STATE.currentJob = info.jobId;
    const done = await waitJobViaApi(info.jobId, (p) => renderFlowProgress(p || {}));
    const kws = done.result?.keywords || [];
    renderKeywords(kws);
    STATE.flow.keywords = kws.map((k) => k).join(', ') || $('#crawlKeywords').value;
    return done;
  }
  if (step === 'crawl') {
    const keywords = STATE.flow.keywords || $('#crawlKeywords').value;
    if (!keywords) throw Object.assign(new Error('没有关键词，请先填关键词或跳过该步骤'), { step });
    const platform = $('#crawlPlatform').value || 'xhs';
    const info = await api('/api/collect/crawl', {
      method: 'POST',
      body: { platform, mode: 'search', keywords, limit: Number($('#crawlLimit').value), commentsPerItem: Number($('#crawlComments').value), noComments: $('#crawlNoComments').checked },
    });
    STATE.currentJob = info.jobId;
    await waitJobViaApi(info.jobId, (p) => renderFlowProgress(p || {}));
    STATE.flow.socialDir = info.outDir;
    loadSocial();
    return info;
  }
  if (step === 'compare') {
    const qqDir = STATE.flow.summaryDir || $('#sumSummaryDir').value;
    const socialDir = STATE.flow.socialDir || $('#cmpSocialDir').value;
    if (!qqDir || !socialDir) throw Object.assign(new Error('需要同时有群聊汇总与采集批次'), { step });
    const info = await api('/api/compare/run', { method: 'POST', body: { qqDir, socialDir } });
    STATE.currentJob = info.jobId;
    await waitJobViaApi(info.jobId, (p) => renderFlowProgress(p || {}));
    STATE.flow.compareDir = info.outDir;
    loadCompareOptions();
    return info;
  }
  if (step === 'summary') {
    const summaryDir = STATE.flow.summaryDir || $('#sumSummaryDir').value;
    if (!summaryDir) throw Object.assign(new Error('还没有群聊汇总'), { step });
    const engine = $('#flowEngine').value;
    const info = await api('/api/summary/generate', {
      method: 'POST',
      body: {
        summaryDir,
        compareDir: STATE.flow.compareDir || $('#sumCompareDir').value || '',
        engine,
        deep: $('#sumDeep').checked,
        style: $('#sumStyle').value,
        focus: $('#sumFocus').value,
      },
    });
    STATE.currentJob = info.jobId;
    await waitJobViaApi(info.jobId, (p) => renderFlowProgress(p || {}));
    if (info.outFile) loadArtifact(info.outFile);
    return info;
  }
  throw Object.assign(new Error(`未知步骤 ${step}`), { step });
}

// ------------------------------------------------------------------ 通用：查看产物
async function loadArtifact(relPath, target = '#artifactPreview') {
  try {
    const data = await api(`/api/artifact?path=${encodeURIComponent(relPath)}`);
    const box = $(target) || $('#artifactPreview');
    if (box) {
      box.textContent = `${data.path}${data.truncated ? '（已截断）' : ''}\n\n${data.text}`;
    }
    return data;
  } catch (err) {
    toast(`读取失败：${err.message}`, 'err');
    return null;
  }
}

// ------------------------------------------------------------------ 事件绑定
function bindNav() {
  $$('#nav button').forEach((btn) => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
}

function bindExports() {
  $('#btnScanExports').onclick = () => { loadExports(); };
  $('#skipSummarized').onchange = () => { loadExports(); };

  // —— 单条聊天记录汇总 ——
  $('#btnOneDigestReload').onclick = async () => { await loadExports(); toast('已刷新聊天记录列表'); };
  $('#oneDigestPick').onchange = () => renderOneDigestInfo();
  $('#btnOneDigestFillRange').onclick = () => {
    const item = currentOneDigestItem();
    if (!item?.timeRange) { toast('这条记录没有可用的时间范围', 'err'); return; }
    $('#oneDigestFrom').value = (item.timeRange.start || '').slice(0, 10);
    $('#oneDigestTo').value = (item.timeRange.end || '').slice(0, 10);
    toast('已按该记录的时间范围填充');
  };
  $('#btnOneDigestRun').onclick = runOneDigest;
  $('#btnOneDigestOpen').onclick = async () => {
    const open = $('#btnOneDigestOpen').dataset.open;
    if (open) await openTarget(open, '汇总产物');
    else toast('这条记录还没有汇总产物', 'err');
  };
  $('#checkAllExports').onchange = (event) => {
    $$('.exportPick').forEach((box) => { box.checked = event.target.checked; });
  };
  $('#exportRows').addEventListener('click', async (event) => {
    const digest = event.target.dataset.digest;
    const open = event.target.dataset.open;
    if (digest) {
      try {
        const info = await api('/api/exports/digest', { method: 'POST', body: { file: digest } });
        STATE.currentJob = info.jobId;
        toast(`已开始汇总：${info.outDir}`);
      } catch (err) {
        toast(`启动失败：${err.message}`, 'err');
      }
    }
    if (open) await openTarget(open);
  });
  $('#btnDigestSelected').onclick = async () => {
    const files = $$('.exportPick:checked').map((box) => box.value);
    if (!files.length) { toast('请先勾选导出记录', 'err'); return; }
    for (const file of files) {
      try {
        const info = await api('/api/exports/digest', { method: 'POST', body: { file } });
        STATE.currentJob = info.jobId;
        toast(`已开始汇总：${info.outDir}`);
      } catch (err) {
        toast(`启动失败：${err.message}`, 'err');
      }
    }
  };
  $('#btnArchiveSelected').onclick = async () => {
    const files = $$('.exportPick:checked').map((box) => box.value);
    if (!files.length) { toast('请先勾选导出记录', 'err'); return; }
    if (!await confirmModal('归档选中项', `<p>将把 ${files.length} 个导出文件移动到 <span class="mono">data/qq-chat-exporter/archive/</span>：</p><pre class="preview">${files.map(escapeHtml).join('\n')}</pre>`, '归档')) return;
    try {
      const data = await api('/api/exports/archive', { method: 'POST', body: { files } });
      toast(`已归档 ${data.moved.length} 个文件`, 'ok');
      loadExports();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnDeleteSelected').onclick = async () => {
    const files = $$('.exportPick:checked').map((box) => box.value);
    if (!files.length) { toast('请先勾选导出记录', 'err'); return; }
    if (!await confirmModal('删除选中项', `<p>将把 ${files.length} 个导出文件移到<b>回收站</b>（可恢复）：</p><pre class="preview">${files.map(escapeHtml).join('\n')}</pre>`, '移到回收站')) return;
    try {
      const data = await api('/api/exports/delete', { method: 'POST', body: { files } });
      toast(`已移入回收站 ${data.deleted.length} 个文件`, 'ok');
      loadExports();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#summaryRows').addEventListener('click', async (event) => {
    const open = event.target.dataset.open;
    const review = event.target.dataset.review;
    const preview = event.target.dataset.preview;
    // 打开产物/目录：成功后弹提示，避免"点了没反应"的错觉（资源管理器可能在浏览器后面）
    if (open) await openTarget(open, '汇总产物');
    if (review) {
      try {
        const info = await api('/api/summarize/classify', { method: 'POST', body: { summaryDir: review } });
        STATE.currentJob = info.jobId;
        toast('已开始 AI 复判');
      } catch (err) { toast(err.message, 'err'); }
    }
    if (preview) {
      const dir = STATE.summaries.find((item) => item.relDir === preview);
      if (dir) {
        const files = [
          `${preview}/overall.md`,
          `${preview}/p1-todo.md`,
          `${preview}/media-index.md`,
          `${preview}/_report.md`,
          ...dir.digests.map((d) => `${preview}/digest/${d}`),
        ];
        $('#artifactPick').innerHTML = files
          .map((file) => `<option value="${escapeHtml(file)}">${escapeHtml(file.replace(`${preview}/`, ''))}</option>`)
          .join('');
        await loadArtifact($('#artifactPick').value);
      }
    }
  });
  $('#btnLoadArtifact').onclick = () => { loadArtifact($('#artifactPick').value); };
}

function bindCollect() {
  $('#crawlMode').onchange = () => {
    const mode = $('#crawlMode').value;
    $('#fieldKeywords').style.display = mode === 'search' ? '' : 'none';
    $('#fieldSpecified').style.display = mode === 'detail' ? '' : 'none';
    $('#fieldCreator').style.display = mode === 'creator' ? '' : 'none';
  };
  $('#crawlKeywords').addEventListener('input', syncKvKeywords);
  $('#kvKeywords').addEventListener('input', syncKvKeywords);

  // —— 关键词验证
  $('#btnKvExtract').onclick = async () => {
    try {
      const info = await api('/api/keywords/extract', {
        method: 'POST',
        body: {
          summaryDir: $('#kvSummaryDir').value,
          top: Number($('#kvTop').value),
          minCount: Number($('#kvMinCount').value),
          onlyDomain: $('#kvOnlyDomain').checked,
        },
        label: '提取关键词',
      });
      STATE.currentJob = info.jobId;
      STATE.pendingKeywordJob = info.jobId;
      toast('已开始提取候选关键词（本地 jieba，不消耗 AI 额度）');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#kvResults').addEventListener('click', async (event) => {
    const file = event.target.dataset.kvfile;
    const open = event.target.dataset.kvopen;
    if (file) await loadArtifact(file, '#kvPreview');
    if (open) await openTarget(open, '验证批次');
  });
  $('#btnKvRun').onclick = async () => {
    const manual = $('#kvKeywords').value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
    const keywords = [...new Set([...KV.selected, ...manual])];
    if (!keywords.length) { toast('请先选关键词或手动填写', 'err'); return; }
    if (!KV.platforms.size) { toast('请至少选择一个平台', 'err'); return; }
    const compareMode = $('#kvCompareMode').value;
    const engine = $('#kvEngine').value;
    if (compareMode === 'with-qq' && !$('#kvSummaryDir').value) {
      if (!await confirmModal('没有选择群聊汇总', '<p>「跨平台互比 + 群聊对照」需要一份群聊汇总作为左侧材料。现在没选，本次将只做跨平台互比。</p>', '继续')) return;
    }
    try {
      const info = await api('/api/keywords/verify', {
        method: 'POST',
        body: {
          keywords,
          platforms: [...KV.platforms],
          summaryDir: $('#kvSummaryDir').value,
          limit: Number($('#kvLimit').value),
          commentsPerItem: Number($('#kvComments').value),
          useAiVerdict: $('#kvAiVerdict').checked,
          compareMode,
          engine,
        },
        label: '关键词验证',
      });
      STATE.currentJob = info.jobId;
      $('#kvPreview').textContent = '验证进行中，日志区可以看到每个关键词的采集、跨平台互比与汇总进度…';
      toast(`已开始验证 ${keywords.length} 个关键词 × ${KV.platforms.size} 个平台（${compareMode === 'with-qq' ? '含群聊对照' : '纯社媒跨平台互比'}）`);
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#btnCrawl').onclick = async () => {
    const mode = $('#crawlMode').value;
    try {
      const info = await api('/api/collect/crawl', {
        method: 'POST',
        body: {
          platform: $('#crawlPlatform').value,
          mode,
          keywords: $('#crawlKeywords').value,
          specifiedId: $('#crawlSpecified').value,
          creatorId: $('#crawlCreator').value,
          limit: Number($('#crawlLimit').value),
          commentsPerItem: Number($('#crawlComments').value),
          noComments: $('#crawlNoComments').checked,
        },
      });
      STATE.currentJob = info.jobId;
      toast(`已开始采集：${info.outDir}`);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnCrawlPreview').onclick = () => {
    modal(`<h3>将执行的采集命令</h3><pre class="preview">${escapeHtml(commandPreview())}</pre>
      <div class="actions"><button class="btn primary" onclick="document.getElementById('modalBackdrop').classList.remove('show')">知道了</button></div>`);
  };
  $('#btnKeywordSuggest').onclick = async () => {
    try {
      const info = await api('/api/collect/keywords', {
        method: 'POST',
        body: { summaryDir: $('#kwSummaryDir').value, count: Number($('#kwCount').value) },
      });
      STATE.currentJob = info.jobId;
      toast('已开始推荐关键词');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#kwResults').addEventListener('click', (event) => {
    const kw = event.target.dataset.kw;
    if (!kw) return;
    const box = $('#crawlKeywords');
    box.value = box.value ? `${box.value}, ${kw}` : kw;
    box.focus();
  });
  $('#socialRows').addEventListener('click', async (event) => {
    const open = event.target.dataset.open;
    if (open) await openTarget(open);
  });
}

function commandPreview() {
  const mode = $('#crawlMode').value;
  const target = mode === 'search' ? `--keywords "${$('#crawlKeywords').value}"`
    : mode === 'detail' ? `--specified-id "${$('#crawlSpecified').value}"` : `--creator-id "${$('#crawlCreator').value}"`;
  return `python .agents/skills/social-crawl/scripts/crawl.py \\\n  --platform ${$('#crawlPlatform').value} --type ${mode} ${target} \\\n`
    + `  --limit ${$('#crawlLimit').value} --comments-per-item ${$('#crawlComments').value} \\\n`
    + `  --browser edge --out "artifacts/social/<日期>-${$('#crawlPlatform').value}-<关键词>"`;
}

function bindCompare() {
  $('#btnCompareRun').onclick = async () => {
    try {
      const info = await api('/api/compare/run', {
        method: 'POST',
        body: {
          qqDir: $('#cmpQqDir').value,
          socialDir: $('#cmpSocialDir').value,
          top: Number($('#cmpTop').value),
          minScore: Number($('#cmpMinScore').value),
        },
      });
      STATE.currentJob = info.jobId;
      toast(`已开始比对：${info.outDir}`);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnVerdict').onclick = async () => {
    try {
      const info = await api('/api/compare/verdict', {
        method: 'POST',
        body: { compareDir: $('#cmpResultDir').value, limit: Number($('#verdictLimit').value) },
      });
      STATE.currentJob = info.jobId;
      toast('已开始 AI 判定');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnLoadCompare').onclick = () => { loadArtifact(`${$('#cmpResultDir').value}/compare.md`); };
  $('#compareRows').addEventListener('click', async (event) => {
    const open = event.target.dataset.open;
    if (open) await openTarget(open);
  });
}

function bindSummary() {
  $('#btnSummaryDsh').onclick = () => { generateSummary('dsh'); };
  $('#btnSummaryApi').onclick = async () => {
    const body = summaryBody('api');
    try {
      const previewData = await api('/api/summary/preview', { method: 'POST', body });
      if (STATE.config?.config?.ai?.confirmBeforeSend !== false) {
        const costText = previewData.cost
          ? `${previewData.cost.amount} ${previewData.cost.currency}（按价格表「${previewData.cost.book}」）`
          : '未配置单价，仅显示 token';
        const ok = await confirmModal('确认发送给 AI？', `
          <p>服务：<b>${escapeHtml(previewData.provider)}</b> / <span class="mono">${escapeHtml(previewData.model)}</span></p>
          <ul>
            <li>发送字符数：约 ${previewData.chars}</li>
            <li>预估输入 token：约 ${previewData.tokensIn}</li>
            <li>预估费用：${costText}</li>
            <li>调用次数：${previewData.calls || 1}${previewData.days?.length ? `（按天分块 ${previewData.days.length} 块）` : ''}</li>
          </ul>
          <p class="muted">将发送：群聊汇总文本与社媒比对材料（不含原始聊天记录文件）。</p>`, '确认发送');
        if (!ok) return;
      }
      await generateSummary('api', body);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#btnSummaryPreview').onclick = async () => {
    try {
      const data = await api('/api/summary/preview', { method: 'POST', body: summaryBody('api') });
      $('#summaryPreviewBox').innerHTML = `
        <div class="card" style="margin:0">
          <div class="muted">服务：${escapeHtml(data.provider)} / ${escapeHtml(data.model)}</div>
          <div>字符数：${data.chars}</div>
          <div>预估输入 token：约 ${data.tokensIn}</div>
          <div>调用次数：${data.calls}</div>
          <div>预估费用：${data.cost ? `${data.cost.amount} ${data.cost.currency}` : '未配置单价'}</div>
          ${data.days?.length ? `<div class="muted">分块：${data.days.map((d) => `${d.day}(${d.messages}条/${d.chars}字)`).join('、')}</div>` : ''}
        </div>`;
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnSummaryPrompt').onclick = () => { generateSummary('prompt'); };
  $('#summaryFileRows').addEventListener('click', async (event) => {
    const file = event.target.dataset.file;
    const openFile = event.target.dataset.openfile;
    if (file) await loadArtifact(file);
    if (openFile) await openTarget(openFile.replace(/\/[^/]+$/, ''), '文件所在位置');
  });
}

function summaryBody(engine) {
  return {
    summaryDir: $('#sumSummaryDir').value,
    compareDir: $('#sumCompareDir').value,
    keywords: $('#sumKeywords')?.value || '',
    docBatches: [...($('#sumDocBatch')?.selectedOptions || [])].map((option) => option.value),
    engine,
    deep: $('#sumDeep').checked,
    style: $('#sumStyle').value,
    focus: $('#sumFocus').value,
  };
}

async function generateSummary(engine, presetBody = null) {
  try {
    const info = await api('/api/summary/generate', { method: 'POST', body: presetBody || summaryBody(engine) });
    STATE.currentJob = info.jobId;
    toast(`已开始生成（${engine}）`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 平台登录区：显示采集实例状态 + 各平台登录态（结果来自后端缓存） */
async function loadLoginStatus() {
  const rowsBox = $('#loginRows');
  if (!rowsBox) return;
  try {
    const data = await api('/api/login/status', { silent: true, label: '采集实例状态' });
    const crawl = data.crawl || {};
    const ui = data.ui || {};
    $('#loginInstanceInfo').innerHTML = crawl.running
      ? `端口 <b>${crawl.port}</b> ｜ 运行中（${escapeHtml(crawl.version || 'Edge')}）<div class="muted mono">${escapeHtml(crawl.profile || '')}</div>`
      : `端口 <b>${crawl.port}</b> ｜ <span class="badge warn">未运行</span>（点「启动采集实例」或直接打开登录页会自动拉起）<div class="muted mono">${escapeHtml(crawl.profile || '')}</div>`;
    const last = data.lastStatus;
    const platforms = data.platforms || [];
    rowsBox.innerHTML = platforms.map((p) => {
      const info = last?.platforms?.[p.code];
      let badge = '<span class="badge">未检测</span>';
      let reason = '';
      if (info) {
        badge = info.loggedIn ? '<span class="badge ok">已登录</span>' : '<span class="badge err">未登录</span>';
        reason = info.loggedIn ? `（${escapeHtml(info.primary || '')}）` : `（${escapeHtml(String(info.reason || '').slice(0, 40))}）`;
      }
      return `<tr>
        <td><b>${escapeHtml(p.name)}</b><div class="muted mono">${escapeHtml(p.loginUrl || '')}</div></td>
        <td>${badge} ${reason}</td>
        <td>
          <button class="btn small primary" data-loginopen="${escapeHtml(p.code)}">打开登录页</button>
          <button class="btn small" data-loginhome="${escapeHtml(p.code)}">打开首页</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="empty">没有可登录的平台</td></tr>';
    if (last) {
      const when = new Date(last.at).toLocaleString('zh-CN');
      $('#loginHint').innerHTML = `上次检测：${escapeHtml(when)}（端口 ${last.port}）｜ 采集与登录都在<b>采集实例</b>里进行，`
        + `不会占用界面窗口（界面实例端口 ${ui.port}）；采集结束后会自动关掉它打开的社媒标签页。`;
    }
  } catch (err) {
    rowsBox.innerHTML = `<tr><td colspan="3" class="empty">读取失败：${escapeHtml(err.message)}</td></tr>`;
  }
}

function bindSettings() {
  // —— 平台登录（在采集实例里进行，不动界面窗口）——
  $('#btnLoginCheck').onclick = async () => {
    try {
      const info = await api('/api/login/status', { method: 'POST', body: {}, label: '检测登录状态' });
      STATE.currentJob = info.jobId;
      toast('正在检测各平台登录状态…（结果会显示在下面的表格里）');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnCrawlEdgeStart').onclick = async () => {
    try {
      const data = await api('/api/crawl-browser/start', { method: 'POST', body: {}, label: '启动采集实例' });
      toast(data.started ? `采集实例已启动（端口 ${data.port}）` : `采集实例已在运行（端口 ${data.port}）`, 'ok');
      await loadLoginStatus();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#loginRows').addEventListener('click', async (event) => {
    const open = event.target.dataset.loginopen;
    const home = event.target.dataset.loginhome;
    const code = open || home;
    if (!code) return;
    try {
      const data = await api('/api/login/open', { method: 'POST', body: { platform: code }, label: '打开登录页' });
      toast(`已在采集实例（端口 ${data.port}）打开${data.name}${open ? '登录页' : '首页'}`
        + `${data.started ? '（实例是刚启动的）' : ''}：${open ? '扫码登录后点「检测登录状态」确认' : ''}`, 'ok');
      await loadLoginStatus();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('#setActiveProvider').onchange = async (event) => {
    try {
      await api('/api/config', { method: 'POST', body: { patch: { ai: { activeProviderId: event.target.value } } } });
      await loadSettings(); await refreshEngines(); toast('已切换当前服务', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnNewProvider').onclick = async () => {
    modal(providerForm(null), {
      onOpen: () => {
        const form = bindProviderForm({ provider: null });
        const presetSel = $('#pfPreset');
        const applyPreset = () => {
          const preset = STATE.presets.find((p) => p.id === presetSel.value);
          if (!preset) return;
          $('#pfName').value = preset.name;
          $('#pfBase').value = preset.baseUrl;
          $('#pfFormat').value = preset.format;
          $('#pfModels').value = (preset.models || []).join(', ');
          $('#pfDefault').value = (preset.models || [])[0] || '';
          form.refreshDefaultPick();
        };
        presetSel.onchange = applyPreset;
        applyPreset();
      },
    });
  };
  $('#providerRows').addEventListener('click', async (event) => {
    const edit = event.target.dataset.edit;
    const del = event.target.dataset.del;
    const models = event.target.dataset.models;
    if (edit) {
      const provider = STATE.config.config.ai.providers.find((p) => p.id === edit);
      modal(providerForm(provider, STATE.secretState[edit] ? '已配置，留空不修改' : ''), {
        onOpen: () => {
          bindProviderForm({ provider });
          $('#pfPreset').onchange = () => {
            const preset = STATE.presets.find((p) => p.id === $('#pfPreset').value);
            if (!preset) return;
            $('#pfBase').value = preset.baseUrl;
            $('#pfFormat').value = preset.format;
          };
        },
      });
    }
    if (del) {
      if (!await confirmModal('删除服务', `<p>确定删除该服务配置？其 API Key 也会一并删除。</p>`, '删除')) return;
      try {
        await api('/api/provider/delete', { method: 'POST', body: { id: del } });
        await loadSettings(); await refreshEngines(); toast('已删除', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }
    if (models) {
      try {
        const data = await api('/api/provider/models', { method: 'POST', body: { id: models }, label: '拉取模型' });
        const list = data.models || [];
        const more = list.length > 6 ? ` 等 ${list.length} 个` : '';
        let extra = '';
        if (data.defaultChanged) {
          extra = data.previous
            ? `；原默认模型「${data.previous}」不在列表里，已改为「${data.defaultModel}」`
            : `；默认模型已设为「${data.defaultModel}」`;
        }
        toast(`拉取到 ${list.length} 个模型：${list.slice(0, 6).join(', ')}${more}。已写入该服务的模型列表${extra}`, 'ok');
        await loadSettings(); await refreshEngines();
      } catch (err) { toast(`拉取失败：${err.message}`, 'err'); }
    }
  });
  $('#btnSaveAiSteps').onclick = async () => {
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          patch: {
            ai: {
              perStep: {
                keywords: $('#stepKeywords').value.trim(),
                classify: $('#stepClassify').value.trim(),
                compare: $('#stepCompare').value.trim(),
                summary: $('#stepSummary').value.trim(),
              },
              confirmBeforeSend: $('#setConfirmSend').checked,
              maxCharsPerCall: Number($('#setMaxChars').value),
            },
          },
        },
      });
      toast('已保存 AI 设置', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnSaveRuntime').onclick = async () => {
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          patch: {
            server: { port: Number($('#setPort').value) },
            startup: {
              dshPort: Number($('#setDshPort').value),
              cdpPort: Number($('#setCdpPort').value),
              autoStartEdge: $('#setAutoEdge').checked,
              autoStartDsh: $('#setAutoDsh').checked,
              openBrowser: $('#setOpenBrowser').checked,
            },
          },
        },
      });
      toast('已保存运行环境设置（端口改动需重启控制台）', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  // —— 聊天记录读取位置
  $('#btnBrowseExports').onclick = () => pickDirectory({
    title: '选择「手动导出」目录',
    startPath: $('#setExportsDir').value.trim(),
    onPick: (chosen) => { $('#setExportsDir').value = chosen; checkDir(chosen, '手动导出目录'); },
  }).catch((err) => toast(err.message, 'err'));
  $('#btnBrowseScheduled').onclick = () => pickDirectory({
    title: '选择「定时导出」目录',
    startPath: $('#setScheduledDir').value.trim(),
    onPick: (chosen) => { $('#setScheduledDir').value = chosen; checkDir(chosen, '定时导出目录'); },
  }).catch((err) => toast(err.message, 'err'));
  $('#btnCheckExports').onclick = () => { checkDir($('#setExportsDir').value.trim(), '手动导出目录'); };
  $('#btnCheckScheduled').onclick = () => { checkDir($('#setScheduledDir').value.trim(), '定时导出目录'); };
  $('#btnSaveDirs').onclick = () => saveDirSettings().catch((err) => toast(err.message, 'err'));
  $('#btnRescanExports').onclick = () => saveDirSettings({ rescan: true }).catch((err) => toast(err.message, 'err'));
  $('#btnResetDirs').onclick = async () => {
    $('#setExportsDir').value = '';
    $('#setScheduledDir').value = '';
    await saveDirSettings({ rescan: true }).catch((err) => toast(err.message, 'err'));
    toast('已恢复为项目内默认目录', 'ok');
  };
  $('#btnSaveDefaults').onclick = async () => {
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          patch: {
            classify: { mode: $('#setClassifyMode').value, batchSize: Number($('#setClassifyBatch').value) },
            collect: { defaultLimit: Number($('#setDefaultLimit').value), defaultComments: Number($('#setDefaultComments').value) },
            summarize: { engine: $('#setEngine').value },
          },
        },
      });
      toast('已保存默认值', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnAddPriceBook').onclick = async () => {
    const name = $('#priceBookName').value.trim() || `价格表 ${new Date().toLocaleDateString()}`;
    try {
      const cfg = STATE.config.config;
      const books = [...(cfg.ai.priceBooks || [])];
      if (!books.some((b) => b.name === name)) books.push({ name, currency: 'CNY', models: {} });
      await api('/api/config', { method: 'POST', body: { patch: { ai: { priceBooks: books, activePriceBook: cfg.ai.activePriceBook || name } } } });
      await loadSettings();
      toast('已新建价格表', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#priceBookEditor').addEventListener('click', async (event) => {
    const addRow = event.target.dataset.bookAdd;
    const save = event.target.dataset.bookSave;
    const del = event.target.dataset.bookDel;
    const active = event.target.dataset.bookActive;
    const priceDel = event.target.dataset.priceDel;
    const cfg = STATE.config.config;
    const books = [...(cfg.ai.priceBooks || [])];
    const find = (name) => books.find((b) => b.name === name);
    if (addRow) {
      const input = document.getElementById(`newModel_${addRow}`);
      const model = input.value.trim();
      if (!model) { toast('请先填模型名', 'err'); return; }
      const book = find(addRow);
      book.models = { ...(book.models || {}), [model]: { in: 0, out: 0 } };
      await api('/api/config', { method: 'POST', body: { patch: { ai: { priceBooks: books } } } });
      await loadSettings();
      return;
    }
    if (save) {
      const book = find(save);
      $$(`[data-price-in^="${save}|"]`).forEach((input) => {
        const model = input.dataset.priceIn.split('|')[1];
        book.models[model] = { ...(book.models[model] || {}), in: Number(input.value || 0) };
      });
      $$(`[data-price-out^="${save}|"]`).forEach((input) => {
        const model = input.dataset.priceOut.split('|')[1];
        book.models[model] = { ...(book.models[model] || {}), out: Number(input.value || 0) };
      });
      const nameInput = document.querySelector(`[data-book-name="${save}"]`);
      const curInput = document.querySelector(`[data-book-cur="${save}"]`);
      if (nameInput && nameInput.value.trim() && nameInput.value.trim() !== save) {
        book.name = nameInput.value.trim();
        if (cfg.ai.activePriceBook === save) cfg.ai.activePriceBook = book.name;
      }
      if (curInput) book.currency = curInput.value.trim() || 'CNY';
      await api('/api/config', { method: 'POST', body: { patch: { ai: { priceBooks: books, activePriceBook: cfg.ai.activePriceBook } } } });
      await loadSettings();
      toast('价格表已保存', 'ok');
      return;
    }
    if (active) {
      await api('/api/config', { method: 'POST', body: { patch: { ai: { activePriceBook: active } } } });
      await loadSettings();
      toast(`已切换价格表：${active}`, 'ok');
      return;
    }
    if (del) {
      if (!await confirmModal('删除价格表', `<p>确定删除「${escapeHtml(del)}」？</p>`, '删除')) return;
      const rest = books.filter((b) => b.name !== del);
      await api('/api/config', { method: 'POST', body: { patch: { ai: { priceBooks: rest, activePriceBook: rest[0]?.name || '' } } } });
      await loadSettings();
      return;
    }
    if (priceDel) {
      const [bookName, model] = priceDel.split('|');
      const book = find(bookName);
      delete book.models[model];
      await api('/api/config', { method: 'POST', body: { patch: { ai: { priceBooks: books } } } });
      await loadSettings();
    }
  });
}

function bindLog() {
  $('#jobPick').onchange = (event) => {
    STATE.currentJob = event.target.value;
    renderLog();
  };
  $('#btnClearLog').onclick = () => {
    STATE.jobLogs.set(STATE.currentJob, []);
    renderLog();
  };
  $('#btnCancelJob').onclick = async () => {
    if (!STATE.currentJob) return;
    try {
      await api('/api/jobs/cancel', { method: 'POST', body: { id: STATE.currentJob } });
      toast('已请求停止');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function bindTopbar() {
  $('#btnRefresh').onclick = () => {
    const active = $('#nav button.active')?.dataset.page || 'exports';
    switchPage(active);
    refreshStatus();
  };
  $('#btnOpenProject').onclick = async () => {
    const root = STATE.config?.projectRoot;
    if (root) await openTarget(root, '项目根目录');
  };
  $('#btnEnsureEdge').onclick = async () => {
    toast('正在启动 Edge 调试实例…');
    const data = await api('/api/startup/edge', { method: 'POST' }).catch((err) => ({ ok: false, reason: err.message }));
    toast(data.ok ? `Edge 就绪：${data.version || '已运行'}` : `失败：${data.reason}`, data.ok ? 'ok' : 'err');
    refreshStatus();
  };
  $('#btnEnsureDsh').onclick = async () => {
    toast('正在启动 DSH…');
    const data = await api('/api/startup/dsh', { method: 'POST' }).catch((err) => ({ ok: false, reason: err.message }));
    toast(data.ok ? `DSH 就绪：${data.url}` : `失败：${data.reason}`, data.ok ? 'ok' : 'err');
    refreshStatus();
  };
  $('#btnOpenDsh').onclick = async () => {
    const status = await api('/api/status').catch(() => null);
    if (status?.dsh?.running) await openTarget(status.dsh.url, 'DSH 界面');
    else toast('DSH 尚未运行，先点「启动 DSH」', 'err');
  };
}

/** 统一「打开路径/网址」入口：成功与失败都给可见反馈 */
async function openTarget(path, label = '') {
  try {
    const res = await api('/api/open', { method: 'POST', body: { path }, label: '打开' });
    toast(`已在资源管理器中打开${label ? `（${label}）` : ''}：${res.path || res.url}`);
    return res;
  } catch (err) {
    toast(`打开失败：${err.message}`, 'err');
    return null;
  }
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    $('#dotEdge').className = `dot ${status.edge.running ? 'ok' : 'bad'}`;
    $('#edgeText').textContent = status.edge.running ? (status.edge.version || `端口 ${status.edge.port}`) : '未运行';
    $('#dotDsh').className = `dot ${status.dsh.running ? 'ok' : 'bad'}`;
    $('#dshText').textContent = status.dsh.running ? `端口 ${status.dsh.port}` : '未运行';
  } catch { /* ignore */ }
}

/** 全局兜底：任何漏掉的失败都要让用户看见（根治"点了没反应"） */
function installGlobalErrorReporting() {
  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason?.message || String(event.reason || '未知错误');
    reportFailure('未捕获的操作', message);
  });
  window.addEventListener('error', (event) => {
    if (event.message) reportFailure('页面脚本错误', event.message);
  });
}

/** 给按钮绑定处理函数，并保证失败必可见 */
function onAction(selector, label, fn) {
  const el = typeof selector === 'string' ? $(selector) : selector;
  if (!el) {
    console.warn(`[bind] 找不到元素：${selector}`);
    return;
  }
  el.addEventListener('click', async (event) => {
    try {
      await fn(event);
    } catch (err) {
      reportFailure(label, err.message);
    }
  });
}

/** 拖动调整区域大小（侧边栏宽度 / 底部日志区高度），并记住设置 */
const LAYOUT_KEY = 'dsh-summary-layout';
const LAYOUT_DEFAULT = { sidebar: 220, bottom: 340 };

function applyLayout(sizes = {}) {
  const sidebar = Math.min(520, Math.max(150, Number(sizes.sidebar) || LAYOUT_DEFAULT.sidebar));
  const bottom = Math.min(900, Math.max(120, Number(sizes.bottom) || LAYOUT_DEFAULT.bottom));
  document.documentElement.style.setProperty('--sidebar-w', `${sidebar}px`);
  document.documentElement.style.setProperty('--bottom-h', `${bottom}px`);
  return { sidebar, bottom };
}

function loadLayout() {
  try {
    return applyLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'));
  } catch {
    return applyLayout(LAYOUT_DEFAULT);
  }
}

function saveLayout(sizes) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes));
  } catch { /* 隐私模式下可能被禁用，忽略 */ }
}

function readAppliedLayout() {
  const styles = getComputedStyle(document.documentElement);
  return {
    sidebar: Math.round(parseFloat(styles.getPropertyValue('--sidebar-w')) || LAYOUT_DEFAULT.sidebar),
    bottom: Math.round(parseFloat(styles.getPropertyValue('--bottom-h')) || LAYOUT_DEFAULT.bottom),
  };
}

function initSplitters() {
  const sizes = loadLayout();

  const drag = ({ handle, cursor, onMove, onDone }) => {
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      // 注意：setPointerCapture 之后，pointermove/pointerup 会被**重定向到 handle 自身**，
      // 因此监听必须同时挂在 handle 与 document 上（此前只挂 window，导致拖不动）。
      try {
        handle.setPointerCapture(event.pointerId);
      } catch { /* 合成事件可能不支持捕获，忽略即可 */ }
      document.body.classList.add('dragging', cursor);

      const targets = [handle, document];
      const move = (ev) => onMove(ev);
      const up = (ev) => {
        document.body.classList.remove('dragging', cursor);
        for (const target of targets) {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          target.removeEventListener('pointercancel', up);
        }
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch { /* ignore */ }
        // 持久化「当前实际生效」的尺寸。
        // 注意：这里不能用 loadLayout()——它读的是 localStorage 里的旧值，
        // 会把刚落地的拖动结果又覆盖回去（这正是之前"拖完弹回原样"的原因）。
        Object.assign(sizes, readAppliedLayout());
        saveLayout(sizes);
        if (onDone) onDone(ev);
      };
      for (const target of targets) {
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
      }
    });
    // 双击恢复默认
    handle.addEventListener('dblclick', () => {
      const next = applyLayout(LAYOUT_DEFAULT);
      Object.assign(sizes, next);
      saveLayout(sizes);
      toast('已恢复默认区域大小');
    });
  };

  const layoutEl = document.querySelector('.layout');

  drag({
    handle: $('#splitSidebar'),
    cursor: 'col',
    // 以布局左边为基准换算，避免因页面偏移产生误差
    onMove: (event) => {
      const originX = layoutEl ? layoutEl.getBoundingClientRect().left : 0;
      applyLayout({ ...sizes, sidebar: event.clientX - originX });
    },
    onDone: () => saveLayout(loadLayout()),
  });

  drag({
    handle: $('#splitLog'),
    cursor: 'row',
    onMove: (event) => applyLayout({ ...sizes, bottom: window.innerHeight - event.clientY }),
    onDone: () => saveLayout(loadLayout()),
  });
}

/** 目录选择器：浏览磁盘目录（用于配置聊天记录读取位置） */
async function pickDirectory({ title = '选择目录', startPath = '', onPick }) {
  // 起点无效时不能让选择器打不开：先探测，无效就回退到项目根
  let current = String(startPath || '').trim();
  let startWarning = '';
  if (current) {
    try {
      const probe = await api('/api/dirs/validate', { method: 'POST', body: { path: current }, silent: true });
      if (!probe?.exists) {
        startWarning = `（原路径不存在，已从项目根开始浏览：${current}）`;
        current = '';
      }
    } catch {
      current = '';
    }
  }

  let pickerError = '';
  const render = async () => {
    let data;
    try {
      data = await api(`/api/dirs/browse?path=${encodeURIComponent(current)}`, { label: '浏览目录' });
    } catch (err) {
      // 浏览失败时退回项目根再试一次，保证弹窗始终可用
      pickerError = err.message;
      if (current) {
        current = '';
        // eslint-disable-next-line no-param-reassign
        data = await api('/api/dirs/browse?path=', { label: '浏览目录' });
      } else {
        throw err;
      }
    }
    current = data.current;
    const rows = data.entries.length
      ? data.entries.map((entry) => `
          <div class="dir-row">
            <button class="btn small" data-enter="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</button>
          </div>`).join('')
      : '<div class="muted">（该目录下没有子目录）</div>';
    const shortcuts = data.shortcuts.length
      ? `<div class="muted" style="margin-top:8px">快捷入口：</div>
         <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
           ${data.shortcuts.map((s) => `<button class="btn small" data-enter="${escapeHtml(s.path)}">${escapeHtml(s.name)}</button>`).join('')}
         </div>`
      : '';
    const drives = data.drives.map((d) => `<button class="btn small" data-enter="${escapeHtml(d)}">${escapeHtml(d)}</button>`).join(' ');
    $('#dirPickerBody').innerHTML = `
      ${pickerError ? `<div class="muted" style="color:var(--warn);margin-bottom:6px">上次路径无法读取：${escapeHtml(pickerError)}</div>` : ''}
      ${startWarning ? `<div class="muted" style="color:var(--warn);margin-bottom:6px">${escapeHtml(startWarning)}</div>` : ''}
      <div class="mono" style="margin-bottom:6px;word-break:break-all">当前：${escapeHtml(current)}<br><span class="muted">（相对项目：${escapeHtml(data.rel)}）</span></div>
      <div class="row" style="margin-bottom:8px">
        <button class="btn small" id="dirUp" ${data.parent ? '' : 'disabled'}>⬆ 上一级</button>
        <button class="btn small" id="dirUse">✅ 使用这个目录</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${drives}</div>
      <div style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${rows}</div>
      ${shortcuts}`;
    $('#dirUp').onclick = () => { current = data.parent || current; render(); };
    $('#dirUse').onclick = () => { closeModal(); onPick(current); };
    $$('#dirPickerBody [data-enter]').forEach((btn) => {
      btn.onclick = () => { current = btn.dataset.enter; render(); };
    });
  };

  modal(`
    <h3>${escapeHtml(title)}</h3>
    <div id="dirPickerBody"><div class="muted">加载中…</div></div>
    <div class="actions">
      <div class="field grow" style="text-align:left">
        <label>也可直接粘贴路径</label>
        <input type="text" id="dirManual" placeholder="D:\\QQChatExporter\\exports">
      </div>
      <button class="btn" id="dirManualUse">使用该路径</button>
      <button class="btn" id="dirCancel">取消</button>
    </div>`, {
    onOpen: () => {
      $('#dirCancel').onclick = closeModal;
      $('#dirManualUse').onclick = () => {
        const value = $('#dirManual').value.trim();
        if (!value) { toast('请先填写路径', 'err'); return; }
        closeModal();
        onPick(value);
      };
    },
  });
  await render();
}

/** 校验一个目录并显示结果 */
async function checkDir(path, label) {
  try {
    const data = await api('/api/dirs/validate', { method: 'POST', body: { path }, label: '校验目录' });
    const box = $('#dirCheckResult');
    if (data.empty) {
      box.style.color = '';
      box.textContent = `${label}：留空 → 使用项目内默认目录（${data.hint}）`;
      return;
    }
    const ok = data.exists && data.readable && data.exportFiles > 0;
    box.style.color = ok ? 'var(--ok)' : 'var(--warn)';
    box.textContent = `${label}：${data.path} — ${data.hint}`;
  } catch (err) {
    $('#dirCheckResult').style.color = 'var(--err)';
    $('#dirCheckResult').textContent = `${label}：校验失败 — ${err.message}`;
  }
}

async function loadDirSettings() {
  try {
    const data = await api('/api/dirs', { label: '读取目录配置' });
    const config = STATE.config?.config || {};
    $('#setExportsDir').value = config.paths?.exportsDir || '';
    $('#setScheduledDir').value = config.paths?.scheduledExportsDir || '';
    $('#dirCurrent').innerHTML = data.dirs.map((item) =>
      `${escapeHtml(item.label)}：<span class="mono">${escapeHtml(item.dir)}</span> `
      + `${item.custom ? '<span class="badge warn">自定义</span>' : '<span class="badge">默认</span>'} `
      + `${item.exists ? `<span class="badge ok">${item.exportFiles} 个导出文件</span>` : '<span class="badge err">不存在</span>'}`,
    ).join('<br>');
  } catch (err) {
    toast(`读取目录配置失败：${err.message}`, 'err');
  }
}

async function saveDirSettings({ rescan = false } = {}) {
  const patch = {
    paths: {
      exportsDir: $('#setExportsDir').value.trim(),
      scheduledExportsDir: $('#setScheduledDir').value.trim(),
    },
  };
  await api('/api/config', { method: 'POST', body: { patch }, label: '保存目录' });
  // 本地配置缓存同步，避免下次渲染用旧值
  if (STATE.config?.config) STATE.config.config.paths = patch.paths;
  toast('读取位置已保存，正在重新扫描…');
  await loadDirSettings();
  await loadExports();
  if (rescan) toast('已按新的读取位置重新扫描导出列表', 'ok');
}

// ------------------------------------------------------------------ 关键词验证
const KV = { candidates: [], selected: new Set(), platforms: new Set(['xhs', 'zhihu']) };

function renderKvPlatforms() {
  const names = { xhs: '小红书', zhihu: '知乎', bili: 'B站', dy: '抖音', wb: '微博', ks: '快手', tieba: '贴吧' };
  const list = STATE.config?.config?.collect?.platforms || ['xhs', 'zhihu', 'bili'];
  $('#kvPlatforms').innerHTML = list.map((code) => `
    <label class="check"><input type="checkbox" data-platform="${code}" ${KV.platforms.has(code) ? 'checked' : ''}> ${names[code] || code}</label>
  `).join('');
  $$('#kvPlatforms input[data-platform]').forEach((box) => {
    box.onchange = () => {
      if (box.checked) KV.platforms.add(box.dataset.platform);
      else KV.platforms.delete(box.dataset.platform);
      syncKvKeywords();
    };
  });
}

function syncKvKeywords() {
  const manual = $('#kvKeywords').value.trim();
  // 这个元素在「关键词验证」卡片里是静态的；仍然兜一层 null，
  // 避免以后有人把它挪进动态模板又踩同一个坑（见 index.html 里的注释）。
  const info = $('#kvSelectionInfo');
  if (!info) return;
  info.textContent =
    `候选 ${KV.candidates.length} 个 ｜ 已选 ${KV.selected.size} 个 ｜ 平台 ${[...KV.platforms].join('/') || '（未选）'}`
    + (manual ? ' ｜ 输入框里还有手动填写的关键词' : '');
}

function renderKvCandidates() {
  if (!KV.candidates.length) {
    $('#kvCandidates').innerHTML = '<div class="empty">还没有候选词：选一份群聊汇总后点「提取候选关键词」</div>';
    syncKvKeywords();
    return;
  }
  $('#kvCandidates').innerHTML = `
    <div class="muted">点词即选中/取消（括号内为出现条数，<span style="color:var(--brand)">蓝色</span>=领域词）：</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
      ${KV.candidates.map((item) => `
        <button class="btn small ${KV.selected.has(item.keyword) ? 'primary' : ''}"
                data-kw="${escapeHtml(item.keyword)}"
                title="${escapeHtml((item.samples?.[0]?.text || '').slice(0, 120))}">
          ${escapeHtml(item.keyword)}<span class="muted">（${item.messages}）</span>
          ${item.domain ? '<span class="badge ok">领域</span>' : ''}
        </button>`).join('')}
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn small" id="kvSelectDomain">选中全部领域词</button>
      <button class="btn small" id="kvSelectTop">选中前 10</button>
      <button class="btn small" id="kvClear">清空选择</button>
      <button class="btn small" id="kvToInput">把已选写入输入框</button>
    </div>`;
  $$('#kvCandidates [data-kw]').forEach((btn) => {
    btn.onclick = () => {
      const word = btn.dataset.kw;
      if (KV.selected.has(word)) KV.selected.delete(word);
      else KV.selected.add(word);
      renderKvCandidates();
    };
  });
  $('#kvSelectDomain').onclick = () => {
    KV.candidates.filter((item) => item.domain).forEach((item) => KV.selected.add(item.keyword));
    renderKvCandidates();
  };
  $('#kvSelectTop').onclick = () => {
    KV.candidates.slice(0, 10).forEach((item) => KV.selected.add(item.keyword));
    renderKvCandidates();
  };
  $('#kvClear').onclick = () => { KV.selected.clear(); renderKvCandidates(); };
  $('#kvToInput').onclick = () => {
    $('#kvKeywords').value = [...KV.selected].join(', ');
    syncKvKeywords();
    toast('已把选中的关键词写入输入框');
  };
  syncKvKeywords();
}

async function loadKvResults() {
  try {
    const data = await api('/api/keywords/verify-results', { label: '验证记录' });
    STATE.kvResults = data.items;
    $('#kvResults').innerHTML = data.items.map((item) => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${item.hasReport ? '<span class="badge ok">有</span>' : '<span class="badge">无</span>'}</td>
        <td>${item.hasSummary
          ? `<span class="badge ${item.summaryEngine === 'local' ? 'warn' : 'ok'}">${item.summaryEngine === 'local' ? '本地规则' : 'AI'}</span>`
          : '<span class="badge">无</span>'}</td>
        <td class="mono">${(item.mtime || '').slice(0, 16).replace('T', ' ')}</td>
        <td>
          ${item.hasSummary ? `<button class="btn small" data-kvfile="${escapeHtml(item.summaryFile)}">汇总</button>` : ''}
          ${item.hasReport ? `<button class="btn small" data-kvfile="${escapeHtml(item.reportFile)}">报告</button>` : ''}
          <button class="btn small" data-kvopen="${escapeHtml(item.relDir)}">打开</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">还没有验证记录</td></tr>';
  } catch (err) {
    toast(`读取验证记录失败：${err.message}`, 'err');
  }
}

/** 显示当前「汇总」会用哪条引擎（本地规则 / AI），让用户点之前就知道结果形态 */
async function loadSummaryEngine() {
  try {
    const data = await api('/api/summary-engine', { silent: true, label: '汇总引擎' });
    const describe = (info) => (info.ai
      ? `AI（${escapeHtml(info.provider || '已配置')}）`
      : `本地规则汇总（${escapeHtml(info.reason || '未配置 AI 服务')}）`);
    const kw = $('#kvEngineHint');
    if (kw) kw.innerHTML = `当前汇总引擎：<b>${describe(data.keywords)}</b>。没配 AI 时也能出汇总（本地规则版），配好 AI 重新生成即自动升级。`;
    const docs = $('#docEngineHint');
    if (docs) docs.innerHTML = `当前汇总引擎：<b>${describe(data.docs)}</b>。本地规则版会做文件要点、共性主题、时间/行动项与关键数据抽取。`;
  } catch { /* 提示失败不影响主流程 */ }
}

const PLATFORM_NAMES = { xhs: '小红书', zhihu: '知乎', bili: 'B站', dy: '抖音', wb: '微博', ks: '快手', tieba: '贴吧' };

// ------------------------------------------------------------------ 文件汇总
function fmtKB(kb) {
  if (kb == null) return '—';
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 渲染「提示词模板」下拉（selectedId 为空则回到「未使用模板」） */
function renderDocTemplates(selected = '') {
  const select = $('#docTemplate');
  if (!select) return;
  const items = STATE.docTemplates || [];
  select.innerHTML = '<option value="">（未使用模板）</option>'
    + items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  const match = items.find((item) => item.id === selected || item.name === selected);
  select.value = match ? match.id : '';
}

async function loadDocTemplates() {
  try {
    const data = await api('/api/prompts/doc-summary', { silent: true, label: '提示词模板' });
    STATE.docTemplates = data.templates || [];
    renderDocTemplates($('#docTemplate')?.value || '');
  } catch { /* 模板读取失败不影响汇总 */ }
}

async function loadDocs() {
  try {
    const data = await api('/api/uploads', { label: '文件批次' });
    STATE.uploads = data.batches;
    STATE.docSummaries = data.summaries;

    const rows = [];
    for (const batch of data.batches) {
      rows.push(`
        <tr>
          <td><input type="checkbox" class="docPick" value="${escapeHtml(batch.batch)}"></td>
          <td><b>${escapeHtml(batch.batch)}</b><div class="muted">${batch.files.length} 个文件 · 共 ${fmtKB(batch.totalKB)}
            ${batch.extracted ? ` · 已提取 ${batch.extracted.ok}/${batch.extracted.total}` : ' · 未提取'}</div></td>
          <td class="mono">${fmtKB(batch.totalKB)}</td>
          <td>${batch.extracted
            ? (batch.extracted.ok === batch.extracted.total ? '<span class="badge ok">全部成功</span>' : `<span class="badge warn">${batch.extracted.ok}/${batch.extracted.total} 成功</span>`)
            : '<span class="badge">未提取</span>'}</td>
          <td>
            <button class="btn small" data-docextract="${escapeHtml(batch.batch)}">提取文本</button>
            <button class="btn small" data-docview="${escapeHtml(batch.batch)}">查看材料</button>
            <button class="btn small" data-docopen="${escapeHtml(batch.dir)}">打开</button>
          </td>
        </tr>`);
      for (const file of batch.files) {
        const meta = batch.extracted?.files?.find((item) => item.name === file.name);
        rows.push(`
          <tr>
            <td></td>
            <td class="mono" style="padding-left:22px">└ ${escapeHtml(file.name)}</td>
            <td class="mono">${fmtKB(file.sizeKB)}</td>
            <td class="mono">${meta
              ? (meta.ok
                ? `${meta.chars} 字${meta.pages ? ` · ${meta.pages} 页` : ''}${meta.scanned_likely ? ' · <span class="badge warn">可能是扫描件</span>' : ''}`
                : `<span class="badge err">${escapeHtml(String(meta.error || '').slice(0, 40))}</span>`)
              : '—'}</td>
            <td><button class="btn small danger" data-docdel="${escapeHtml(file.relPath)}">删除</button></td>
          </tr>`);
      }
    }
    $('#docRows').innerHTML = rows.join('') || '<tr><td colspan="5" class="empty">还没有上传文件</td></tr>';
    $('#docBatchPick').innerHTML = data.batches.map((batch) => `<option value="${escapeHtml(batch.batch)}">${escapeHtml(batch.batch)}（${batch.files.length} 文件）</option>`).join('')
      || '<option value="">（先上传文件）</option>';
    $('#sumDocBatch').innerHTML = data.batches.map((batch) => `<option value="${escapeHtml(batch.batch)}">${escapeHtml(batch.batch)}</option>`).join('');

    $('#docSummaryRows').innerHTML = data.summaries.map((item) => `
      <tr>
        <td><b>${escapeHtml(item.name)}</b></td>
        <td class="mono">${item.sizeKB} KB</td>
        <td class="mono">${(item.mtime || '').slice(0, 16).replace('T', ' ')}</td>
        <td><button class="btn small" data-docfile="${escapeHtml(item.relFile)}">查看</button></td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">还没有生成汇总</td></tr>';
  } catch (err) {
    toast(`读取文件批次失败：${err.message}`, 'err');
  }
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const batch = $('#docBatch').value.trim() || new Date().toISOString().slice(0, 10);
  const status = $('#docUploadStatus');
  let done = 0;
  for (const file of files) {
    status.textContent = `正在上传 ${done + 1}/${files.length}：${file.name}（${fmtKB(Math.round(file.size / 1024))}）…`;
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      // eslint-disable-next-line no-await-in-loop
      const saved = await api('/api/uploads', { method: 'POST', body: { name: file.name, base64, batch }, label: `上传 ${file.name}` });
      done += 1;
      status.textContent = `已上传 ${done}/${files.length}：${saved.name}（${fmtKB(saved.sizeKB)}）`;
    } catch (err) {
      status.textContent = `上传失败：${file.name} — ${err.message}`;
    }
  }
  status.textContent = `完成：${done}/${files.length} 个文件已保存到批次「${batch}」`;
  await loadDocs();
}

function bindDocs() {
  const input = $('#docFileInput');
  const drop = $('#docDrop');
  input.onchange = () => { uploadFiles(input.files).then(() => { input.value = ''; }); };
  drop.onclick = () => input.click();
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length) uploadFiles(files);
  });

  $('#btnDocExtract').onclick = async () => {
    const batch = $('#docBatchPick').value;
    if (!batch) { toast('请先选择批次', 'err'); return; }
    try {
      const info = await api('/api/uploads/extract', { method: 'POST', body: { batch }, label: '提取文本' });
      STATE.currentJob = info.jobId;
      toast(`已开始提取：${batch}`);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnDocPreview').onclick = async () => {
    const batch = $('#docBatchPick').value;
    const data = await api(`/api/uploads/extracted?batch=${encodeURIComponent(batch)}`, { label: '读取材料' }).catch((err) => ({ ok: false, error: err.message }));
    if (!data?.ok) { $('#docPreview').textContent = `无法读取：${data?.error || '未知错误'}`; return; }
    $('#docPreview').textContent = `${data.relRoot || batch}（${data.text.length} 字符${data.truncated ? '，已截断' : ''}）\n\n${data.text.slice(0, 8000)}`;
  };
  $('#btnDocSummary').onclick = async () => {
    const picked = $$('.docPick:checked').map((box) => box.value);
    const batches = picked.length ? picked : ($('#docBatchPick').value ? [$('#docBatchPick').value] : []);
    if (!batches.length) { toast('请先勾选要汇总的批次', 'err'); return; }
    const engine = $('#docEngine')?.value || 'auto';
    try {
      const info = await api('/api/docs/summary', {
        method: 'POST',
        body: { batches, style: $('#docStyle').value, focus: $('#docFocus').value, engine },
        label: '文件汇总',
      });
      STATE.currentJob = info.jobId;
      $('#docProgressWrap').style.display = 'block';
      toast(`已开始汇总 ${batches.length} 个批次（${engine === 'auto' ? '自动选择引擎' : engine === 'local' ? '本地规则' : 'AI'}）`);
    } catch (err) { toast(err.message, 'err'); }
  };

  // —— 提示词模板：选中即填充，另存为模板 / 删除 ——
  $('#docTemplate')?.addEventListener('change', (event) => {
    const item = (STATE.docTemplates || []).find((tpl) => tpl.id === event.target.value);
    if (!item) return;
    $('#docStyle').value = item.style || '';
    $('#docFocus').value = item.focus || '';
    toast(`已套用模板「${item.name}」`);
  });
  $('#btnDocTplSave').onclick = async () => {
    const style = $('#docStyle').value.trim();
    const focus = $('#docFocus').value.trim();
    if (!style && !focus) { toast('请先填写「风格要求」或「重点关注」', 'err'); return; }
    const current = $('#docTemplate').value;
    const existing = (STATE.docTemplates || []).find((tpl) => tpl.id === current);
    let name = existing?.name || '';
    const input = await inputModal('另存为模板', '给这套提示词起个名字（同名会覆盖）', name || (style || focus).slice(0, 12));
    if (input === null) return;
    name = String(input).trim();
    if (!name) { toast('模板名不能为空', 'err'); return; }
    try {
      const data = await api('/api/prompts/doc-summary/save', {
        method: 'POST', body: { name, style, focus, id: existing?.id || '' }, label: '保存模板',
      });
      STATE.docTemplates = data.templates || [];
      renderDocTemplates(name);
      toast(`已保存模板「${name}」`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnDocTplDelete').onclick = async () => {
    const id = $('#docTemplate').value;
    if (!id) { toast('请先在下拉里选择一个模板', 'err'); return; }
    const item = (STATE.docTemplates || []).find((tpl) => tpl.id === id);
    if (!await confirmModal('删除模板', `<p>确定删除模板「${escapeHtml(item?.name || id)}」？</p>`, '删除')) return;
    try {
      const data = await api('/api/prompts/doc-summary/delete', { method: 'POST', body: { id }, label: '删除模板' });
      STATE.docTemplates = data.templates || [];
      renderDocTemplates('');
      toast('模板已删除');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btnDocOpenRoot').onclick = () => openTarget('artifacts/uploads', '上传目录');
  $('#btnDocOpenDocs').onclick = () => openTarget('artifacts/docs', '提取结果目录');

  $('#docRows').addEventListener('click', async (event) => {
    const extract = event.target.dataset.docextract;
    const view = event.target.dataset.docview;
    const open = event.target.dataset.docopen;
    const del = event.target.dataset.docdel;
    if (extract) {
      try {
        const info = await api('/api/uploads/extract', { method: 'POST', body: { batch: extract }, label: '提取文本' });
        STATE.currentJob = info.jobId;
        toast(`已开始提取：${extract}`);
      } catch (err) { toast(err.message, 'err'); }
    }
    if (view) {
      const data = await api(`/api/uploads/extracted?batch=${encodeURIComponent(view)}`, { label: '读取材料' })
        .catch((err) => ({ ok: false, error: err.message }));
      $('#docPreview').textContent = data?.ok
        ? `${data.relRoot}（${data.text.length} 字符）\n\n${data.text.slice(0, 8000)}`
        : `无法读取：${data?.error || '未知错误'}`;
    }
    if (open) await openTarget(open, '上传目录');
    if (del) {
      if (!await confirmModal('删除文件', `<p>确定删除上传的文件？</p><pre class="preview">${escapeHtml(del)}</pre>`, '删除')) return;
      try {
        await api('/api/uploads/delete', { method: 'POST', body: { path: del }, label: '删除文件' });
        toast('已删除');
        loadDocs();
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  $('#docSummaryRows').addEventListener('click', async (event) => {
    const file = event.target.dataset.docfile;
    if (file) await loadArtifact(file, '#docPreview');
  });
}

async function bootstrapUi() {
  bindNav(); bindExports(); bindCollect(); bindCompare(); bindSummary(); bindDocs(); bindSettings(); bindLog(); bindTopbar();
  $('#btnFullRun').onclick = startFlow;
  $('#btnCancelFlow').onclick = () => {
    STATE.flow.running = false;
    toast('已请求停止当前流程（正在运行的任务可在日志区单独停止）');
  };
  $('#btnResumeFlow').onclick = () => {
    if (!STATE.flow.steps.length) { toast('还没有可继续的流程', 'err'); return; }
    STATE.flow.running = true;
    $('#btnCancelFlow').disabled = false;
    runFlowSteps();
  };
  try {
    const data = await api('/api/config');
    STATE.config = data;
    STATE.presets = data.presets;
    STATE.secretState = data.secretState;
    loadPlatforms();
    $('#setProjectRoot').value = data.projectRoot;
  } catch (err) {
    toast(`读取配置失败：${err.message}`, 'err');
  }
  initStream();
  initProcessPanel();
  initSplitters();
  installGlobalErrorReporting();
  loadDocTemplates();
  loadSummaryEngine();
  switchPage('exports');
  refreshStatus();
  setInterval(refreshStatus, 15000);
}

bootstrapUi();
