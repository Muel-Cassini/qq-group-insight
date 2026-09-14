// 平台登录：在**采集实例**里打开登录页 / 检测登录态
//
// 关键设计：登录与检测都发生在采集实例（crawlPort + crawlProfile），
// 所以你在「⑥ 设置」点「打开登录页」时，弹出的是采集窗口，**不会打断你看界面的那个窗口**。
import { loadConfig } from './config.mjs';
import { ensureCrawlEdge, edgeInstance, openCdpTab } from './startup.mjs';
import { startLoginCheckJob, parseLoginResult } from './keyword-verify.mjs';
import { platformMeta, DEFAULT_LOGIN_PLATFORMS } from './platforms.mjs';

/** 上一次检测结果缓存（检测要跑十几秒，不适合每次进页面都重跑） */
let lastStatus = null;

export function cachedLoginStatus() {
  return lastStatus;
}

/** 采集实例的当前状态（端口/profile/是否在跑） */
export async function crawlBrowserStatus() {
  const cfg = await loadConfig();
  const inst = await edgeInstance('crawl', { config: cfg });
  const ui = await edgeInstance('ui', { config: cfg });
  let running = false;
  let version = null;
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/json/version`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      running = true;
      version = (await res.json())?.Browser || null;
    }
  } catch { /* 没起来很正常 */ }
  return {
    crawl: { running, port: inst.port, profile: inst.profile, version },
    ui: { port: ui.port, profile: ui.profile },
    platforms: DEFAULT_LOGIN_PLATFORMS.map((code) => {
      const meta = platformMeta(code);
      return { code, name: meta.name, loginUrl: meta.loginUrl, homeUrl: meta.homeUrl };
    }),
    lastStatus,
  };
}

/** 起一次登录态检测（子任务，界面上看日志/进度） */
export async function startLoginStatusCheck({ platforms = DEFAULT_LOGIN_PLATFORMS } = {}) {
  const list = (Array.isArray(platforms) && platforms.length ? platforms : DEFAULT_LOGIN_PLATFORMS)
    .filter((code) => platformMeta(code).loginUrl);
  const job = await startLoginCheckJob({ platforms: list });
  job.onFinish = () => {
    const parsed = parseLoginResult(job);
    lastStatus = {
      at: Date.now(),
      port: job.meta?.port || 0,
      ok: parsed.ok,
      error: parsed.error || '',
      platforms: parsed.platforms,
    };
    const parts = list.map((code) => {
      const info = parsed.platforms?.[code];
      return `${platformMeta(code).name}：${info?.loggedIn ? '已登录' : `未登录（${info?.reason || '未知'}）`}`;
    });
    job.emit(`[登录状态] ${parts.join(' ｜ ')}`, parsed.ok ? 'sys' : 'err');
  };
  return job;
}

/** 在采集实例里打开某个平台的登录页（未登录时会自然落到登录界面） */
export async function openLoginPage({ platform }) {
  const meta = platformMeta(platform);
  if (!meta.loginUrl) throw new Error(`未知平台：${platform}`);
  const cfg = await loadConfig();
  const inst = await edgeInstance('crawl', { config: cfg });
  const edge = await ensureCrawlEdge({ config: cfg });
  if (!edge.ok) throw new Error(`采集用的 Edge 实例不可用：${edge.reason || '未知原因'}`);
  const tab = await openCdpTab(inst.port, meta.loginUrl);
  return {
    ok: true, platform, name: meta.name, url: meta.loginUrl,
    port: inst.port, started: edge.started, targetId: tab?.id || '',
  };
}
