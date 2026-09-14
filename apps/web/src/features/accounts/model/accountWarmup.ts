/**
 * 凭据预热（Warmup）核心模型与辅助方法
 * 包含：定时预热时间推断、立即预热推理请求封装、响应解析、配置持久化与模型候选列表
 */

import { apiCallApi, getApiCallErrorMessage, type ApiCallResult } from '@/services/api/apiCall';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isValidQuotaResetAtMs } from '@/utils/quota/formatters';
import type { AccountQuotaDisplayWindow } from './accountQuotaDisplayWindows';
import type { AccountRow } from './accountRows';

/** 默认预热 Prompt 发送内容 */
export const DEFAULT_WARMUP_PROMPT = 'ping';

/** 默认最大 Token 数 (max_tokens) */
export const DEFAULT_WARMUP_MAX_TOKENS = 16;

/** 默认推断延迟秒数 (主额度窗口重置后延迟执行，避免边界时差) */
export const DEFAULT_INFERRED_DELAY_SECONDS = 10;

/** 默认固定间隔分钟数 (1小时) */
export const DEFAULT_INTERVAL_MINUTES = 60;

/** localStorage 中保存全局默认 Prompt 的键名 */
export const WARMUP_PROMPT_STORAGE_KEY = 'cpamp_account_warmup_prompt_default';

/** localStorage 中保存各凭据预热配置的前缀 */
export const WARMUP_CONFIG_STORAGE_KEY_PREFIX = 'cpamp_account_warmup_config_';

/** localStorage 中保存预热历史记录的前缀 */
export const WARMUP_HISTORY_STORAGE_KEY_PREFIX = 'cpamp_account_warmup_history_';

/**
 * 预热调度模式
 * - inferred: 根据主额度窗口（如 5h 窗口）重置时间自动推断预热时间 (resetAtMs + 延迟)
 * - interval: 按照固定时间间隔周期性触发预热 (每隔 N 分钟)
 */
export type AccountWarmupMode = 'inferred' | 'interval';

/**
 * 单个凭据的预热配置
 */
export interface AccountWarmupConfig {
  /** 目标模型名称 */
  model: string;
  /** 发送内容 (Prompt)，默认 'ping' */
  prompt: string;
  /** 最大 Token 数 (max_tokens)，默认 16 */
  maxTokens: number;
  /** 调度模式：推断时间 or 固定间隔 */
  mode: AccountWarmupMode;
  /** 推断模式下，额度重置后的延迟执行秒数（默认 10 秒） */
  inferredDelaySeconds: number;
  /** 固定间隔模式下的间隔分钟数（默认 60 分钟） */
  intervalMinutes: number;
  /** 是否开启定时预热调度 */
  enabled: boolean;
  /** 可选的自定义请求 Endpoint URL */
  customEndpoint?: string;
}

/**
 * 预热执行单次记录
 */
export interface AccountWarmupRecord {
  /** 执行完成时的时间戳 (毫秒) */
  timestamp: number;
  /** HTTP 响应状态码 (如 200, 429, 500) */
  statusCode: number;
  /** 推理请求耗时 (毫秒) */
  durationMs: number;
  /** 模型返回内容摘录或错误消息摘要 */
  responseSnippet: string;
  /** 是否成功 (2xx 状态码且无致命网络异常) */
  success: boolean;
  /** 错误详情信息 (若失败) */
  errorMessage?: string;
  /** 执行请求时使用的模型 */
  model: string;
  /** 调度模式：'manual' (手动立即预热) | 'inferred' (定时推断) | 'interval' (定时固定间隔) */
  triggerSource: 'manual' | 'inferred' | 'interval';
}

/**
 * 预热推理执行结果返回对象
 */
export interface WarmupExecutionResult {
  /** 是否执行成功 */
  success: boolean;
  /** 响应状态码 */
  statusCode: number;
  /** 耗时毫秒数 */
  durationMs: number;
  /** 解析出的模型返回内容文字 */
  responseSnippet: string;
  /** 错误描述 */
  errorMessage?: string;
  /** 完整的底层 ApiCallResult 响应对象 */
  rawResult?: ApiCallResult;
}

/**
 * 各 Provider 默认推荐候选模型列表
 */
export const DEFAULT_WARMUP_MODELS_BY_PROVIDER: Record<string, string[]> = {
  codex: ['gpt-5-codex', 'gpt-5.3-codex-spark', 'gpt-5-mini', 'gpt-4o', 'chatgpt-4o-latest'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  claude: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  aistudio: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  xai: ['grok-4', 'grok-4.5-build-free', 'grok-beta'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'],
  qwen: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
};

/**
 * 获取指定 Provider 的默认推荐首选模型
 */
export function getDefaultWarmupModel(
  provider: string,
  dynamicModels?: Array<{ id: string; name?: string }>
): string {
  if (dynamicModels && dynamicModels.length > 0) {
    return dynamicModels[0].id;
  }
  const normalized = String(provider || '').trim().toLowerCase();
  const presets = DEFAULT_WARMUP_MODELS_BY_PROVIDER[normalized];
  if (presets && presets.length > 0) {
    return presets[0];
  }
  return 'gpt-4o-mini';
}

/**
 * 获取凭据可用的候选模型列表（合并动态获取与内置常用预设，去重）
 */
export function getWarmupCandidateModels(
  provider: string,
  dynamicModels?: Array<{ id: string; name?: string }>
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  // 优先添加动态获取到的凭证专属模型
  if (Array.isArray(dynamicModels)) {
    for (const item of dynamicModels) {
      const id = String(item.id || '').trim();
      if (id && !seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase());
        result.push(id);
      }
    }
  }

  // 补充 Provider 内置推荐模型
  const normalized = String(provider || '').trim().toLowerCase();
  const presets = DEFAULT_WARMUP_MODELS_BY_PROVIDER[normalized] || DEFAULT_WARMUP_MODELS_BY_PROVIDER.openai;
  for (const preset of presets) {
    if (!seen.has(preset.toLowerCase())) {
      seen.add(preset.toLowerCase());
      result.push(preset);
    }
  }

  return result;
}

/**
 * 依据凭据属性与 Provider 获取默认预热请求的 Endpoint
 */
export function getDefaultWarmupEndpoint(row: AccountRow): string {
  // 若凭证原始数据中存在显式指定的 base_url 或 endpoint，则以其为准
  const rawBase =
    (row.raw['base_url'] ||
      row.raw.baseUrl ||
      row.raw['endpoint'] ||
      row.raw.endpoint) as string | undefined;

  const normalized = String(row.provider || '').trim().toLowerCase();

  if (rawBase && typeof rawBase === 'string' && rawBase.trim()) {
    const trimmedBase = rawBase.trim().replace(/\/+$/g, '');
    if (normalized === 'claude') {
      if (trimmedBase.endsWith('/v1/messages')) return trimmedBase;
      if (trimmedBase.endsWith('/v1')) return `${trimmedBase}/messages`;
      return `${trimmedBase}/v1/messages`;
    }
    if (trimmedBase.endsWith('/chat/completions')) return trimmedBase;
    if (trimmedBase.endsWith('/v1')) return `${trimmedBase}/chat/completions`;
    return `${trimmedBase}/v1/chat/completions`;
  }

  // 默认官方公网端点 (由后端 CPA 代理请求并注入鉴权)
  switch (normalized) {
    case 'claude':
      return 'https://api.anthropic.com/v1/messages';
    case 'gemini':
    case 'aistudio':
      return 'https://generativelanguage.googleapis.com/v1beta/chat/completions';
    case 'xai':
      return 'https://api.x.ai/v1/chat/completions';
    case 'kimi':
      return 'https://api.moonshot.cn/v1/chat/completions';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    case 'codex':
    case 'openai':
    default:
      return 'https://api.openai.com/v1/chat/completions';
  }
}

/**
 * 从不同大模型 API 响应体中解析出可读的返回内容文本
 */
export function extractModelResponseContent(body: unknown, bodyText: string): string {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;

    // 1. OpenAI / OpenAI Compatible: choices[0].message.content
    if (Array.isArray(record.choices) && record.choices.length > 0) {
      const firstChoice = record.choices[0] as Record<string, unknown>;
      const message = firstChoice?.message as Record<string, unknown> | undefined;
      if (typeof message?.content === 'string') {
        return message.content.trim();
      }
      if (typeof firstChoice?.text === 'string') {
        return firstChoice.text.trim();
      }
    }

    // 2. Anthropic Claude: content[0].text
    if (Array.isArray(record.content) && record.content.length > 0) {
      const texts = record.content
        .map((part) => {
          if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
            return part.text;
          }
          return '';
        })
        .filter(Boolean);
      if (texts.length > 0) {
        return texts.join('\n').trim();
      }
    }

    // 3. Google Gemini / Vertex: candidates[0].content.parts[0].text
    if (Array.isArray(record.candidates) && record.candidates.length > 0) {
      const candidate = record.candidates[0] as Record<string, unknown>;
      const content = candidate?.content as Record<string, unknown> | undefined;
      if (Array.isArray(content?.parts)) {
        const parts = content.parts
          .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
          .filter(Boolean);
        if (parts.length > 0) {
          return parts.join('\n').trim();
        }
      }
    }

    // 4. Codex responses 接口: output[0].content[0].text
    if (Array.isArray(record.output) && record.output.length > 0) {
      const firstOut = record.output[0] as Record<string, unknown>;
      if (Array.isArray(firstOut.content)) {
        const texts = firstOut.content
          .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
          .filter(Boolean);
        if (texts.length > 0) {
          return texts.join('\n').trim();
        }
      }
    }

    // 5. 错误消息提炼
    if (record.error && typeof record.error === 'object') {
      const errObj = record.error as Record<string, unknown>;
      if (typeof errObj.message === 'string') return errObj.message.trim();
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
  }

  // 兜底返回原生 bodyText
  return String(bodyText ?? '').trim();
}

/**
 * 推断下次预热时间计算结果
 */
export interface InferredWarmupTimeResult {
  /** 推断出的下次预热时间戳 (毫秒)，为 null 表示未找到有效重置时间 */
  nextWarmupAtMs: number | null;
  /** 提取到的基础额度重置时间戳 (毫秒) */
  resetAtMs: number | null;
  /** 参考的额度窗口名称/说明 (如 "5小时窗口" 或 "主额度窗口") */
  sourceWindowLabel: string | null;
  /** 是否重置时间仍在未来 (若在过去，说明额度可能已到期但未刷新) */
  isFuture: boolean;
}

/**
 * 自动读取凭据的主额度窗口重置时间（例如 5h 窗口的 resetAtMs），计算并展示推断出的下次预热时间 (resetAtMs + 延迟)
 *
 * 查找优先级：
 * 1. 处于未来的 5 小时主额度窗口 (five_hour 且 resetAtMs > now)
 * 2. 处于未来的其它额度窗口 (resetAtMs > now，取最近的一个)
 * 3. row.quota.resetAtMs 处于未来 (resetAtMs > now)
 * 4. 若无未来时间，优先选择 five_hour 窗口（即便处于过去，标记 isFuture: false 供用户参考并提示刷新）
 * 5. 若无 five_hour 窗口，选择任意有效重置窗口或 row.quota.resetAtMs (标记 isFuture: false)
 */
export function inferNextWarmupTime(
  row: AccountRow,
  delaySeconds: number,
  quotaWindows?: AccountQuotaDisplayWindow[]
): InferredWarmupTimeResult {
  const now = Date.now();
  const safeDelayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;

  let targetResetAtMs: number | null = null;
  let targetWindowLabel: string | null = null;

  if (Array.isArray(quotaWindows) && quotaWindows.length > 0) {
    // 优先 1：查找未来有效的 five_hour 类型的窗口 (Codex / Claude 核心重置窗口)
    const futureFiveHourWindow = quotaWindows.find(
      (w) =>
        w.kind === 'five_hour' &&
        isValidQuotaResetAtMs(w.resetAtMs) &&
        (w.resetAtMs as number) > now
    );
    if (futureFiveHourWindow && typeof futureFiveHourWindow.resetAtMs === 'number') {
      targetResetAtMs = futureFiveHourWindow.resetAtMs;
      targetWindowLabel = futureFiveHourWindow.label || '5小时窗口';
    } else {
      // 优先 2：寻找距离当前时间最近的未来重置窗口
      const futureWindows = quotaWindows
        .filter((w) => isValidQuotaResetAtMs(w.resetAtMs) && (w.resetAtMs as number) > now)
        .sort((a, b) => (a.resetAtMs as number) - (b.resetAtMs as number));

      if (futureWindows.length > 0 && typeof futureWindows[0].resetAtMs === 'number') {
        targetResetAtMs = futureWindows[0].resetAtMs;
        targetWindowLabel = futureWindows[0].label || '额度窗口';
      }
    }
  }

  // 优先 3：若未从 windows 查到未来窗口，检查 row.quota.resetAtMs 是否处于未来
  if (
    targetResetAtMs === null &&
    isValidQuotaResetAtMs(row.quota.resetAtMs) &&
    (row.quota.resetAtMs as number) > now
  ) {
    targetResetAtMs = row.quota.resetAtMs as number;
    targetWindowLabel = row.quota.resetLabel || '额度重置窗口';
  }

  // 降级兜底 4：若所有窗口均未在未来（已过期或未刷新），优先查找 five_hour 窗口
  if (targetResetAtMs === null && Array.isArray(quotaWindows) && quotaWindows.length > 0) {
    const pastFiveHourWindow = quotaWindows.find(
      (w) => w.kind === 'five_hour' && isValidQuotaResetAtMs(w.resetAtMs)
    );
    if (pastFiveHourWindow && typeof pastFiveHourWindow.resetAtMs === 'number') {
      targetResetAtMs = pastFiveHourWindow.resetAtMs;
      targetWindowLabel = pastFiveHourWindow.label || '5小时窗口';
    } else {
      // 降级兜底 5：取有效窗口
      const anyValidWindow = quotaWindows.find((w) => isValidQuotaResetAtMs(w.resetAtMs));
      if (anyValidWindow && typeof anyValidWindow.resetAtMs === 'number') {
        targetResetAtMs = anyValidWindow.resetAtMs;
        targetWindowLabel = anyValidWindow.label || '额度窗口';
      }
    }
  }

  // 降级兜底 6：检查 row.quota.resetAtMs（哪怕在过去）
  if (targetResetAtMs === null && isValidQuotaResetAtMs(row.quota.resetAtMs)) {
    targetResetAtMs = row.quota.resetAtMs as number;
    targetWindowLabel = row.quota.resetLabel || '额度重置窗口';
  }

  if (targetResetAtMs === null) {
    return {
      nextWarmupAtMs: null,
      resetAtMs: null,
      sourceWindowLabel: null,
      isFuture: false,
    };
  }

  const isFuture = targetResetAtMs > now;
  const nextWarmupAtMs = targetResetAtMs + safeDelayMs;

  return {
    nextWarmupAtMs,
    resetAtMs: targetResetAtMs,
    sourceWindowLabel: targetWindowLabel,
    isFuture,
  };
}

/**
 * 读取用户持久化保存的发送内容 (Prompt)，未修改时默认返回 'ping'
 */
export function loadWarmupPrompt(): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_WARMUP_PROMPT;
  }
  try {
    const val = window.localStorage.getItem(WARMUP_PROMPT_STORAGE_KEY);
    return val !== null && val !== undefined && val.trim() !== '' ? val : DEFAULT_WARMUP_PROMPT;
  } catch {
    return DEFAULT_WARMUP_PROMPT;
  }
}

/**
 * 持久化保存用户修改的 Prompt 内容
 */
export function saveWarmupPrompt(prompt: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const val = typeof prompt === 'string' ? prompt : DEFAULT_WARMUP_PROMPT;
    window.localStorage.setItem(WARMUP_PROMPT_STORAGE_KEY, val);
  } catch {
    // 忽略 localStorage 写入错误
  }
}

/**
 * 获取持久化存储的特定凭据预热配置
 */
export function loadAccountWarmupConfig(
  accountKey: string,
  provider: string,
  dynamicModels?: Array<{ id: string; name?: string }>
): AccountWarmupConfig {
  const defaultModel = getDefaultWarmupModel(provider, dynamicModels);
  const defaultPrompt = loadWarmupPrompt();

  const fallback: AccountWarmupConfig = {
    model: defaultModel,
    prompt: defaultPrompt,
    maxTokens: DEFAULT_WARMUP_MAX_TOKENS,
    mode: 'inferred',
    inferredDelaySeconds: DEFAULT_INFERRED_DELAY_SECONDS,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    enabled: false,
  };

  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(`${WARMUP_CONFIG_STORAGE_KEY_PREFIX}${accountKey}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AccountWarmupConfig>;
    return {
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : defaultModel,
      prompt: typeof parsed.prompt === 'string' && parsed.prompt.trim() ? parsed.prompt : defaultPrompt,
      maxTokens:
        typeof parsed.maxTokens === 'number' && parsed.maxTokens > 0
          ? parsed.maxTokens
          : DEFAULT_WARMUP_MAX_TOKENS,
      mode: parsed.mode === 'interval' ? 'interval' : 'inferred',
      inferredDelaySeconds:
        typeof parsed.inferredDelaySeconds === 'number' && parsed.inferredDelaySeconds >= 0
          ? parsed.inferredDelaySeconds
          : DEFAULT_INFERRED_DELAY_SECONDS,
      intervalMinutes:
        typeof parsed.intervalMinutes === 'number' && parsed.intervalMinutes > 0
          ? parsed.intervalMinutes
          : DEFAULT_INTERVAL_MINUTES,
      enabled: Boolean(parsed.enabled),
      customEndpoint:
        typeof parsed.customEndpoint === 'string' && parsed.customEndpoint.trim()
          ? parsed.customEndpoint.trim()
          : undefined,
    };
  } catch {
    return fallback;
  }
}

/**
 * 持久化保存特定凭据的预热配置
 */
export function saveAccountWarmupConfig(accountKey: string, config: AccountWarmupConfig): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      `${WARMUP_CONFIG_STORAGE_KEY_PREFIX}${accountKey}`,
      JSON.stringify(config)
    );
  } catch {
    // 忽略 localStorage 写入错误
  }
}

/**
 * 加载特定凭据的历史预热记录
 */
export function loadWarmupHistory(accountKey: string): AccountWarmupRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(`${WARMUP_HISTORY_STORAGE_KEY_PREFIX}${accountKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 保存预热单次记录（最多保留最近 20 条）
 */
export function saveWarmupRecord(accountKey: string, record: AccountWarmupRecord): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const existing = loadWarmupHistory(accountKey);
    const updated = [record, ...existing].slice(0, 20);
    window.localStorage.setItem(
      `${WARMUP_HISTORY_STORAGE_KEY_PREFIX}${accountKey}`,
      JSON.stringify(updated)
    );
  } catch {
    // 忽略写入错误
  }
}

/**
 * 构建请求体与请求头
 */
export function buildWarmupPayload(
  provider: string,
  endpoint: string,
  model: string,
  prompt: string,
  maxTokens: number
): { header: Record<string, string>; data: string } {
  const normalized = String(provider || '').trim().toLowerCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer $TOKEN$',
  };

  // Claude 专属 header
  if (normalized === 'claude' || endpoint.includes('/messages')) {
    headers['x-api-key'] = '$TOKEN$';
    headers['anthropic-version'] = '2023-06-01';
  }

  // Claude /messages 格式
  if (endpoint.includes('/messages')) {
    return {
      header: headers,
      data: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    };
  }

  // Codex /responses 格式
  if (endpoint.includes('/responses')) {
    return {
      header: headers,
      data: JSON.stringify({
        model,
        input: prompt,
        stream: false,
      }),
    };
  }

  // 默认 OpenAI /chat/completions 格式
  return {
    header: headers,
    data: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    }),
  };
}

/**
 * 执行凭据推理预热请求
 */
export async function executeWarmupInference(
  row: AccountRow,
  config: AccountWarmupConfig
): Promise<WarmupExecutionResult> {
  const authIndex = normalizeAuthIndex(row.raw['auth_index'] ?? row.raw.authIndex ?? row.authIndex);
  const endpoint = config.customEndpoint?.trim() || getDefaultWarmupEndpoint(row);
  const model = config.model.trim() || getDefaultWarmupModel(row.provider);
  const prompt = config.prompt.trim() || DEFAULT_WARMUP_PROMPT;
  const maxTokens = config.maxTokens > 0 ? config.maxTokens : DEFAULT_WARMUP_MAX_TOKENS;

  const { header, data } = buildWarmupPayload(row.provider, endpoint, model, prompt, maxTokens);

  const startTime = performance.now();
  let statusCode = 0;
  let responseSnippet = '';
  let errorMessage: string | undefined;
  let rawResult: ApiCallResult | undefined;

  try {
    const result = await apiCallApi.request(
      {
        authIndex: authIndex || undefined,
        method: 'POST',
        url: endpoint,
        header,
        data,
      },
      { timeout: 30000 }
    );

    const durationMs = Math.round(performance.now() - startTime);
    rawResult = result;
    statusCode = result.statusCode;

    if (result.statusCode >= 200 && result.statusCode < 300) {
      responseSnippet = extractModelResponseContent(result.body, result.bodyText);
      return {
        success: true,
        statusCode,
        durationMs,
        responseSnippet: responseSnippet || '(OK)',
        rawResult,
      };
    }

    errorMessage = getApiCallErrorMessage(result);
    responseSnippet = extractModelResponseContent(result.body, result.bodyText) || errorMessage;
    return {
      success: false,
      statusCode,
      durationMs,
      responseSnippet,
      errorMessage,
      rawResult,
    };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - startTime);
    errorMessage = err instanceof Error ? err.message : 'Unknown network error';
    return {
      success: false,
      statusCode: statusCode || 0,
      durationMs,
      responseSnippet: errorMessage,
      errorMessage,
    };
  }
}
