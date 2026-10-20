'use strict';

const fs = require('fs');
const path = require('path');

const store = require('./session-store.cjs');
const cleaner = require('./session-cleaner.cjs');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function hasFlag(flag) {
  return argv.includes(flag);
}

function flagValue(flag) {
  const index = argv.indexOf(flag);
  if (index !== -1 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return null;
}

const OPTION = {
  list: hasFlag('--list'),
  preview: flagValue('--preview'),
  plan: flagValue('--plan'),
  delete: flagValue('--delete'),
  yes: hasFlag('--yes'),
  dryRun: hasFlag('--dry-run'),
  json: hasFlag('--json'),
  version: hasFlag('--version') || hasFlag('-v'),
  help: hasFlag('--help') || hasFlag('-h'),
  project: flagValue('--project'),
  olderThan: flagValue('--older-than'),
  smallerThan: flagValue('--smaller-than'),
  claudeDir: flagValue('--claude-dir'),
};

// 版本号与包清单保持一致
const VERSION = (() => {
  try {
    // 脚本位于 <仓库根>/skills/sessions/scripts/，往上三级到仓库根
    const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// 终端常量
// ---------------------------------------------------------------------------

// 控制字符一律用转义写法，避免源码里出现裸控制字节
const ESC = String.fromCharCode(27);
const KEY = {
  escape: ESC,
  ctrlC: String.fromCharCode(3),
  backspace: String.fromCharCode(127),
  up: ESC + '[A',
  down: ESC + '[B',
  enter: '\r',
  tab: '\t',
};

const COLOR = {
  reset: ESC + '[0m',
  bold: ESC + '[1m',
  dim: ESC + '[2m',
  red: ESC + '[31m',
  green: ESC + '[32m',
  yellow: ESC + '[33m',
  magenta: ESC + '[35m',
  cyan: ESC + '[36m',
  gray: ESC + '[90m',
};

function supportsColor() {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

function paint(text, color) {
  if (!supportsColor()) return text;
  return color + text + COLOR.reset;
}

// 去掉 ANSI 序列后的实际宽度
const ANSI_PATTERN = new RegExp(ESC + '\\[[0-9;]*m', 'g');

function visibleLength(text) {
  return String(text).replace(ANSI_PATTERN, '').length;
}

function pad(text, width) {
  const len = visibleLength(text);
  if (len >= width) return text;
  return text + ' '.repeat(width - len);
}

function truncate(text, width) {
  const plain = String(text).replace(/\s+/g, ' ').trim();
  if (plain.length <= width) return plain;
  return plain.slice(0, Math.max(0, width - 1)) + '…';
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

const FILTER_MODES = ['all', 'project', 'small', 'old'];

const FILTER_LABELS = {
  all: '全部',
  project: '按项目',
  small: '小于 100K',
  old: '超过 30 天',
};

/**
 * 体积字符串转字节数，支持 5K / 1M / 500 这类写法
 */
function parseSize(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'kb') return Math.round(value * 1024);
  if (unit === 'm' || unit === 'mb') return Math.round(value * 1048576);
  if (unit === 'g' || unit === 'gb') return Math.round(value * 1073741824);
  if (unit === 't' || unit === 'tb') return Math.round(value * 1099511627776);
  return Math.round(value);
}

/**
 * 时长字符串转毫秒数，支持 7d / 2w / 3m 这类写法
 */
function parseDuration(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d+)\s*([dhwmy]?)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'd').toLowerCase();
  if (unit === 'h') return value * 3600000;
  if (unit === 'w') return value * 7 * 86400000;
  if (unit === 'm') return value * 30 * 86400000;
  if (unit === 'y') return value * 365 * 86400000;
  return value * 86400000;
}

/**
 * 按筛选模式与搜索词过滤会话
 */
function applyFilter(sessions, mode, search, options) {
  const opts = options || {};
  let list = sessions;

  if (mode === 'project' && opts.projectFilter) {
    const target = String(opts.projectFilter).toLowerCase();
    list = list.filter((s) => s.project.toLowerCase().includes(target));
  }
  if (mode === 'small') {
    list = list.filter((s) => s.size < 100 * 1024);
  }
  if (mode === 'old') {
    const cutoff = Date.now() - 30 * 86400000;
    list = list.filter((s) => s.modified < cutoff);
  }

  if (search) {
    const needle = String(search).toLowerCase();
    list = list.filter((s) => {
      const haystack = [s.title || '', s.firstPrompt || '', s.project, s.id].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }

  return list;
}

/**
 * 按时间或体积条件选出要批量清理的会话
 */
function selectByCondition(sessions, options) {
  const opts = options || {};
  const older = parseDuration(opts.olderThan);
  const smaller = parseSize(opts.smallerThan);
  if (!older && !smaller) return [];

  return sessions.filter((s) => {
    if (older && Date.now() - s.modified < older) return false;
    if (smaller && s.size >= smaller) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderList(sessions, state) {
  const lines = [];
  const activeIds = state.activeIds || new Set();
  const currentId = state.currentId;

  lines.push(paint('Claude Code 会话', COLOR.bold));
  lines.push(paint(sessions.length + ' 个会话  ' + store.formatSize(state.totalSize), COLOR.dim));
  lines.push('');

  if (!sessions.length) {
    lines.push(paint('  没有匹配的会话', COLOR.dim));
    return lines;
  }

  sessions.forEach((session, index) => {
    const selected = index === state.cursor;
    const marker = selected ? paint('›', COLOR.cyan) : ' ';
    const number = paint(pad(String(index + 1), 3), COLOR.gray);

    const badges = [];
    if (currentId && session.id === currentId) badges.push(paint('当前', COLOR.yellow));
    if (activeIds.has(session.id)) badges.push(paint('运行中', COLOR.green));
    if (session.sidechain) badges.push(paint('子代理', COLOR.magenta));

    const title = truncate(session.title || '(无标题)', 44);
    const time = store.formatDate(session.modified);
    const size = store.formatSize(session.size).padStart(7);

    const left = number + ' ' + pad(size, 7) + ' ' + pad(time, 16) + ' ' + pad(title, 44);
    const line = marker + ' ' + left + ' ' + badges.join(' ');
    lines.push(selected ? paint(line, COLOR.bold) : line);
  });

  return lines;
}

function renderPreview(session, messages) {
  const lines = [];
  lines.push(paint('会话 ' + session.id, COLOR.bold));
  lines.push(paint('项目 ' + session.project, COLOR.dim));
  lines.push(paint('修改 ' + store.formatDate(session.modified), COLOR.dim));
  lines.push(paint('体积 ' + store.formatSize(session.size) + '  消息 ' + session.messageCount, COLOR.dim));
  lines.push('');

  if (!messages || !messages.length) {
    lines.push(paint('  没有可预览的消息', COLOR.dim));
    return lines;
  }

  for (const message of messages) {
    const who = message.role === 'user' ? paint('你', COLOR.cyan) : paint('AI', COLOR.green);
    lines.push(who + ' ' + truncate(message.text, 100));
    lines.push('');
  }

  return lines;
}

function renderDeleteConfirm(plan) {
  const lines = [];
  lines.push(paint('  确认删除', COLOR.red + COLOR.bold));
  lines.push('');
  for (const line of cleaner.formatPlan(plan).split('\n')) {
    lines.push('  ' + line);
  }
  lines.push('');
  lines.push(paint('  按 y 确认删除，其余键取消', COLOR.yellow));
  return lines;
}

// ---------------------------------------------------------------------------
// 终端控制
// ---------------------------------------------------------------------------

function enterAltScreen(out) {
  out.write(ESC + '[?1049h');
}

function exitAltScreen(out) {
  out.write(ESC + '[?1049l');
}

function clearScreen(out) {
  out.write(ESC + '[2J' + ESC + '[H');
}

function hideCursor(out) {
  out.write(ESC + '[?25l');
}

function showCursor(out) {
  out.write(ESC + '[?25h');
}

function hasTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

/**
 * 启动交互式浏览界面
 */
async function runInteractive(options) {
  const opts = options || {};
  const out = process.stdout;
  const sessions = await store.scanSessions({ claudeDir: opts.claudeDir });
  const activeIds = store.activeSessionIds({ claudeDir: opts.claudeDir });
  const currentId = store.currentSessionId();

  const state = {
    sessions,
    filtered: sessions,
    cursor: 0,
    mode: 'list',
    search: '',
    filterMode: 'all',
    activeIds,
    currentId,
    totalSize: sessions.reduce((sum, s) => sum + s.size, 0),
    plan: null,
    previewMessages: [],
    deleted: [],
  };

  const refresh = () => {
    state.filtered = applyFilter(state.sessions, state.filterMode, state.search, {
      projectFilter: opts.projectFilter,
    });
    if (state.cursor >= state.filtered.length) {
      state.cursor = Math.max(0, state.filtered.length - 1);
    }
  };

  const draw = () => {
    clearScreen(out);
    let lines;
    if (state.mode === 'preview') {
      lines = renderPreview(state.filtered[state.cursor], state.previewMessages);
      lines.push(paint('  Esc 返回', COLOR.dim));
    } else if (state.mode === 'confirm') {
      lines = renderDeleteConfirm(state.plan);
    } else {
      lines = renderList(state.filtered, state);
      lines.push('');
      lines.push(paint('↑↓ 选择  Enter 预览  Backspace 删除  Tab 筛选(' + FILTER_LABELS[state.filterMode] + ')  输入搜索  Esc 退出', COLOR.dim));
    }
    out.write(lines.join('\n') + '\n');
  };

  const finish = (stdin, onData) => {
    showCursor(out);
    exitAltScreen(out);
    stdin.setRawMode(false);
    stdin.pause();
    stdin.removeListener('data', onData);
  };

  refresh();
  enterAltScreen(out);
  hideCursor(out);
  draw();

  return new Promise((resolve) => {
    const { stdin } = process;

    const onData = async (chunk) => {
      const key = chunk.toString('utf8');

      if (state.mode === 'confirm') {
        if (key === 'y' || key === 'Y') {
          const result = cleaner.executeCleanup({
            claudeDir: opts.claudeDir,
            sessionId: state.plan.sessionId,
          });
          if (result.ok) {
            state.deleted.push(state.plan.sessionId);
            state.sessions = state.sessions.filter((s) => s.id !== state.plan.sessionId);
            state.totalSize = state.sessions.reduce((sum, s) => sum + s.size, 0);
            refresh();
          }
        }
        state.mode = 'list';
        state.plan = null;
        draw();
        return;
      }

      if (state.mode === 'preview') {
        if (key === KEY.escape || key === 'q') {
          state.mode = 'list';
          draw();
        }
        return;
      }

      // 列表模式
      if (key === KEY.escape || key === KEY.ctrlC) {
        finish(stdin, onData);
        resolve({ deleted: state.deleted, remaining: state.sessions.length });
        return;
      }
      if (key === KEY.up || key === 'k') {
        state.cursor = Math.max(0, state.cursor - 1);
        draw();
        return;
      }
      if (key === KEY.down || key === 'j') {
        state.cursor = Math.min(state.filtered.length - 1, state.cursor + 1);
        draw();
        return;
      }
      if (key === KEY.tab) {
        const index = FILTER_MODES.indexOf(state.filterMode);
        state.filterMode = FILTER_MODES[(index + 1) % FILTER_MODES.length];
        state.search = '';
        refresh();
        draw();
        return;
      }
      if (key === KEY.enter || key === '\n') {
        const session = state.filtered[state.cursor];
        if (!session) return;
        state.previewMessages = await store.readMessages(session.filePath, 30);
        state.mode = 'preview';
        draw();
        return;
      }
      if (key === KEY.backspace || key === '\b') {
        const session = state.filtered[state.cursor];
        if (!session) return;
        state.plan = cleaner.planCleanup({
          claudeDir: opts.claudeDir,
          sessionId: session.id,
        });
        state.mode = 'confirm';
        draw();
        return;
      }
      if (key >= ' ' && key <= '~') {
        state.search += key;
        refresh();
        draw();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

async function commandList(options) {
  const sessions = await store.scanSessions({ claudeDir: options.claudeDir });
  const activeIds = store.activeSessionIds({ claudeDir: options.claudeDir });
  const currentId = store.currentSessionId();

  if (options.json) {
    process.stdout.write(JSON.stringify({
      mode: 'cli',
      count: sessions.length,
      totalSize: sessions.reduce((sum, s) => sum + s.size, 0),
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        project: s.project,
        size: s.size,
        modified: new Date(s.modified).toISOString(),
        messageCount: s.messageCount,
        active: activeIds.has(s.id),
        current: s.id === currentId,
        sidechain: s.sidechain,
      })),
    }) + '\n');
    return;
  }

  const state = {
    sessions,
    filtered: sessions,
    cursor: -1,
    activeIds,
    currentId,
    totalSize: sessions.reduce((sum, s) => sum + s.size, 0),
  };

  const lines = renderList(sessions, state);
  lines.push('');
  lines.push(paint('删除用 --delete <会话ID>，预览用 --preview <会话ID>', COLOR.dim));
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * 按 ID 或 ID 前缀找会话
 */
async function findSession(sessionId, options) {
  const sessions = await store.scanSessions({ claudeDir: options.claudeDir });
  const target = String(sessionId).toLowerCase();
  const exact = sessions.find((s) => s.id.toLowerCase() === target);
  if (exact) return exact;
  return sessions.find((s) => s.id.toLowerCase().startsWith(target)) || null;
}

async function commandPreview(sessionId, options) {
  const session = await findSession(sessionId, options);
  if (!session) {
    process.stdout.write('找不到会话 ' + sessionId + '\n');
    return;
  }

  const messages = await store.readMessages(session.filePath, 40);

  if (options.json) {
    process.stdout.write(JSON.stringify({
      mode: 'cli',
      session: {
        id: session.id,
        title: session.title,
        project: session.project,
        size: session.size,
        modified: new Date(session.modified).toISOString(),
        messageCount: session.messageCount,
      },
      messages,
    }) + '\n');
    return;
  }

  process.stdout.write(renderPreview(session, messages).join('\n') + '\n');
}

async function commandPlan(sessionId, options) {
  const session = await findSession(sessionId, options);
  if (!session) {
    process.stdout.write('找不到会话 ' + sessionId + '\n');
    return;
  }

  const plan = cleaner.planCleanup({
    claudeDir: options.claudeDir,
    sessionId: session.id,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({
      mode: 'cli',
      blocked: plan.blocked,
      files: plan.files,
      dirs: plan.dirs,
      historyLines: plan.historyLines,
      skipped: plan.skipped,
      totalBytes: plan.totalBytes,
    }) + '\n');
    return;
  }

  process.stdout.write(cleaner.formatPlan(plan) + '\n');
}

async function commandDelete(sessionId, options) {
  const session = await findSession(sessionId, options);
  if (!session) {
    process.stdout.write('找不到会话 ' + sessionId + '\n');
    return;
  }

  const plan = cleaner.planCleanup({
    claudeDir: options.claudeDir,
    sessionId: session.id,
  });

  if (plan.blocked) {
    process.stdout.write('无法删除：' + plan.blocked + '\n');
    return;
  }

  // 没有确认标记时先给计划，让调用方把明细转述给用户
  if (!options.yes) {
    process.stdout.write(cleaner.formatPlan(plan) + '\n');
    process.stdout.write('AWAITING_CONFIRMATION\n');
    return;
  }

  const result = cleaner.executeCleanup({
    claudeDir: options.claudeDir,
    sessionId: session.id,
    dryRun: options.dryRun,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({
      mode: 'cli',
      deleted: result.ok ? session.id : null,
      deletedFiles: result.deletedFiles,
      deletedDirs: result.deletedDirs,
      historyRemoved: result.historyRemoved,
      errors: result.errors,
      skipped: result.skipped,
    }) + '\n');
    return;
  }

  if (!result.ok) {
    process.stdout.write('删除过程中出现错误：\n' + result.errors.join('\n') + '\n');
    return;
  }

  if (result.dryRun) {
    process.stdout.write('试运行，未删除任何文件\n');
    return;
  }

  const freed = plan.totalBytes;
  process.stdout.write(
    '已删除会话 ' + session.id.slice(0, 8)
    + '，清理 ' + result.deletedFiles.length + ' 个文件、'
    + result.deletedDirs.length + ' 个目录、'
    + result.historyRemoved + ' 行提示历史，释放 ' + store.formatSize(freed) + '\n'
  );
}

async function commandClean(options) {
  const sessions = await store.scanSessions({ claudeDir: options.claudeDir });
  const targets = selectByCondition(sessions, options);

  if (!targets.length) {
    process.stdout.write('没有符合清理条件的会话\n');
    return;
  }

  if (!options.yes) {
    const lines = ['符合清理条件的会话 ' + targets.length + ' 个', ''];
    for (const session of targets) {
      const plan = cleaner.planCleanup({
        claudeDir: options.claudeDir,
        sessionId: session.id,
      });
      lines.push('  ' + store.formatDate(session.modified) + '  '
        + store.formatSize(session.size).padStart(7) + '  '
        + truncate(session.title || '(无标题)', 40) + '  '
        + session.id.slice(0, 8));
      if (plan.blocked) lines.push('      跳过：' + plan.blocked);
    }
    lines.push('');
    lines.push('AWAITING_CONFIRMATION');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const deleted = [];
  const errors = [];
  for (const session of targets) {
    const result = cleaner.executeCleanup({
      claudeDir: options.claudeDir,
      sessionId: session.id,
      dryRun: options.dryRun,
    });
    if (result.ok) deleted.push(session.id);
    else errors.push(...result.errors);
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ mode: 'cli', deleted, errors }) + '\n');
    return;
  }

  if (options.dryRun) {
    process.stdout.write('试运行，未删除任何文件\n');
    return;
  }

  process.stdout.write('已清理 ' + deleted.length + ' 个会话\n');
  if (errors.length) process.stdout.write('出错：\n' + errors.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// 版本与帮助
// ---------------------------------------------------------------------------

/**
 * 打印版本号
 */
function commandVersion() {
  process.stdout.write(VERSION + '\n');
}

/**
 * 打印帮助
 */
function commandHelp() {
  const lines = [
    'sessions-manager ' + VERSION + ' — A Claude Code session management cli tool',
    '',
    '用法',
    '  sessions-manager                    打开交互式会话浏览器',
    '',
    '选项',
    '  --list                              列出全部会话',
    '  --preview <会话ID>                  预览会话内容',
    '  --plan <会话ID>                     查看删除会波及哪些文件',
    '  --delete <会话ID>                   删除会话，两步确认',
    '  --older-than <时长>                 批量清理，如 7d 2w 3m',
    '  --smaller-than <体积>               批量清理，如 100K 5MB',
    '  --yes                              确认执行，跳过询问',
    '  --dry-run                          只演示不删除',
    '  --json                             输出结构化结果',
    '  --claude-dir <路径>                 指定 .claude 目录',
    '  --version, -v                      打印版本号',
    '  --help, -h                         打印本帮助',
    '',
    '交互界面按键',
    '  ↑ ↓ 选择    Enter 预览    Backspace 删除    Tab 筛选    输入搜索    Esc 退出',
    '',
    '删除是永久操作，不进回收站。共享的粘贴缓存与计划文件不会被删除',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const claudeDir = OPTION.claudeDir || store.claudeDir();

  if (OPTION.version) {
    commandVersion();
    return;
  }
  if (OPTION.help) {
    commandHelp();
    return;
  }
  if (OPTION.preview) {
    await commandPreview(OPTION.preview, { claudeDir });
    return;
  }
  if (OPTION.plan) {
    await commandPlan(OPTION.plan, { claudeDir });
    return;
  }
  if (OPTION.delete) {
    await commandDelete(OPTION.delete, {
      claudeDir,
      yes: OPTION.yes,
      dryRun: OPTION.dryRun,
      json: OPTION.json,
    });
    return;
  }
  if (OPTION.olderThan || OPTION.smallerThan) {
    await commandClean({
      claudeDir,
      yes: OPTION.yes,
      dryRun: OPTION.dryRun,
      json: OPTION.json,
      olderThan: OPTION.olderThan,
      smallerThan: OPTION.smallerThan,
    });
    return;
  }
  if (OPTION.list || OPTION.json || !hasTty()) {
    await commandList({ claudeDir, json: OPTION.json });
    return;
  }

  const result = await runInteractive({ claudeDir });
  if (result.deleted.length) {
    process.stdout.write('已删除 ' + result.deleted.length + ' 个会话，剩余 ' + result.remaining + ' 个\n');
  } else {
    process.stdout.write('会话浏览器已关闭，未做改动\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('会话管理出错：' + err.message + '\n');
    process.exit(1);
  });
}

module.exports = {
  main,
  commandVersion,
  commandHelp,
  VERSION,
  parseSize,
  parseDuration,
  applyFilter,
  selectByCondition,
  renderList,
  renderPreview,
  renderDeleteConfirm,
  truncate,
  visibleLength,
  hasTty,
  runInteractive,
  commandList,
  commandPreview,
  commandPlan,
  commandDelete,
  commandClean,
  findSession,
};
