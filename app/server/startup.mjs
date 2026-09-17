// 启动编排：确保 Edge 调试实例与 DSH 在跑；提供状态查询与「把界面开在受控 Edge 里」
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, PATHS, defaultEdgeProfile } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { runProcess } from './jobs.mjs';

const started = { edge: false, dsh: false };

export function portOpen(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function httpJson({ port, path: urlPath, method = 'GET', timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function getJson(url, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function findEdge() {
  const candidates = [
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || '';
}

/**
 * 解析可执行文件为 spawn 能直接用的形式。
 * Windows 上 .cmd/.bat 不能被 CreateProcess 直接执行（Node ≥20 报 spawn EINVAL），
 * 统一改为通过 cmd.exe /c 调用。
 *
 * ⚠️ 走 cmd.exe 时参数会**被 cmd 二次解析**（Node 只在参数含空格时才加引号），
 * 所以这里对含 cmd 元字符的参数直接拒绝（fail closed），避免命令注入。
 */
const CMD_META = /[&|<>^()"%!\r\n]/;

export function resolveCommand(command, args = []) {
  if (process.platform !== 'win32') return { command, args };
  const lower = String(command).toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    for (const arg of args) {
      if (CMD_META.test(String(arg))) {
        throw new Error('参数包含命令行特殊字符（& | < > ^ ( ) " % ! 换行），已拒绝以避免命令注入；'
          + '请改用不含这些字符的内容，或改用 node 直接调用入口。');
      }
    }
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  return { command, args };
}

/**
 * 找 npm 全局安装的 dsh 可执行入口。
 * 注意：直接用 dsh.cmd 会让参数再经 cmd.exe 解析一次（提示词里含 & | 等字符就是命令注入），
 * 所以优先返回「node + CLI 入口」这种不经 shell 的调用方式；找不到入口才退回 .cmd。
 * 可用环境变量 DSH_CLI_ENTRY 指定入口（自定义安装位置）。
 */
export function resolveDshInvocation(args = []) {
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  const entries = [
    process.env.DSH_CLI_ENTRY,
    npmDir && path.join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(Boolean);
  const entry = entries.find((file) => fs.existsSync(file));
  if (entry) return { command: process.execPath, args: [entry, ...args] };
  // 退路：仍然能跑，但 resolveCommand 会挡住含元字符的参数
  return resolveCommand(findDshCommand(), args);
}

/** 找 npm 全局安装的 dsh 可执行入口（.cmd/.ps1/.exe，仅作为退路使用） */
export function findDshCommand() {
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  const candidates = [
    npmDir && path.join(npmDir, 'dsh.cmd'),
    npmDir && path.join(npmDir, 'dsh.exe'),
    npmDir && path.join(npmDir, 'dsh.ps1'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || 'dsh';
}

async function spawnDetached(command, args, env = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid;
}

/** 确保 Edge 调试实例在跑；返回 {ok, running, started, port, version} */
export async function ensureEdge({ config } = {}) {
  const cfg = config || (await loadConfig());
  const port = Number(cfg.startup.cdpPort || 9222);
  if (await portOpen(port)) {
    let version = null;
    try {
      version = (await getJson(`http://127.0.0.1:${port}/json/version`))?.Browser || null;
    } catch { /* 端口通但取不到版本也能用 */ }
    return { ok: true, running: true, started: false, port, version };
  }

  const script = path.join(PROJECT_ROOT, PATHS.edgeLauncher);
  if (fs.existsSync(script)) {
    const job = runProcess({
      kind: 'launch-edge',
      title: '启动 Edge 调试实例',
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(port),
        ...(cfg.startup.edgeProfile ? ['-UserDataDir', cfg.startup.edgeProfile] : [])],
    });
    started.edgeJob = job.id;
  } else {
    // 没有脚本时退回直接启动 Edge（同样带调试端口与独立 profile）
    const edge = findEdge();
    if (!edge) return { ok: false, reason: '未找到 msedge.exe' };
    const profile = cfg.startup.edgeProfile || defaultEdgeProfile();
    await spawnDetached(edge, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--start-maximized',
    ]);
  }

  for (let i = 0; i < 30; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 700));
    // eslint-disable-next-line no-await-in-loop
    if (await portOpen(port)) {
      let version = null;
      try {
        version = (await getJson(`http://127.0.0.1:${port}/json/version`))?.Browser || null;
      } catch { /* ignore */ }
      started.edge = true;
      return { ok: true, running: true, started: true, port, version, jobId: started.edgeJob };
    }
  }
  return { ok: false, reason: '等待 Edge 调试端口超时（30 秒）', port, jobId: started.edgeJob };
}

/** 确保 DSH 在跑；返回 {ok, running, started, port, url} */
export async function ensureDsh({ config } = {}) {
  const cfg = config || (await loadConfig());
  const port = Number(cfg.startup.dshPort || 3080);
  if (await portOpen(port)) {
    return { ok: true, running: true, started: false, port, url: `http://127.0.0.1:${port}` };
  }
  const job = runProcess({
    kind: 'launch-dsh',
    title: '启动 DSH（web）',
    ...resolveDshInvocation(['--profile', 'web', '--port', String(port), '--no-open']),
    meta: { port },
  });
  started.dshJob = job.id;

  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 800));
    // eslint-disable-next-line no-await-in-loop
    if (await portOpen(port)) {
      started.dsh = true;
      return { ok: true, running: true, started: true, port, url: `http://127.0.0.1:${port}`, jobId: job.id };
    }
  }
  return { ok: false, reason: '等待 DSH 端口超时（32 秒）', port, jobId: job.id };
}

/** 按配置把两个服务拉起来（失败只记录，不阻塞界面） */
export async function bootstrap() {
  const config = await loadConfig();
  const result = { edge: null, dsh: null };
  if (config.startup.autoStartEdge) {
    try {
      result.edge = await ensureEdge({ config });
    } catch (err) {
      result.edge = { ok: false, reason: err.message };
    }
  }
  if (config.startup.autoStartDsh) {
    try {
      result.dsh = await ensureDsh({ config });
    } catch (err) {
      result.dsh = { ok: false, reason: err.message };
    }
  }
  return result;
}

export async function statusSnapshot() {
  const config = await loadConfig();
  const cdpPort = Number(config.startup.cdpPort || 9222);
  const dshPort = Number(config.startup.dshPort || 3080);
  const [edge, dsh] = await Promise.all([portOpen(cdpPort), portOpen(dshPort)]);
  let edgeVersion = null;
  if (edge) {
    try {
      edgeVersion = (await getJson(`http://127.0.0.1:${cdpPort}/json/version`))?.Browser || null;
    } catch { /* ignore */ }
  }
  return {
    edge: { running: edge, port: cdpPort, version: edgeVersion, startedByApp: started.edge },
    dsh: { running: dsh, port: dshPort, url: `http://127.0.0.1:${dshPort}`, startedByApp: started.dsh },
    edgeProfile: config.startup.edgeProfile || defaultEdgeProfile(),
  };
}

/**
 * 把界面开在「受控的 Edge 调试实例」里（就用采集的那个实例，一定能被看到）。
 * 拿不到调试实例时退回系统默认浏览器。
 */
export async function openUi(url, { cdpPort } = {}) {
  const port = Number(cdpPort || (await loadConfig()).startup.cdpPort || 9222);
  if (await portOpen(port)) {
    try {
      const target = await httpJson({ port, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' });
      if (target && (target.id || target.url)) {
        return { ok: true, via: 'cdp', url, targetId: target.id || '' };
      }
    } catch (err) {
      console.warn('[browser] CDP 新建标签页失败，改用系统默认浏览器：', err.message);
    }
  }
  openExternal(url);
  return { ok: true, via: 'default-browser', url };
}

/**
 * 打开一个「项目内相对路径」或绝对路径（资源管理器），或网址。
 * 关键点（前两版都踩过）：
 *  1) explorer 只接受绝对路径，早期直接传相对路径 → 什么都没发生；
 *  2) explorer/rundll32 都是"fire and forget"，出错也不返回；
 *     因此这里改用 ShellExecuteW（与双击行为一致）并检查返回值（>32 为成功）。
 */
function shellExecuteOpen(target) {
  const script = `
$ErrorActionPreference='Continue'
Add-Type -Namespace DshOpen -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr ShellExecuteW(IntPtr hwnd, string op, string file, string args, string dir, int show);'
$r = [DshOpen.Shell]::ShellExecuteW([IntPtr]::Zero, 'open', $env:DSH_OPEN_TARGET, $null, $null, 1)
[Console]::Out.Write([int64]$r)
`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_OPEN_TARGET: target },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `无法启动 powershell：${err.message}` });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, error: `powershell 进程错误：${e.message}` }));
    child.on('close', (code) => {
      const parsed = Number.parseInt(out.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 32) resolve({ ok: true, code: parsed });
      else {
        resolve({
          ok: false,
          error: `ShellExecuteW 失败（exit=${code}, out=${JSON.stringify(out.trim())}${err.trim() ? `, err=${err.trim().slice(0, 200)}` : ''}）`,
        });
      }
    });
  });
}

export async function openPath(target) {
  if (!target || typeof target !== 'string') return { ok: false, error: '路径为空' };

  // URL 也交给 ShellExecuteW（它能直接开默认浏览器），**不要**走 `cmd /c start`：
  // URL 是用户可控的，含 & | 等字符时会被 cmd 当成命令分隔符（命令注入）。
  if (/^https?:\/\//i.test(target)) {
    const viaShellUrl = await shellExecuteOpen(target);
    if (viaShellUrl.ok) return { ok: true, url: target, via: 'ShellExecuteW', code: viaShellUrl.code };
    return { ok: false, error: viaShellUrl.error };
  }

  const raw = target.replace(/\//g, path.sep);
  const abs = path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
  if (!fs.existsSync(abs)) return { ok: false, error: `路径不存在：${abs}` };

  const viaShell = await shellExecuteOpen(abs);
  if (viaShell.ok) {
    return { ok: true, path: abs, via: 'ShellExecuteW', code: viaShell.code };
  }

  // 兜底：交给 explorer / cmd start（不检查结果，但至少尽力打开）
  // 含 cmd 元字符的路径不使用 cmd 兜底，避免被当成命令分隔符
  try {
    if (fs.statSync(abs).isDirectory()) {
      spawn('explorer', [abs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (CMD_META.test(abs)) {
      return { ok: false, error: `${viaShell.error}（路径含命令行特殊字符，已跳过 cmd 兜底）` };
    } else {
      spawn('cmd', ['/c', 'start', '', abs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return { ok: true, path: abs, via: 'fallback', warning: viaShell.error };
  } catch (err) {
    return { ok: false, error: `打开失败：${err.message}（ShellExecuteW: ${viaShell.error}）` };
  }
}

/** 兼容旧调用名 */
export function openExternal(target) {
  return openPath(target);
}
