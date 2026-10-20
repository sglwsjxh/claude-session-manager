'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

// 会话记录里系统注入的文本多以 < 开头，取首条用户消息时要跳过
const SYSTEM_PREFIX = '<';
// 过短的片段不当作有意义的标题
const MIN_TITLE_LENGTH = 5;
// 判定会话是否仍在使用的修改时间窗口
const RECENT_MODIFY_WINDOW_MS = 5 * 60 * 1000;

/**
 * 取得 .claude 根目录。环境变量优先，便于测试注入。
 */
function claudeDir(env) {
  const source = env || process.env;
  return source.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * 工作目录编码成项目目录名，非字母数字全部替换为连字符
 */
function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 把过长的项目目录名还原成可读形式，用于展示
 */
function shortenCwd(cwd, home) {
  if (!cwd) return '(未知)';
  const base = home || os.homedir();
  if (cwd === base) return '~';
  if (cwd.startsWith(base + path.sep)) return '~' + cwd.slice(base.length);
  return cwd;
}

// ---------------------------------------------------------------------------
// 会话元数据
// ---------------------------------------------------------------------------

/**
 * 从 user 记录里取纯文本内容
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join(' ');
}

/**
 * 清理一行文本，取单行并压缩空白
 */
function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * 单次前向扫描会话文件，取出 cwd、标题、消息数与首条用户消息
 *
 * 用流式逐行读取，避免把上兆的 transcript 整个读进内存。
 *
 * @param {string} filePath 会话文件路径
 * @returns {Promise<object>} 元数据
 */
function readMetadata(filePath) {
  return new Promise((resolve) => {
    const result = {
      cwd: null,
      title: null,
      messageCount: 0,
      firstPrompt: '',
      sidechain: false,
    };

    let customTitle = '';
    let aiTitle = '';
    let lastPrompt = '';
    let firstPrompt = '';
    let settled = false;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      reader.close();
      stream.destroy();
      result.title = customTitle || aiTitle || lastPrompt || firstPrompt || null;
      resolve(result);
    };

    reader.on('line', (line) => {
      if (!line.trim()) return;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (!entry || typeof entry !== 'object') return;

      if (!result.cwd && typeof entry.cwd === 'string') result.cwd = entry.cwd;
      if (entry.isSidechain === true) result.sidechain = true;

      const type = entry.type;

      // /rename 每次追加一条，最后一条生效
      if (type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = normalizeText(entry.customTitle);
        return;
      }
      if (type === 'ai-title' && typeof entry.aiTitle === 'string' && !aiTitle) {
        aiTitle = normalizeText(entry.aiTitle);
        return;
      }
      if (type === 'last-prompt' && typeof entry.lastPrompt === 'string' && !lastPrompt) {
        lastPrompt = normalizeText(entry.lastPrompt);
        return;
      }
      if (type !== 'user') return;

      result.messageCount += 1;
      if (settled) return;

      const text = normalizeText(extractText(entry.message && entry.message.content));
      if (!text) return;
      if (text.startsWith(SYSTEM_PREFIX)) return;
      if (text.length <= MIN_TITLE_LENGTH) return;

      firstPrompt = text.slice(0, 120);
      settled = true;
    });

    reader.on('close', () => {
      result.title = customTitle || aiTitle || lastPrompt || firstPrompt || null;
      resolve(result);
    });

    stream.on('error', () => {
      result.title = customTitle || aiTitle || lastPrompt || firstPrompt || null;
      resolve(result);
    });
  });
}

/**
 * 读取会话文件里的消息，用于预览
 */
function readMessages(filePath, limit) {
  return new Promise((resolve) => {
    const messages = [];
    const max = limit || 40;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

    reader.on('line', (line) => {
      if (!line.trim() || messages.length >= max) return;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (!entry || entry.isSidechain === true) return;
      if (entry.type !== 'user' && entry.type !== 'assistant') return;

      const text = normalizeText(extractText(entry.message && entry.message.content));
      if (!text) return;
      if (text.startsWith(SYSTEM_PREFIX)) return;

      messages.push({
        role: entry.type,
        text: text.slice(0, 600),
        timestamp: entry.timestamp || null,
      });
    });

    reader.on('close', () => resolve(messages));
    stream.on('error', () => resolve(messages));
  });
}

// ---------------------------------------------------------------------------
// 会话扫描
// ---------------------------------------------------------------------------

/**
 * 扫描所有项目目录下的会话
 *
 * @param {object} options { claudeDir, homeDir }
 * @returns {Promise<Array>} 会话列表，按修改时间倒序
 */
async function scanSessions(options) {
  const opts = options || {};
  const root = opts.claudeDir || claudeDir();
  const projectsDir = opts.projectsDir || path.join(root, 'projects');
  const home = opts.homeDir || os.homedir();
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return sessions;
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(projectsDir, dir.name);
    if (dir.name === 'memory') continue;

    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      // 子代理 transcript 以 agent- 开头，不是独立会话
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      if (sessionId.startsWith('agent-')) continue;

      const filePath = path.join(projectPath, entry.name);

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;

      const meta = await readMetadata(filePath);
      const companion = path.join(projectPath, sessionId);

      sessions.push({
        id: sessionId,
        filePath,
        project: meta.cwd ? shortenCwd(meta.cwd, home) : dir.name,
        cwd: meta.cwd,
        title: meta.title,
        firstPrompt: meta.firstPrompt,
        messageCount: meta.messageCount,
        sidechain: meta.sidechain,
        size: stat.size,
        modified: stat.mtimeMs,
        hasCompanion: fs.existsSync(companion),
      });
    }
  }

  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

// ---------------------------------------------------------------------------
// 活跃会话判定
// ---------------------------------------------------------------------------

/**
 * 检查进程是否存活
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return output.includes(String(pid));
    } catch {
      return false;
    }
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 读取活跃会话注册表，返回仍在运行的会话 ID 集合
 *
 * @param {object} options { claudeDir }
 * @returns {Set<string>}
 */
function activeSessionIds(options) {
  const opts = options || {};
  const root = opts.claudeDir || claudeDir();
  const sessionsDir = path.join(root, 'sessions');
  const active = new Set();

  let files;
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return active;
  }

  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8'));
      if (!data || typeof data.sessionId !== 'string') continue;
      // 进程已退出的注册表记录不算活跃
      if (!pidAlive(data.pid)) continue;
      active.add(data.sessionId);
    } catch {
      continue;
    }
  }

  return active;
}

/**
 * 当前会话 ID
 *
 * 环境变量真名是 CLAUDE_CODE_SESSION_ID，CLAUDE_SESSION_ID 是 skill 里的
 * 字符串替换占位符，不是环境变量，保留它作为兼容回退。
 */
function currentSessionId(env) {
  const source = env || process.env;
  return source.CLAUDE_CODE_SESSION_ID || source.CLAUDE_SESSION_ID || null;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 字节数转可读体积
 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${Math.floor(bytes / 1024)}K`;
  return `${(bytes / 1048576).toFixed(1)}M`;
}

/**
 * 时间戳转可读日期
 */
function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 判断会话是否在最近修改过
 */
function isRecentlyModified(session, windowMs) {
  const span = windowMs || RECENT_MODIFY_WINDOW_MS;
  return Date.now() - session.modified < span;
}

module.exports = {
  RECENT_MODIFY_WINDOW_MS,
  MIN_TITLE_LENGTH,
  claudeDir,
  projectSlug,
  shortenCwd,
  extractText,
  normalizeText,
  readMetadata,
  readMessages,
  scanSessions,
  pidAlive,
  activeSessionIds,
  currentSessionId,
  formatSize,
  formatDate,
  isRecentlyModified,
};
