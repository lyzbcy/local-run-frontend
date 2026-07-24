// 项目 + 设置的持久化存储。
// 存到 app.getPath('userData')/projects.json。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  projects: [],
  settings: {
    portRange: [8091, 8100],
    githubRepo: 'lyzbcy/local-run-frontend',
    autoOpenNav: true
  }
};

let DATA_FILE = null;

function init(userDataDir) {
  DATA_FILE = path.join(userDataDir, 'projects.json');
  if (!fs.existsSync(DATA_FILE)) {
    save(mergeDefaults({}));
  }
  return load();
}

function load() {
  if (!DATA_FILE) throw new Error('store 未 init');
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return mergeDefaults(JSON.parse(raw));
  } catch (e) {
    return mergeDefaults({});
  }
}

function save(data) {
  if (!DATA_FILE) throw new Error('store 未 init');
  const merged = mergeDefaults(data || {});
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function mergeDefaults(data) {
  return {
    projects: Array.isArray(data.projects) ? data.projects : [],
    settings: { ...DEFAULTS.settings, ...(data.settings || {}) }
  };
}

// --- 项目 CRUD ---

function listProjects(data) {
  return (data.projects || []).slice().sort((a, b) =>
    (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
}

function findProject(data, id) {
  return (data.projects || []).find(p => p.id === id) || null;
}

function addProject(data, { name, projectPath, type, startCommand, framework }) {
  // 同路径去重
  const exists = (data.projects || []).find(p => p.path === projectPath);
  if (exists) return { data, project: exists, created: false };

  const project = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    name: name || path.basename(projectPath),
    path: projectPath,
    type: type || 'unknown',
    framework: !!framework,
    startCommand: startCommand || null,
    port: null,
    favorite: false,
    lastOpenedAt: null,
    createdAt: new Date().toISOString()
  };
  const next = { ...data, projects: [...(data.projects || []), project] };
  return { data: next, project, created: true };
}

function updateProject(data, id, patch) {
  const next = { ...data, projects: (data.projects || []).map(p =>
    p.id === id ? { ...p, ...patch } : p) };
  return { data: next, project: next.projects.find(p => p.id === id) || null };
}

function removeProject(data, id) {
  return { ...data, projects: (data.projects || []).filter(p => p.id !== id) };
}

module.exports = {
  init, load, save,
  listProjects, findProject, addProject, updateProject, removeProject
};
