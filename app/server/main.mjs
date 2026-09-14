// 入口：起服务 → 等端口就绪 → 确保 Edge 调试实例 → 把界面开在受控 Edge 里 → 确保 DSH
import { startServer } from './server.mjs';
import { bootstrap, portOpen, openUi } from './startup.mjs';
import { loadConfig } from './config.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import http from 'node:http';

/** 探测本项目是否已有控制台实例在跑（同端口 + /api/health 特征） */
function probeExistingInstance(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json?.ok && json?.data?.app === 'dsh-summary-app') {
            resolve({ url: `http://127.0.0.1:${port}/`, pid: json.data.pid ?? null });
            return;
          }
        } catch { /* 不是我们的服务 */ }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  const config = await loadConfig();
  const preferredPort = Number(config.server.port || 7801);

  // 已有实例检测：同一项目重复双击会让多个服务抢端口，界面可能连到旧代码的实例，
  // 表现为"改动不生效 / 按钮没反应"。这里直接复用已有实例，不再启动第二个。
  const existing = await probeExistingInstance(preferredPort);
  if (existing) {
    console.log('==============================================');
    console.log(' 检测到本项目已有一个控制台在运行，本次不再启动新实例。');
    console.log(` 请使用这个地址：${existing.url}`);
    console.log(' 如需重启：先关闭原来那个命令行窗口（或结束对应 node 进程）再双击启动。');
    console.log('==============================================');
    if (config.startup.openBrowser) {
      const opened = await openUi(existing.url, { cdpPort: config.startup.cdpPort });
      console.log(`[浏览器] 已在受控 Edge 里打开现有实例（${opened.via}）`);
    }
    return;
  }

  const { port, host } = await startServer();
  const url = `http://${host}:${port}/`;

  // 等服务真正可连接，避免「页面打不开」的竞态
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await portOpen(port, host, 300)) {
      ready = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log('==============================================');
  console.log(' 群聊汇总 × 社媒交叉比对 · 本地控制台已启动');
  console.log(` 界面地址：${url}`);
  console.log(` 项目根目录：${PROJECT_ROOT}`);
  console.log(` 端口就绪：${ready ? '是' : '否（请手动打开上面的地址）'}`);
  console.log(' 关闭本窗口即停止控制台（Edge 与 DSH 会继续运行）');
  console.log('==============================================');

  try {
    console.log('[启动] 正在确保 Edge 调试实例与 DSH…');
    const result = await bootstrap();
    if (result.edge) {
      console.log(`[启动] Edge 调试实例：${result.edge.ok
        ? `${result.edge.started ? '已启动' : '已在运行'}（${result.edge.version || `端口 ${result.edge.port}`}）`
        : `失败 - ${result.edge.reason}`}`);
    }
    if (result.dsh) {
      console.log(`[启动] DSH：${result.dsh.ok
        ? `${result.dsh.started ? '已启动' : '已在运行'}（${result.dsh.url}）`
        : `失败 - ${result.dsh.reason}`}`);
    }
    if (config.startup.openBrowser) {
      const opened = await openUi(url, { cdpPort: config.startup.cdpPort });
      console.log(opened.via === 'cdp'
        ? '[浏览器] 已在受控 Edge 实例中打开界面（就是那个自动弹出的 Edge 窗口）'
        : `[浏览器] 已用系统默认浏览器打开（若没反应，请手动访问 ${url}）`);
    } else {
      console.log(`[浏览器] 设置里已关闭「启动时打开浏览器」，请手动访问 ${url}`);
    }
  } catch (err) {
    console.warn('[启动] 自动拉起服务失败：', err.message);
    console.warn(`[提示] 你仍可手动打开 ${url} 使用界面。`);
  }

  process.on('SIGINT', () => {
    console.log('\n[退出] 已停止本地控制台（Edge 与 DSH 会继续运行）');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[致命错误]', err);
  console.error('常见原因：端口被占用、Node 版本过低（需 20+）、或 app 目录被移动导致路径失效。');
  process.exit(1);
});
