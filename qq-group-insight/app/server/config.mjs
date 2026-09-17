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

export async function loadConfig() {
  await ensureDirs();
  let stored = {};
  let existed = true;
  try {
    stored = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      existed = false;
    } else {
      console.warn('[config] 读取失败，使用默认值：', err.message);
    }
  }
  const config = migrate(deepMerge(DEFAULT_CONFIG, stored));
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
  await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
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
