// 内存日志系统：保留近 50 条详细日志，只存内存不写磁盘（agent.md 第50-52行要求）。
// 主进程内所有模块通过 push(msg) 写日志，渲染层通过 IPC getLogs 读取。

const MAX_LOGS = 50;
const logs = []; // 环形缓冲，最新的在末尾

function push(level, msg, meta) {
  const entry = {
    t: Date.now(),
    time: new Date().toISOString(),
    level: typeof level === 'string' ? level : 'info',
    msg: typeof level === 'string' ? String(msg) : String(level),
    meta: typeof level === 'string' ? meta : undefined
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  return entry;
}

// 便捷方法
const logger = {
  info: (msg, meta) => push('info', msg, meta),
  ok: (msg, meta) => push('ok', msg, meta),
  warn: (msg, meta) => push('warn', msg, meta),
  error: (msg, meta) => push('error', msg, meta),
  push,
  all: () => logs.slice(),
  clear: () => { logs.length = 0; }
};

module.exports = logger;
