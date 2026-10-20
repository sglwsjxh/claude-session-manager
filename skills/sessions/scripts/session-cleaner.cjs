'use strict';

const fs = require('fs');
const path = require('path');

const store = require('./session-store.cjs');

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 校验 session id 是否安全
 *
 * 拒绝路径分隔符、相对路径片段与隐藏文件标记。
 */
function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  if (sessionId.includes('/') || sessionId.includes('\\')) return false;
  if (sessionId.includes('..')) return false;
  if (sessionId.startsWith('.')) return false;
  return /^[A-Za-z0-9_-]+$/.test(sessionId);
}

/**
 * 校验目标路径仍在 .claude 目录内
 */
function isInsideClaudeDir(target, claudeRoot) {
  const resolvedRoot = path.resolve(claudeRoot);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) return false;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative) return false;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

/**
 * 查找会话所在的项目目录
 */
function findProjectDir(claudeRoot, sessionId) {
  const projectsDir = path.join(claudeRoot, 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return { projectDir: path.join(projectsDir, dir.name), filePath: candidate };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 引用关系分析
// ---------------------------------------------------------------------------

/**
 * 找出引用了指定会话的 paste-cache 文件
 *
 * 粘贴内容按哈希缓存，不同会话可能引用同一个哈希。
 */
function findPasteCacheRefs(claudeRoot, sessionId) {
  const refs = new Map();
  const historyPath = path.join(claudeRoot, 'history.jsonl');

  let content = '';
  try {
    content = fs.readFileSync(historyPath, 'utf8');
  } catch {
    return refs;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.sessionId !== sessionId) continue;

    const pasted = entry.pastedContents;
    if (!pasted || typeof pasted !== 'object') continue;
    for (const hash of Object.keys(pasted)) {
      if (!refs.has(hash)) refs.set(hash, new Set());
      refs.get(hash).add(sessionId);
    }
  }

  return refs;
}

/**
 * 统计所有会话对 paste-cache 哈希的引用
 */
function countAllPasteHashRefs(claudeRoot) {
  const counts = new Map();
  const historyPath = path.join(claudeRoot, 'history.jsonl');

  let content = '';
  try {
    content = fs.readFileSync(historyPath, 'utf8');
  } catch {
    return counts;
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || !entry.pastedContents || typeof entry.pastedContents !== 'object') continue;
    for (const hash of Object.keys(entry.pastedContents)) {
      if (!counts.has(hash)) counts.set(hash, new Set());
      counts.get(hash).add(entry.sessionId || '');
    }
  }

  return counts;
}

/**
 * 统计所有会话对 plan 文件的引用
 *
 * plan 文件在 history.jsonl 里以路径形式出现。
 */
function countAllPlanRefs(claudeRoot) {
  const counts = new Map();
  const historyPath = path.join(claudeRoot, 'history.jsonl');

  let content = '';
  try {
    content = fs.readFileSync(historyPath, 'utf8');
  } catch {
    return counts;
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry) continue;

    const display = typeof entry.display === 'string' ? entry.display : '';
    const match = display.match(/([A-Za-z0-9-]+\.md)\b/);
    if (!match) continue;
    const name = match[1];
    if (!counts.has(name)) counts.set(name, new Set());
    counts.get(name).add(entry.sessionId || '');
  }

  return counts;
}

// ---------------------------------------------------------------------------
// 清理计划
// ---------------------------------------------------------------------------

/**
 * 生成清理计划，不做任何实际删除
 *
 * @param {object} options { claudeDir, sessionId, force }
 * @returns {object} 计划
 */
function planCleanup(options) {
  const opts = options || {};
  const claudeRoot = opts.claudeDir || store.claudeDir();
  const sessionId = opts.sessionId;
  const force = opts.force === true;

  const plan = {
    sessionId,
    claudeRoot,
    files: [],
    dirs: [],
    historyLines: 0,
    skipped: [],
    blocked: null,
    totalBytes: 0,
  };

  if (!isSafeSessionId(sessionId)) {
    plan.blocked = `会话 ID 不合法：${sessionId}`;
    return plan;
  }

  // 活跃会话保护
  const currentId = store.currentSessionId(opts.env);
  if (currentId && currentId === sessionId) {
    plan.blocked = '这是当前正在使用的会话，不能删除';
    return plan;
  }

  const active = store.activeSessionIds({ claudeDir: claudeRoot });
  if (active.has(sessionId)) {
    plan.blocked = '该会话仍在运行中（进程存活），不能删除';
    return plan;
  }

  const found = findProjectDir(claudeRoot, sessionId);
  if (!found) {
    plan.blocked = `找不到会话 ${sessionId}`;
    return plan;
  }

  // 最近修改过的会话保守跳过，除非强制
  if (!force) {
    let stat;
    try {
      stat = fs.statSync(found.filePath);
    } catch {
      stat = null;
    }
    if (stat && store.isRecentlyModified({ modified: stat.mtimeMs })) {
      plan.blocked = '该会话在最近 5 分钟内被修改，为安全起见跳过';
      return plan;
    }
  }

  const addFile = (filePath, label) => {
    if (!isInsideClaudeDir(filePath, claudeRoot)) {
      plan.skipped.push({ path: filePath, reason: '路径超出 .claude 目录' });
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    plan.files.push({ path: filePath, label, size });
    plan.totalBytes += size;
  };

  const addDir = (dirPath, label) => {
    if (!isInsideClaudeDir(dirPath, claudeRoot)) {
      plan.skipped.push({ path: dirPath, reason: '路径超出 .claude 目录' });
      return;
    }
    if (!fs.existsSync(dirPath)) return;
    let size = 0;
    try {
      size = dirSize(dirPath);
    } catch {
      size = 0;
    }
    plan.dirs.push({ path: dirPath, label, size });
    plan.totalBytes += size;
  };

  // 1. 会话主记录
  addFile(found.filePath, '会话记录');

  // 2. 同胞目录，含 subagents 与 tool-results
  addDir(path.join(found.projectDir, sessionId), '会话附属目录');

  // 3. 会话环境
  addDir(path.join(claudeRoot, 'session-env', sessionId), '会话环境');

  // 4. 文件编辑历史
  addDir(path.join(claudeRoot, 'file-history', sessionId), '文件编辑历史');

  // 5. 可选目录，存在才处理
  addDir(path.join(claudeRoot, 'tasks', sessionId), '任务列表');

  const todosDir = path.join(claudeRoot, 'todos');
  if (fs.existsSync(todosDir)) {
    let names = [];
    try {
      names = fs.readdirSync(todosDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.includes(sessionId)) addFile(path.join(todosDir, name), '待办项');
    }
  }

  addFile(path.join(claudeRoot, 'debug', `${sessionId}.txt`), '调试日志');

  const telemetryDir = path.join(claudeRoot, 'telemetry');
  if (fs.existsSync(telemetryDir)) {
    let names = [];
    try {
      names = fs.readdirSync(telemetryDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.startsWith(`1p_failed_events.${sessionId}.`)) {
        addFile(path.join(telemetryDir, name), '遥测事件');
      }
    }
  }

  addDir(path.join(claudeRoot, 'teams', sessionId), '团队数据');

  // 6. 活跃会话注册表，仅在进程已退出时删
  const sessionsDir = path.join(claudeRoot, 'sessions');
  let markerNames = [];
  try {
    markerNames = fs.readdirSync(sessionsDir);
  } catch {
    markerNames = [];
  }
  for (const name of markerNames) {
    if (!name.endsWith('.json')) continue;
    const markerPath = path.join(sessionsDir, name);
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
      continue;
    }
    if (!data || data.sessionId !== sessionId) continue;
    if (store.pidAlive(data.pid)) {
      plan.skipped.push({ path: markerPath, reason: '进程仍在运行' });
      continue;
    }
    addFile(markerPath, '会话注册表');
  }

  // 7. 粘贴缓存，仅当独占
  const pasteRefs = countAllPasteHashRefs(claudeRoot);
  for (const [hash, sessions] of pasteRefs) {
    if (!sessions.has(sessionId)) continue;
    const cacheFile = path.join(claudeRoot, 'paste-cache', `${hash}.txt`);
    if (!fs.existsSync(cacheFile)) continue;
    if (sessions.size > 1) {
      plan.skipped.push({ path: cacheFile, reason: `被 ${sessions.size} 个会话共享` });
      continue;
    }
    addFile(cacheFile, '粘贴缓存');
  }

  // 8. plan 文件，仅当独占
  const planRefs = countAllPlanRefs(claudeRoot);
  for (const [name, sessions] of planRefs) {
    if (!sessions.has(sessionId)) continue;
    const planFile = path.join(claudeRoot, 'plans', name);
    if (!fs.existsSync(planFile)) continue;
    if (sessions.size > 1) {
      plan.skipped.push({ path: planFile, reason: `被 ${sessions.size} 个会话共享` });
      continue;
    }
    addFile(planFile, '计划文件');
  }

  // 9. 提示历史，记录将被移除的行数
  plan.historyLines = countHistoryLines(claudeRoot, sessionId);

  return plan;
}

/**
 * 统计 history.jsonl 里属于该会话的行数
 */
function countHistoryLines(claudeRoot, sessionId) {
  const historyPath = path.join(claudeRoot, 'history.jsonl');
  let content = '';
  try {
    content = fs.readFileSync(historyPath, 'utf8');
  } catch {
    return 0;
  }

  let count = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.sessionId === sessionId) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

/**
 * 目录总字节数
 */
function dirSize(dirPath) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          continue;
        }
      }
    }
  };
  walk(dirPath);
  return total;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 改写 history.jsonl，移除属于该会话的行
 *
 * 先写临时文件再原子替换，避免留下半截文件。
 */
function rewriteHistory(claudeRoot, sessionId) {
  const historyPath = path.join(claudeRoot, 'history.jsonl');
  let content = '';
  try {
    content = fs.readFileSync(historyPath, 'utf8');
  } catch {
    return { removed: 0, changed: false };
  }

  const kept = [];
  let removed = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry = null;
    let isTarget = false;
    try {
      entry = JSON.parse(line);
      isTarget = Boolean(entry) && entry.sessionId === sessionId;
    } catch {
      isTarget = false;
    }
    if (isTarget) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  if (removed === 0) return { removed: 0, changed: false };

  const tempPath = `${historyPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    fs.renameSync(tempPath, historyPath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // 临时文件清理失败不影响原文件
    }
    return { removed: 0, changed: false, error: err.message };
  }

  return { removed, changed: true };
}

/**
 * 执行清理
 *
 * @param {object} options { claudeDir, sessionId, force, dryRun }
 * @returns {object} 结果
 */
function executeCleanup(options) {
  const opts = options || {};
  const claudeRoot = opts.claudeDir || store.claudeDir();
  const sessionId = opts.sessionId;
  const dryRun = opts.dryRun === true;

  const plan = planCleanup({
    claudeDir: claudeRoot,
    sessionId,
    force: opts.force,
    env: opts.env,
  });

  if (plan.blocked) {
    return { ok: false, blocked: plan.blocked, plan };
  }

  if (dryRun) {
    return { ok: true, dryRun: true, plan };
  }

  const result = {
    ok: true,
    dryRun: false,
    deletedFiles: [],
    deletedDirs: [],
    historyRemoved: 0,
    errors: [],
    skipped: plan.skipped,
  };

  for (const item of plan.files) {
    try {
      fs.unlinkSync(item.path);
      result.deletedFiles.push(item.path);
    } catch (err) {
      result.errors.push(`${item.path}：${err.message}`);
    }
  }

  for (const item of plan.dirs) {
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      result.deletedDirs.push(item.path);
    } catch (err) {
      result.errors.push(`${item.path}：${err.message}`);
    }
  }

  const history = rewriteHistory(claudeRoot, sessionId);
  result.historyRemoved = history.removed;
  if (history.error) {
    result.errors.push(`history.jsonl：${history.error}`);
  }

  if (result.errors.length > 0) result.ok = false;
  return result;
}

/**
 * 把清理计划渲染成可读文本
 */
function formatPlan(plan) {
  const lines = [];
  const label = plan.sessionId ? plan.sessionId.slice(0, 8) : '';

  if (plan.blocked) {
    lines.push(`无法删除：${plan.blocked}`);
    return lines.join('\n');
  }

  lines.push(`会话 ${label} 将被清理，合计 ${store.formatSize(plan.totalBytes)}`);

  if (plan.files.length) {
    lines.push('');
    lines.push('文件');
    for (const item of plan.files) {
      lines.push(`  ${store.formatSize(item.size).padStart(7)}  ${item.label}  ${item.path}`);
    }
  }

  if (plan.dirs.length) {
    lines.push('');
    lines.push('目录');
    for (const item of plan.dirs) {
      lines.push(`  ${store.formatSize(item.size).padStart(7)}  ${item.label}  ${item.path}`);
    }
  }

  if (plan.historyLines > 0) {
    lines.push('');
    lines.push(`提示历史  ${plan.historyLines} 行将从 history.jsonl 移除`);
  }

  if (plan.skipped.length) {
    lines.push('');
    lines.push('跳过');
    for (const item of plan.skipped) {
      lines.push(`  ${item.path}  ${item.reason}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  isSafeSessionId,
  isInsideClaudeDir,
  findProjectDir,
  countAllPasteHashRefs,
  countAllPlanRefs,
  countHistoryLines,
  dirSize,
  planCleanup,
  executeCleanup,
  rewriteHistory,
  formatPlan,
};
