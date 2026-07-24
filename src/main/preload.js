// preload：通过 contextBridge 暴露安全的 IPC API 给渲染进程。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 目录选择 + 探测
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  detect: (projectPath) => ipcRenderer.invoke('project:detect', projectPath),

  // store
  getStore: () => ipcRenderer.invoke('store:get'),

  // 项目
  addProject: (payload) => ipcRenderer.invoke('project:add', payload),
  updateProject: (payload) => ipcRenderer.invoke('project:update', payload),
  removeProject: (payload) => ipcRenderer.invoke('project:remove', payload),
  revealProject: (projectPath) => ipcRenderer.invoke('project:reveal', { projectPath }),

  startProject: (id) => ipcRenderer.invoke('project:start', { id }),
  stopProject: (id) => ipcRenderer.invoke('project:stop', { id }),
  runnerStatus: () => ipcRenderer.invoke('runner:status'),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),

  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  appVersion: () => ipcRenderer.invoke('app:version'),

  // 日志系统
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  // 事件
  onProjectLog: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('project:log', h);
    return () => ipcRenderer.removeListener('project:log', h);
  },
  onUpdateAvailable: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('app:updateAvailable', h);
    return () => ipcRenderer.removeListener('app:updateAvailable', h);
  },
  onCtrlLog: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on('ctrl:log', h);
    return () => ipcRenderer.removeListener('ctrl:log', h);
  }
});
