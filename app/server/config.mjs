// 配置读写 + 密钥存储（密钥用 Windows DPAPI 按当前用户加密，落盘为不可读的二进制块）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  LOCAL_DIR, CONFIG_FILE, SECRETS_DIR, DEFAULT_CONFIG, PROJECT_ROOT, PATHS,
} from './paths.mjs';

const secretCache = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：array 直接覆盖，对象递归合并 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

export async function ensureDirs() {
  for (const dir of [LOCAL_DIR, SECRETS_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

function migrate(config) {
  if (!Array.isArray(config.ai.priceBooks)) config.ai.priceBooks = [];
  if (!config.ai.perStep) config.ai.perStep = { keywords: '', classify: '', compare: '', summary: '' };
  return config;
}

/**
 * 内存里最后一次**成功读到**的配置。
 * 注意：只有在解析成功时才会更新它 —— 绝不把"回退出来的默认配置"缓存成"好配置"，
 * 否则 saveConfig 会以默认配置为基准合并并写盘，一次保存就把用户的服务全抹掉。
 */
let lastGoodConfig = null;

export async function loadConfig() {
  await ensureDirs();
  let stored = null;
  let existed = true;
  const readOnce = async () => JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  try {
    stored = await readOnce();
  } catch (err) {
    if (err.code === 'ENOENT') {
      existed = false;
      stored = {};
    } else {
      // 解析/读取失败：很可能是"写文件的瞬间读到了半截内容"，或文件被短暂占用。
      // 重试一次；仍失败时：
      //   · 有上次成功读到的配置 → 用它（应用继续正常工作）
      //   · 没有 → **抛错，不要静默回退默认配置**（否则界面显示成"未配置"，
      //     更糟的是 saveConfig 会拿默认值当基准写盘，把用户的配置抹掉）
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        stored = await readOnce();
      } catch (err2) {
        console.warn('[config] 读取失败：', err2.message);
        if (lastGoodConfig) {
          console.warn('[config] 已沿用内存中上一次成功读取的配置');
          return lastGoodConfig;
        }
        throw new Error(`配置文件无法解析：${CONFIG_FILE}（${err2.message}）。`
          + '请检查该文件是否为合法 JSON；如果确认损坏，可删除它让应用重新生成默认配置。');
      }
    }
  }
  const config = migrate(deepMerge(DEFAULT_CONFIG, stored));
  lastGoodConfig = config;
  // 首次运行时把默认配置落盘，便于用户直接编辑与排查
  if (!existed) {
    try {
      await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      console.log(`[config] 已生成默认配置：${CONFIG_FILE}`);
    } catch (err) {
      console.warn('[config] 写入默认配置失败：', err.message);
    }
  }
  return config;
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = migrate(deepMerge(current, patch));
  await ensureDirs();
  // ★ 原子写：先写临时文件再改名替换。
  // 直接 writeFile 会先截断文件，并发读（界面刷新、另一个页面动作）可能读到半截 JSON，
  // 于是配置瞬间"变空"——表现为服务列表空了、AI 显示未配置。
  const tmp = `${CONFIG_FILE}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, CONFIG_FILE);
  lastGoodConfig = next;
  return next;
}

export function projectPath(rel) {
  return path.join(PROJECT_ROOT, rel);
}

export function pathExists(rel) {
  return fs.existsSync(projectPath(rel));
}

/** 找一个可用的 python：优先项目 .venv，其次 PATH 上的 python */
export function pythonPath() {
  const venv = projectPath(PATHS.venvPython);
  return fs.existsSync(venv) ? venv : 'python';
}

// ---------------------------------------------------------------- 密钥（DPAPI）

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `powershell exit ${code}`))));
    child.stdin.end(input ?? '');
  });
}

const PS_ENCRYPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$blob  = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($blob))
`;

const PS_DECRYPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd()
$blob = [Convert]::FromBase64String($b64.Trim())
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

function secretFile(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(SECRETS_DIR, `${safe}.bin`);
}

/** 写入密钥（DPAPI 当前用户加密） */
export async function setSecret(id, value) {
  await ensureDirs();
  if (!value) {
    await deleteSecret(id);
    secretCache.delete(id);
    return { ok: true, cleared: true };
  }
  const blob = await runPowerShell(PS_ENCRYPT, String(value));
  await fsp.writeFile(secretFile(id), blob, 'utf8');
  secretCache.set(id, String(value));
  return { ok: true, bytes: blob.length };
}

/** 读取密钥（内存缓存） */
export async function getSecret(id) {
  if (secretCache.has(id)) return secretCache.get(id);
  const file = secretFile(id);
  if (!fs.existsSync(file)) return '';
  try {
    const blob = (await fsp.readFile(file, 'utf8')).trim();
    const plain = await runPowerShell(PS_DECRYPT, blob);
    secretCache.set(id, plain);
    return plain;
  } catch (err) {
    console.warn(`[secret] 解密 ${id} 失败：`, err.message);
    return '';
  }
}

export async function deleteSecret(id) {
  secretCache.delete(id);
  await fsp.rm(secretFile(id), { force: true });
  return { ok: true };
}

/** 是否已配置（只判断文件存在，不解密、不泄露内容） */
export function hasSecret(id) {
  return fs.existsSync(secretFile(id));
}
