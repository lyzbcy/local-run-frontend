// 渲染层应用逻辑。

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let store = { projects: [], settings: {} };
let currentView = 'mine';

const TYPE_LABELS = {
  'static': '📦 静态',
  'vite': '⚡ Vite',
  'next': '▲ Next',
  'nuxt': '▲ Nuxt',
  'vue-cli': '🟢 Vue CLI',
  'react-scripts': '⚛️ CRA',
  'angular': '🅰️ Angular',
  'generic-dev': '🛠️ npm dev',
  'unknown': '❓ 未知'
};

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = 'toast ' + kind, 2400);
}

async function init() {
  // 版本号
  const ver = await window.api.appVersion();
  $('#version').textContent = 'v' + ver;

  await refreshStore();
  bindNav();
  bindToolbar();
  bindAddModal();
  bindAgent();
  bindUpdate();
  bindLogs();
  render();

  // 端口状态轮询
  setInterval(maybeRefreshPorts, 3000);
}

async function refreshStore() {
  store = await window.api.getStore();
}

function bindNav() {
  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
    });
  });
}

function switchView(view) {
  currentView = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.remove('active'));
  const titles = { mine: '我的项目', favorites: '收藏', recent: '最近', ports: '网关端口', agent: 'AI Agent 接入' };
  $('#viewTitle').textContent = titles[view] || '';

  if (view === 'ports') {
    $('#view-projects').classList.remove('active');
    $('#view-ports').classList.add('active');
    renderPorts();
  } else if (view === 'agent') {
    $('#view-projects').classList.remove('active');
    $('#view-agent').classList.add('active');
    fillAgentPrompt();
  } else {
    $('#view-ports').classList.remove('active');
    $('#view-agent').classList.remove('active');
    $('#view-projects').classList.add('active');
    render();
  }
  // 工具栏的添加按钮只在项目视图显示
  $('#btnAdd').style.display = ['mine', 'favorites', 'recent'].includes(view) ? '' : 'none';
}

function bindToolbar() {
  $('#btnAdd').addEventListener('click', openAddModal);
  $('#btnRefresh').addEventListener('click', async () => { await refreshStore(); render(); toast('已刷新'); });
  $('#btnPortsRefresh').addEventListener('click', () => renderPorts());
  $('#btnAbout').addEventListener('click', () => $('#aboutModal').style.display = 'flex');
  // empty state / modal close buttons
  $('#btnEmptyAdd').addEventListener('click', openAddModal);
  $('#btnAboutClose').addEventListener('click', () => $('#aboutModal').style.display = 'none');
  $('#btnUpdateLater').addEventListener('click', () => $('#updateModal').style.display = 'none');
  const lyzLink = $('#aboutLyzbcyLink');
  if (lyzLink) lyzLink.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(lyzLink.href); });
}

function getFilteredProjects() {
  let list = store.projects || [];
  if (currentView === 'favorites') list = list.filter(p => p.favorite);
  else if (currentView === 'recent') list = list.filter(p => p.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
  return list;
}

function render() {
  const list = getFilteredProjects();
  const grid = $('#projectGrid');
  const empty = $('#emptyState');

  if (!list.length) {
    grid.innerHTML = '';
    let msg = '还没有项目';
    if (currentView === 'favorites') msg = '还没有收藏的项目\n点项目卡片上的 ⭐ 收藏';
    else if (currentView === 'recent') msg = '还没有最近打开的项目';
    $('#emptyTitle') && ($('#emptyTitle').textContent = msg);
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // 当前运行中的，标记一下
  window.api.runnerStatus().then(status => {
    const runningIds = new Set(status.map(s => s.projectId));
    list.forEach(p => {
      const card = document.getElementById('card-' + p.id);
      if (card) {
        card.classList.toggle('running', runningIds.has(p.id));
        const badge = card.querySelector('.tag.running');
        const btn = card.querySelector('.btn-start-stop');
        if (runningIds.has(p.id)) {
          if (!badge) {}
          btn.textContent = '⏹ 停止';
          btn.className = 'primary-btn btn-start-stop stop';
        } else {
          btn.textContent = '▶ 启动';
          btn.className = 'primary-btn btn-start-stop';
        }
      }
    });
  });

  grid.innerHTML = list.map(p => projectCardHtml(p)).join('');
  // 绑定卡片事件
  list.forEach(p => bindCard(p));
}

function projectCardHtml(p) {
  const typeLabel = TYPE_LABELS[p.type] || '❓';
  const typeClass = p.framework ? 'type-framework' : (p.type === 'static' ? 'type-static' : 'type-unknown');
  return `
  <div class="card" id="card-${p.id}">
    <div class="card-head">
      <div class="card-icon">${p.framework ? '⚡' : '📦'}</div>
      <div class="card-main">
        <div class="card-name">${escapeHtml(p.name)}</div>
        <div class="card-path" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</div>
      </div>
    </div>
    <div class="card-tags">
      <span class="tag ${typeClass}">${typeLabel}</span>
      <span class="tag running" style="display:none">● 运行中</span>
    </div>
    <div class="card-actions">
      <button class="primary-btn btn-start-stop">▶ 启动</button>
      <button class="ghost-btn btn-reveal">📁 打开</button>
      <button class="mini-btn btn-fav ${p.favorite ? 'active' : ''}" title="${p.favorite ? '取消收藏' : '收藏'}">${p.favorite ? '⭐' : '☆'}</button>
      <button class="mini-btn btn-del" title="删除">🗑</button>
    </div>
  </div>`;
}

function bindCard(p) {
  const card = $('#card-' + p.id);
  if (!card) return;
  card.querySelector('.btn-start-stop').addEventListener('click', () => onToggleStart(p));
  card.querySelector('.btn-reveal').addEventListener('click', () => window.api.revealProject(p.path));
  card.querySelector('.btn-fav').addEventListener('click', async () => {
    await window.api.updateProject({ id: p.id, patch: { favorite: !p.favorite } });
    await refreshStore(); render();
  });
  card.querySelector('.btn-del').addEventListener('click', async () => {
    if (!confirm(`删除项目「${p.name}」？\n（不会删除项目文件，只从列表移除）`)) return;
    await window.api.removeProject({ id: p.id });
    await refreshStore(); render();
    toast('已删除', 'success');
  });
}

let starting = new Set();
async function onToggleStart(p) {
  // 先拿状态判断是启动还是停止
  const status = await window.api.runnerStatus();
  const running = status.find(s => s.projectId === p.id);
  if (running) {
    await window.api.stopProject(p.id);
    toast('已停止', 'success');
    render();
    return;
  }
  if (starting.has(p.id)) return;
  starting.add(p.id);
  const btn = document.querySelector(`#card-${p.id} .btn-start-stop`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 启动中…'; }
  toast(`正在启动「${p.name}」…`);
  const r = await window.api.startProject(p.id);
  starting.delete(p.id);
  if (btn) btn.disabled = false;
  if (r.ok) {
    toast(`已启动 → ${r.instance.baseUrl}`, 'success');
    render();
  } else {
    toast(`启动失败：${r.error || '未知错误'}`, 'error');
    render();
  }
}

// --- 添加项目对话框 ---
function bindAddModal() {
  $('#btnCancelAdd').addEventListener('click', closeAddModal);
  $('#btnPick').addEventListener('click', pickDirectory);
  $('#btnConfirmAdd').addEventListener('click', confirmAdd);
  $('.modal-backdrop', $('#addModal'));
  $('#addModal').querySelector('.modal-backdrop').addEventListener('click', closeAddModal);
}

function openAddModal() {
  $('#addPath').value = '';
  $('#addName').value = '';
  $('#addCmd').value = '';
  $('#detectInfo').style.display = 'none';
  $('#cmdRow').style.display = 'none';
  $('#btnConfirmAdd').disabled = true;
  $('#addModal').style.display = 'flex';
}

function closeAddModal() {
  $('#addModal').style.display = 'none';
}

let picked = null;
async function pickDirectory() {
  const r = await window.api.openDirectory();
  if (!r) return;
  picked = r;
  $('#addPath').value = r.path;
  if (!$('#addName').value) $('#addName').value = r.path.split(/[\\/]/).pop();
  // 显示探测结果
  const info = $('#detectInfo');
  const label = TYPE_LABELS[r.type] || r.type;
  if (r.framework) {
    info.className = 'detect-info';
    info.innerHTML = `识别为 <b>${label}</b> 框架项目，启动命令：<b>${escapeHtml(r.startCommand)}</b>（可改）`;
    $('#cmdRow').style.display = '';
    $('#addCmd').value = r.startCommand;
  } else if (r.type === 'static') {
    info.className = 'detect-info';
    info.innerHTML = `识别为 <b>📦 静态项目</b>，将用内置预览服务器启动，<b>不写任何文件</b>。`;
    $('#cmdRow').style.display = 'none';
  } else {
    info.className = 'detect-info warn';
    info.innerHTML = `⚠️ 没识别出项目类型。可选静态预览，或手动填启动命令（如 <b>npm run dev</b>）。`;
    $('#cmdRow').style.display = '';
    $('#addCmd').value = 'npm run dev';
  }
  info.style.display = '';
  $('#btnConfirmAdd').disabled = false;
}

async function confirmAdd() {
  if (!picked) return;
  const name = $('#addName').value.trim() || picked.path.split(/[\\/]/).pop();
  const cmd = $('#addCmd').value.trim();
  const r = await window.api.addProject({
    name,
    projectPath: picked.path,
    type: picked.type,
    startCommand: picked.framework ? (cmd || picked.startCommand) : null,
    framework: !!picked.framework
  });
  if (!r.created) {
    toast('这个项目已经在列表里了', 'error');
  } else {
    toast('已添加', 'success');
  }
  closeAddModal();
  await refreshStore();
  render();
}

// --- 端口管理 ---
async function renderPorts() {
  const status = await window.api.runnerStatus();
  const list = $('#portsList');
  if (!status.length) {
    list.innerHTML = '<div class="ports-empty">🔌 当前没有运行中的预览服务<br>启动一个项目后，端口会出现在这里。</div>';
    return;
  }
  list.innerHTML = status.map(s => {
    const proj = (store.projects || []).find(p => p.id === s.projectId);
    const name = proj ? proj.name : s.projectId;
    return `
    <div class="port-row">
      <div class="port-num">:${s.port}</div>
      <div class="port-info">
        <div class="port-proj">${escapeHtml(name)} · ${s.kind === 'framework' ? 'dev server' : '静态预览'}</div>
        <div class="port-url">${escapeHtml(s.baseUrl)}</div>
      </div>
      <button class="ghost-btn" data-action="open" data-url="${escapeHtml(s.navUrl || s.homeUrl)}">打开</button>
      <button class="ghost-btn" data-action="stop" data-id="${escapeHtml(s.projectId)}">停止</button>
    </div>`;
  }).join('');
  // 绑定按钮
  list.querySelectorAll('.port-row button').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.action === 'open') {
        window.api.openExternal(btn.dataset.url);
      } else if (btn.dataset.action === 'stop') {
        await window.api.stopProject(btn.dataset.id);
        renderPorts(); render();
        toast('已停止', 'success');
      }
    });
  });
}

let lastPortsSig = '';
async function maybeRefreshPorts() {
  if (currentView !== 'ports') return;
  const status = await window.api.runnerStatus();
  const sig = status.map(s => s.projectId + ':' + s.port).join(',');
  if (sig !== lastPortsSig) { lastPortsSig = sig; renderPorts(); }
}

// --- AI Agent ---
function fillAgentPrompt() {
  const prompt = `你正在使用「本地运行前端项目」桌面软件。它在本机运行了一个控制接口（http://127.0.0.1:47800），你可以通过它控制软件，帮用户启动/关闭前端项目。

可用接口（仅本机，JSON）：
- GET  http://127.0.0.1:47800/projects   拿到所有项目列表（含 id / name / path / type）
- GET  http://127.0.0.1:47800/status     查看当前运行中的实例
- POST  http://127.0.0.1:47800/start     body: {"id":"<projectId>"}  启动项目（会自动开浏览器和目录页）
- POST  http://127.0.0.1:47800/stop      body: {"id":"<projectId>"}  关闭项目

工作方式：
1. 用户说"启动 XXX 项目"时，先 GET /projects 找到名字匹配的项目的 id，再 POST /start。
2. 用户说"关闭 / 停掉"时，先 GET /status 看运行中的，再 POST /stop。
3. 启动后把返回的 baseUrl / navUrl（目录页）告诉用户。

注意：这个软件不会往用户的项目里写任何文件，所有预览都在软件内部完成。`;
  $('#agentPrompt').textContent = prompt;
}

function bindAgent() {
  $('#btnCopyPrompt').addEventListener('click', () => {
    const txt = $('#agentPrompt').textContent;
    navigator.clipboard.writeText(txt).then(() => toast('Prompt 已复制', 'success'));
  });
}

// --- 更新 ---
function bindUpdate() {
  window.api.onUpdateAvailable((info) => showUpdate(info));
  // 也手动查一次（启动后）
  setTimeout(async () => {
    const r = await window.api.checkUpdate();
    if (r.hasUpdate) showUpdate(r);
  }, 3000);
}

function showUpdate(info) {
  $('#updateBody').innerHTML = `当前版本 <b>v${info.current}</b><br>最新版本 <b>v${info.latest}</b><br><br>${info.name ? escapeHtml(info.name) : ''}`;
  $('#updateLink').href = info.htmlUrl || '#';
  $('#updateModal').style.display = 'flex';
}

// --- 日志（开发用） ---
function bindLogs() {
  // 默认把日志打到 console；--dev 模式可在 devtools 看
  window.api.onProjectLog(({ id, msg }) => {
    // eslint-disable-next-line no-console
    console.log(`[${id}] ${msg}`);
  });
}

// --- utils ---
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

init();
