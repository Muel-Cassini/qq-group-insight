// AI 调用：OpenAI 兼容 / Anthropic 原生 / 常见厂家预设；含 token 估算、费用估算与流式输出
import { loadConfig, getSecret } from './config.mjs';

/** 预设：只提供地址与常用模型名，Key 一律由用户填 */
export const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek 官方', format: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'aliyun', name: '阿里云百炼（通义千问）', format: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'zhipu', name: '智谱 AI（GLM）', format: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash'] },
  { id: 'moonshot', name: 'Moonshot（Kimi）', format: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'openai', name: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  { id: 'anthropic', name: 'Anthropic（Claude）', format: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: 'ollama', name: '本地 Ollama', format: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:14b', 'llama3.1:8b'], noKey: true },
  { id: 'custom', name: '自定义（任意 OpenAI 兼容端点 / 中转站）', format: 'openai', baseUrl: '', models: [] },
];

export function listPresets() {
  return PRESETS;
}

/** 粗略 token 估算：中文按 1 字≈0.9 token，英文按 4 字符≈1 token，取折中系数 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 0.95 + rest / 3.2);
}

export function findProvider(config, providerId) {
  const id = providerId || config.ai.activeProviderId;
  return (config.ai.providers || []).find((item) => item.id === id) || null;
}

/** 解析某一步实际使用的 provider 与 model（支持按环节覆盖） */
export async function resolveTarget(step, overrideProviderId = '') {
  const config = await loadConfig();
  const override = (config.ai.perStep || {})[step] || '';
  let providerId = overrideProviderId || config.ai.activeProviderId;
  let model = '';
  if (override.includes('/')) {
    const [pid, mid] = override.split('/');
    providerId = pid;
    model = mid;
  } else if (override) {
    providerId = override;
  }
  const provider = findProvider(config, providerId);
  if (!provider) throw new Error('未配置 AI 服务：请到「设置」页添加一个服务并设为当前使用');
  return { config, provider, model: model || provider.defaultModel || (provider.models || [])[0] || '' };
}

export async function providerReady(provider) {
  if (!provider) return { ok: false, reason: '未选择服务' };
  if (!provider.baseUrl) return { ok: false, reason: '缺少 Base URL' };
  const preset = PRESETS.find((p) => p.id === provider.presetId);
  if (preset?.noKey) return { ok: true };
  const key = await getSecret(`provider:${provider.id}`);
  if (!key) return { ok: false, reason: '缺少 API Key（请到设置页填写）' };
  return { ok: true };
}

/** 计算费用（元）。priceBook: { models: { '模型名': {in, out} } } */
export function estimateCost(config, model, tokensIn, tokensOut) {
  const books = config.ai.priceBooks || [];
  const book = books.find((b) => b.name === config.ai.activePriceBook) || books[0];
  if (!book) return null;
  const price = (book.models || {})[model];
  if (!price) return null;
  const cost = (tokensIn / 1e6) * Number(price.in || 0) + (tokensOut / 1e6) * Number(price.out || 0);
  return { currency: book.currency || 'CNY', amount: Number(cost.toFixed(4)), model, book: book.name };
}

// ---------------------------------------------------------------- 调用

function buildRequest(provider, model, messages, { stream, maxTokens = 4096, temperature = 0.3 }) {
  const isAnthropic = provider.format === 'anthropic';
  if (isAnthropic) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    return {
      url: `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': '__KEY__',
        'anthropic-version': '2023-06-01',
      },
      body: { model, system, messages: rest, max_tokens: maxTokens, stream, temperature },
    };
  }
  return {
    url: `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: 'Bearer __KEY__' },
    body: { model, messages, stream, temperature, max_tokens: maxTokens },
  };
}

function extractDelta(provider, json) {
  if (provider.format === 'anthropic') {
    if (json.type === 'content_block_delta' && json.delta?.text) return json.delta.text;
    return '';
  }
  return json.choices?.[0]?.delta?.content || '';
}

function extractUsage(provider, json) {
  if (provider.format === 'anthropic') {
    const usage = json.usage || json.message?.usage;
    if (!usage) return null;
    return { in: usage.input_tokens || 0, out: usage.output_tokens || 0 };
  }
  const usage = json.usage;
  if (!usage) return null;
  return { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 };
}

/**
 * 调用一次对话补全。
 * @param {object} opts
 * @param {string} opts.step 环节名（keywords/classify/compare/summary）
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {object} [opts.job] 用于实时推送 token
 * @param {AbortSignal} [opts.signal]
 */
export async function chat(opts) {
  const { step, messages, job = null, signal = null, stream = true } = opts;
  const { config, provider, model } = await resolveTarget(step);
  const ready = await providerReady(provider);
  if (!ready.ok) throw new Error(ready.reason);

  const key = await getSecret(`provider:${provider.id}`);
  const req = buildRequest(provider, model, messages, { stream });
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k, String(v).replace('__KEY__', key)]),
  );

  const startedAt = Date.now();
  const promptText = messages.map((m) => m.content).join('\n');
  const estimatedIn = estimateTokens(promptText);
  if (job) {
    job.emit(`[AI] ${provider.name} / ${model} ｜ 预估输入 ${estimatedIn} token`, 'sys');
    job.setProgress({ phase: 'ai-call', model, provider: provider.name, estimatedIn });
  }

  const response = await fetch(req.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    signal: signal || undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${provider.name} 返回 HTTP ${response.status}：${text.slice(0, 400)}`);
  }

  let content = '';
  let usage = null;

  if (stream && response.body && response.headers.get('content-type')?.includes('event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = extractDelta(provider, json);
          if (delta) {
            content += delta;
            if (job) job.emit(delta.replace(/\n/g, ' ⏎ '), 'ai');
          }
          usage = extractUsage(provider, json) || usage;
        } catch { /* 忽略无法解析的分片 */ }
      }
    }
  } else {
    const json = await response.json();
    if (provider.format === 'anthropic') {
      content = (json.content || []).map((part) => part.text || '').join('');
      usage = extractUsage(provider, json);
    } else {
      content = json.choices?.[0]?.message?.content || '';
      usage = extractUsage(provider, json);
    }
    if (job && content) job.emit(content.replace(/\n/g, ' ⏎ '), 'ai');
  }

  const tokensIn = usage?.in || estimatedIn;
  const tokensOut = usage?.out || estimateTokens(content);
  const elapsedMs = Date.now() - startedAt;
  const cost = estimateCost(config, model, tokensIn, tokensOut);

  if (job) {
    job.emit(`[AI] 完成 ｜ 输入 ${tokensIn} / 输出 ${tokensOut} token ｜ 耗时 ${(elapsedMs / 1000).toFixed(1)}s`
      + (cost ? ` ｜ 约 ${cost.amount} ${cost.currency}` : ''), 'sys');
    job.setProgress({ phase: 'ai-done', model, tokensIn, tokensOut, elapsedMs, cost });
  }

  return { content, model, provider: provider.name, tokensIn, tokensOut, elapsedMs, cost, usage };
}

/** 发送前的预估（不真正调用） */
export async function preview(step, promptText, expectedOutTokens = 1500) {
  const { config, provider, model } = await resolveTarget(step);
  const tokensIn = estimateTokens(promptText);
  const cost = estimateCost(config, model, tokensIn, expectedOutTokens);
  return {
    provider: provider.name,
    model,
    chars: promptText.length,
    tokensIn,
    expectedOutTokens,
    cost,
    ready: (await providerReady(provider)).ok,
  };
}

/** 拉取模型列表（OpenAI 兼容 GET /models） */
export async function fetchModels(providerId) {
  const config = await loadConfig();
  const provider = findProvider(config, providerId);
  if (!provider) throw new Error('未找到该服务配置');
  const key = await getSecret(`provider:${provider.id}`);
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  const models = (json.data || json.models || []).map((item) => item.id || item.name).filter(Boolean);
  return models;
}
