// 路径与配置：所有可调项集中在这里，其余模块只读它。
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 应用根目录 = app/ */
export const APP_DIR = path.resolve(__dirname, '..');
/** 项目根目录 = app/ 的上一级（技能脚本、tools、data、artifacts 都在这一级） */
export const PROJECT_ROOT = path.resolve(APP_DIR, '..');
/** 运行时私有目录（配置、密钥、任务日志） */
export const LOCAL_DIR = path.join(APP_DIR, '.local');
export const CONFIG_FILE = path.join(LOCAL_DIR, 'config.json');
export const SECRETS_DIR = path.join(LOCAL_DIR, 'secrets');
export const JOBS_DIR = path.join(LOCAL_DIR, 'jobs');

export const WEB_DIR = path.join(APP_DIR, 'web');
export const SERVER_DIR = __dirname;

/** 技能与工具的相对位置（都相对 PROJECT_ROOT） */
export const PATHS = {
  venvPython: '.venv/Scripts/python.exe',
  mediaCrawler: 'tools/MediaCrawler',
  qqDigest: '.agents/skills/qq-group-summary/scripts/qq_group_digest.py',
  qqCacheJson: '.agents/skills/qq-group-summary/config.json',
  crawl: '.agents/skills/social-crawl/scripts/crawl.py',
  crawlConfig: '.agents/skills/social-crawl/config.json',
  compare: '.agents/skills/cross-compare/scripts/compare.py',
  compareConfig: '.agents/skills/cross-compare/config.json',
  edgeLauncher: 'tools/launch-edge-cdp.ps1',
  exports: 'data/qq-chat-exporter/exports',
  scheduledExports: 'data/qq-chat-exporter/scheduled-exports',
  exportsArchive: 'data/qq-chat-exporter/archive',
  outQq: 'artifacts/qq',
  outSocial: 'artifacts/social',
  outCompare: 'artifacts/compare',
  outSummary: 'artifacts/summary',
  outKeywords: 'artifacts/keywords',
  outUploads: 'artifacts/uploads',
  outDocs: 'artifacts/docs',
  samples: 'artifacts/_samples',
};

/** 默认配置（首次启动写入 .local/config.json；之后以文件为准） */
export const DEFAULT_CONFIG = {
  server: { port: 7801, portScanRange: 20, host: '127.0.0.1' },
  startup: {
    openBrowser: true,
    autoStartEdge: true,   // 启动时自动确保 Edge 调试实例在跑
    autoStartDsh: true,    // 启动时自动确保 DSH 在跑
    dshPort: 3080,
    cdpPort: 9222,
    edgeProfile: '',       // 空 = %LOCALAPPDATA%\dsh-edge-cdp
  },
  ai: {
    activeProviderId: '',
    perStep: { keywords: '', classify: '', compare: '', summary: '' }, // provider/model 覆盖，留空用活动配置
    priceBooks: [],        // [{ name, currency:'CNY', models: { '模型名': { in: 元/百万token, out: 元/百万token } } }]
    activePriceBook: '',
    confirmBeforeSend: true,
    maxCharsPerCall: 24000,
  },
  classify: {
    mode: 'script-then-ai', // script-only | script-then-ai
    batchSize: 40,
  },
  collect: { defaultLimit: 20, defaultComments: 20, platforms: ['xhs', 'zhihu', 'bili'] },
  // 可保存/复用的提示词模板（目前用于「⑤ 文件汇总」）
  prompts: {
    docSummary: [],   // [{ id, name, style, focus }]
  },
  // 聊天记录读取位置：留空 = 用项目内默认目录；也可填绝对路径（例如 D:\QQChatExporter\exports）
  paths: { exportsDir: '', scheduledExportsDir: '' },
  summarize: {
    engine: 'dsh',         // dsh | api | prompt
    deepMode: false,
    chunkByDay: true,
    style: '',
    focus: '',
  },
  ui: { lang: 'zh-CN', theme: 'auto' },
};

export function defaultEdgeProfile() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(base, 'dsh-edge-cdp');
}
