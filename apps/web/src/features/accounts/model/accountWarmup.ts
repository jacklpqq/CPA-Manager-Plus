/**
 * 凭据预热（Warmup）核心模型与辅助方法
 * 包含：定时预热时间推断、立即预热推理请求封装、响应解析、配置持久化与模型候选列表
 */

import { apiCallApi, getApiCallErrorMessage, type ApiCallResult } from '@/services/api/apiCall';
import { authFilesApi, type AuthFilesApiRequestScope } from '@/services/api/authFiles';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isValidQuotaResetAtMs } from '@/utils/quota/formatters';
import {
  buildAccountModelRuleProjection,
  matchesAccountModelRule,
} from './accountModelRules';
import {
  normalizeExcludedModels,
  normalizeProviderKey,
  parseExcludedModelsText,
  type AuthFileModelItem,
} from '@/features/authFiles/constants';
import { getAuthFilePatchTarget } from '@/features/authFiles/model/credentialStatus';
import {
  buildClaudeMessagesEndpoint,
  buildCodexResponsesEndpoint,
} from '@/components/providers/utils';
import type { AuthFileItem } from '@/types';
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

/** 默认期望窗口重置时间 (每日 09:20，以便在早间工作高峰拥有全新额度) */
export const DEFAULT_TARGET_RESET_TIME = '09:20';

/** 默认提前预热时长 (小时，默认 5 小时对应 Codex / Claude 等常见 5h 滚动额度窗口) */
export const DEFAULT_TARGET_LEAD_HOURS = 5;

/** localStorage 中保存全局默认 Prompt 的键名 */
export const WARMUP_PROMPT_STORAGE_KEY = 'cpamp_account_warmup_prompt_default';

/** localStorage 中保存各凭据预热配置的前缀 */
export const WARMUP_CONFIG_STORAGE_KEY_PREFIX = 'cpamp_account_warmup_config_';

/** localStorage 中保存预热历史记录的前缀 */
export const WARMUP_HISTORY_STORAGE_KEY_PREFIX = 'cpamp_account_warmup_history_';

/**
 * 预热调度模式
 * - inferred: 根据主额度窗口（如 5h 窗口）重置时间自动推断预热时间 (resetAtMs + 延迟)
 * - target_reset: 依据用户指定的每日窗口重置时间点（如 09:20），根据凭证刷新时间自动提前指定小时数（如 5H）预热
 * - interval: 按照固定时间间隔周期性触发预热 (每隔 N 分钟)
 */
export type AccountWarmupMode = 'inferred' | 'target_reset' | 'interval';

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
  /** 调度模式：推断时间 or 目标重置时间 or 固定间隔 */
  mode: AccountWarmupMode;
  /** 推断模式下，额度重置后的延迟执行秒数（默认 10 秒） */
  inferredDelaySeconds: number;
  /** 固定间隔模式下的间隔分钟数（默认 60 分钟） */
  intervalMinutes: number;
  /** 是否开启定时预热调度 */
  enabled: boolean;
  /** 可选的自定义请求 Endpoint URL */
  customEndpoint?: string;
  /** 目标重置时间模式下的每日期望重置时间 (格式 "HH:mm"，例如 "09:20") */
  targetResetTime?: string;
  /** 目标重置时间模式下的提前预热时长 (小时，例如提前 5 小时预热)，默认 5 */
  targetLeadHours?: number;
}

/** 预热触发来源类型 */
export type WarmupTriggerSource = 'manual' | 'inferred' | 'target_reset' | 'interval';

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
  /** 调度模式：'manual' (手动立即预热) | 'inferred' (定时推断) | 'target_reset' (目标重置时间提前预热) | 'interval' (定时固定间隔) */
  triggerSource: WarmupTriggerSource;
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
 * 从凭据行或 AuthFileItem 提取排除模型列表 (excluded-models)
 */
export function extractExcludedModelsFromRow(rowOrFile?: AccountRow | AuthFileItem | null): string[] {
  if (!rowOrFile || typeof rowOrFile !== 'object') return [];
  const rawRecord = ('raw' in rowOrFile && rowOrFile.raw
    ? rowOrFile.raw
    : rowOrFile) as Record<string, unknown> | null | undefined;
  if (!rawRecord) return [];
  const excluded = rawRecord['excluded-models'] ?? rawRecord.excludedModels ?? rawRecord.excluded_models;
  if (Array.isArray(excluded)) {
    return normalizeExcludedModels(excluded.map(String));
  }
  if (typeof excluded === 'string') {
    return parseExcludedModelsText(excluded);
  }
  return [];
}

/**
 * 从凭据行或 AuthFileItem 提取前缀 (prefix)
 */
export function extractPrefixFromRow(rowOrFile?: AccountRow | AuthFileItem | null): string {
  if (!rowOrFile || typeof rowOrFile !== 'object') return '';
  const rawRecord = ('raw' in rowOrFile && rowOrFile.raw
    ? rowOrFile.raw
    : rowOrFile) as Record<string, unknown> | null | undefined;
  const prefix = rawRecord?.prefix;
  return typeof prefix === 'string' ? prefix.trim().replace(/\/+$/g, '') : '';
}

/**
 * 候选模型筛选与解析配置项
 */
export interface WarmupCandidateModelsOptions {
  /** 可选的前缀字符串 (如 "pqq") */
  prefix?: string;
  /** 可选的排除模型模式数组 (如 ["o1-preview", "gpt-4*"]) */
  excludedModels?: string[];
  /** 目标凭据行 (自动解析 prefix 与 excluded-models) */
  row?: AccountRow | null;
}

/**
 * 获取指定 Provider 的默认推荐首选模型
 * 优先采用动态可用模型列表的第一个，其次按 Provider 推荐，最后兜底
 */
export function getDefaultWarmupModel(
  provider: string,
  dynamicModels?: Array<{ id: string; name?: string }>,
  options?: WarmupCandidateModelsOptions
): string {
  const normalized = String(provider || '').trim().toLowerCase();
  // 若有动态模型或显式配置的已知 provider，使用候选列表首项
  if ((dynamicModels && dynamicModels.length > 0) || DEFAULT_WARMUP_MODELS_BY_PROVIDER[normalized]) {
    const candidates = getWarmupCandidateModels(provider, dynamicModels, options);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  return 'gpt-4o-mini';
}

/**
 * 获取凭据可用的候选模型列表
 *
 * 核心设计（代码即文档）：
 * 1. 优先采用从凭证动态获取的真实模型列表 (dynamicModels)
 * 2. 结合凭证的 prefix 配置，若列表中尚未包含带前缀版本，自动补充带前缀的真实可用模型供用户选择
 * 3. 结合凭据的 excluded-models 排除规则，过滤已被禁用的模型，仅将真正可用的模型列入候选
 * 4. 只要成功获取到了动态可用模型，候选列表完全由动态获取到的真实模型组成，杜绝硬编码写死模型干扰
 * 5. 仅当动态模型列表彻底为空时（如离线或后端不支持），才采用 Provider 内置推荐模型作为 fallback 兜底
 */
export function getWarmupCandidateModels(
  provider: string,
  dynamicModels?: Array<{ id: string; name?: string }>,
  options?: WarmupCandidateModelsOptions
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  // 1. 提取前缀
  let prefix = options?.prefix;
  if (!prefix && options?.row) {
    prefix = extractPrefixFromRow(options.row);
  }
  const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/\/+$/g, '') : '';

  // 2. 提取排除模型规则
  let excludedRules = options?.excludedModels;
  if (!excludedRules && options?.row) {
    excludedRules = extractExcludedModelsFromRow(options.row);
  }
  const cleanExcludedRules = Array.isArray(excludedRules) ? excludedRules : [];

  // 判断模型是否匹配排除规则
  const isModelExcluded = (modelId: string): boolean => {
    if (cleanExcludedRules.length === 0) return false;
    return cleanExcludedRules.some((rule) => matchesAccountModelRule(modelId, rule));
  };

  // 3. 处理动态获取到的凭证专属模型列表
  if (Array.isArray(dynamicModels) && dynamicModels.length > 0) {
    for (const item of dynamicModels) {
      const id = String(item.id || '').trim();
      if (!id) continue;

      // 原始模型 ID (未被排除则加入)
      if (!isModelExcluded(id) && !seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase());
        result.push(id);
      }

      // 若配置了前缀，且该 ID 尚未带有此前缀，自动生成带前缀版本（如 pqq/gpt-5.5）
      if (cleanPrefix) {
        const prefixedId = id.startsWith(`${cleanPrefix}/`) ? id : `${cleanPrefix}/${id}`;
        if (!isModelExcluded(prefixedId) && !seen.has(prefixedId.toLowerCase())) {
          seen.add(prefixedId.toLowerCase());
          result.push(prefixedId);
        }
      }
    }
  }

  // 4. 若成功提取到动态模型，直接返回真实可用列表！不再追加写死的假模型
  if (result.length > 0) {
    return result;
  }

  // 5. 兜底回退：仅当动态列表彻底为空时，补充 Provider 内置推荐模型
  const normalized = String(provider || '').trim().toLowerCase();
  const presets = DEFAULT_WARMUP_MODELS_BY_PROVIDER[normalized] || DEFAULT_WARMUP_MODELS_BY_PROVIDER.openai;
  for (const preset of presets) {
    if (!isModelExcluded(preset) && !seen.has(preset.toLowerCase())) {
      seen.add(preset.toLowerCase());
      result.push(preset);
    }
  }

  return result;
}

/**
 * 依据凭据属性与 Provider 获取默认预热请求的 Endpoint
 *
 * 核心设计（代码即文档）：
 * 1. Codex 凭据为 ChatGPT 订阅账号（Plus/Team/Pro），非 OpenAI Platform 付费 API。
 *    因此绝对不能向 /v1/chat/completions 发送请求（否则必报 429 You have no credits remaining）；
 *    必须使用 Codex 官方专用的 /v1/responses 端点（如 https://api.openai.com/v1/responses）。
 * 2. Claude 凭据走 /v1/messages 端点（如 https://api.anthropic.com/v1/messages）。
 * 3. xAI CLI/Grok 凭据走 https://cli-chat-proxy.grok.com/v1/responses。
 * 4. 若凭据自定义了 base_url / endpoint，则基于各自协议规范化端点。
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
      return buildClaudeMessagesEndpoint(trimmedBase);
    }
    if (normalized === 'codex') {
      return buildCodexResponsesEndpoint(trimmedBase);
    }
    if (normalized === 'xai' && trimmedBase.includes('cli-chat-proxy')) {
      if (trimmedBase.endsWith('/v1/responses')) return trimmedBase;
      if (trimmedBase.endsWith('/v1')) return `${trimmedBase}/responses`;
      return `${trimmedBase}/v1/responses`;
    }
    if (trimmedBase.endsWith('/chat/completions')) return trimmedBase;
    if (trimmedBase.endsWith('/v1')) return `${trimmedBase}/chat/completions`;
    return `${trimmedBase}/v1/chat/completions`;
  }

  // 默认官方公网端点 (由后端 CPA 代理请求并注入鉴权)
  switch (normalized) {
    case 'claude':
      return 'https://api.anthropic.com/v1/messages';
    case 'codex':
      return 'https://api.openai.com/v1/responses';
    case 'xai':
      return 'https://cli-chat-proxy.grok.com/v1/responses';
    case 'gemini':
    case 'aistudio':
      return 'https://generativelanguage.googleapis.com/v1beta/chat/completions';
    case 'kimi':
      return 'https://api.moonshot.cn/v1/chat/completions';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
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
 * 目标重置时间计算返回对象
 */
export interface TargetResetWarmupTimeResult {
  /** 下次预热时间点时间戳 (毫秒) */
  nextWarmupAtMs: number;
  /** 预期的额度窗口重置时间点时间戳 (毫秒) */
  expectedResetAtMs: number;
  /** 每日实际预热时刻字符串，如 "04:20" */
  warmupTimeStr: string;
  /** 每日期望重置时刻字符串，如 "09:20" */
  targetResetTimeStr: string;
  /** 提前预热的小时数 */
  leadHours: number;
}

/**
 * 解析 "HH:mm" 时间字符串为当天的分钟数 (0 - 1439)
 */
export function parseTimeToMinutes(timeStr: string): { hours: number; minutes: number; totalMinutes: number } {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(timeStr || '').trim());
  if (!match) {
    return { hours: 9, minutes: 20, totalMinutes: 9 * 60 + 20 };
  }
  let hours = parseInt(match[1], 10);
  let minutes = parseInt(match[2], 10);
  if (isNaN(hours) || hours < 0) hours = 0;
  if (hours > 23) hours = 23;
  if (isNaN(minutes) || minutes < 0) minutes = 0;
  if (minutes > 59) minutes = 59;
  return { hours, minutes, totalMinutes: hours * 60 + minutes };
}

/**
 * 依据期望的每日重置时间与提前时长（默认提前 5 小时），计算下一次预热时间与预期重置时间
 *
 * 核心逻辑（代码即文档）：
 * 1. 用户输入期望每天窗口重置的时间点（如 09:20）。
 * 2. 凭借凭证滚动窗口期（如 Codex 5h 滚动额度窗口），提前 leadHours（默认 5）小时触发预热。
 * 3. 预热时刻 = 09:20 - 5H = 04:20。若跨天（如 02:00 - 5H = 前日 21:00），自动通过模 1440 进行 24 小时回卷。
 * 4. 结合当前基准时间戳（referenceTimeMs，默认当前时间）：
 *    - 若当天的预热时刻还在未来，排期在今天该时刻；
 *    - 若当天的预热时刻已在过去，排期在明天的同一时刻。
 * 5. 预期重置时间 = 预热时间戳 + leadHours * 3600 * 1000。
 */
export function calculateTargetResetWarmupTime(
  targetResetTime: string = DEFAULT_TARGET_RESET_TIME,
  leadHours: number = DEFAULT_TARGET_LEAD_HOURS,
  referenceTimeMs?: number
): TargetResetWarmupTimeResult {
  const nowMs = typeof referenceTimeMs === 'number' && referenceTimeMs > 0 ? referenceTimeMs : Date.now();
  const safeLeadHours = Math.max(0, Number(leadHours) || 0);

  // 解析目标重置时间
  const { hours: targetH, minutes: targetM, totalMinutes: targetTotalM } = parseTimeToMinutes(targetResetTime);
  const pad = (n: number) => String(n).padStart(2, '0');
  const targetResetTimeStr = `${pad(targetH)}:${pad(targetM)}`;

  // 计算每日实际预热时刻（分钟数）
  const leadMinutes = Math.round(safeLeadHours * 60);
  let warmupTotalM = (targetTotalM - leadMinutes) % 1440;
  if (warmupTotalM < 0) warmupTotalM += 1440;

  const warmupH = Math.floor(warmupTotalM / 60);
  const warmupM = warmupTotalM % 60;
  const warmupTimeStr = `${pad(warmupH)}:${pad(warmupM)}`;

  // 基于当前日期构建预热时刻 Date 对象
  const refDate = new Date(nowMs);
  const candidateWarmupDate = new Date(
    refDate.getFullYear(),
    refDate.getMonth(),
    refDate.getDate(),
    warmupH,
    warmupM,
    0,
    0
  );

  // 若当天的预热时间点在基准时间之前，说明今天已过该点，下次预热安排在明天的同一时刻
  if (candidateWarmupDate.getTime() <= nowMs) {
    candidateWarmupDate.setDate(candidateWarmupDate.getDate() + 1);
  }

  const nextWarmupAtMs = candidateWarmupDate.getTime();
  const expectedResetAtMs = nextWarmupAtMs + Math.round(safeLeadHours * 3600 * 1000);

  return {
    nextWarmupAtMs,
    expectedResetAtMs,
    warmupTimeStr,
    targetResetTimeStr,
    leadHours: safeLeadHours,
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
  dynamicModels?: Array<{ id: string; name?: string }>,
  options?: WarmupCandidateModelsOptions
): AccountWarmupConfig {
  const defaultModel = getDefaultWarmupModel(provider, dynamicModels, options);
  const defaultPrompt = loadWarmupPrompt();

  const fallback: AccountWarmupConfig = {
    model: defaultModel,
    prompt: defaultPrompt,
    maxTokens: DEFAULT_WARMUP_MAX_TOKENS,
    mode: 'inferred',
    inferredDelaySeconds: DEFAULT_INFERRED_DELAY_SECONDS,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    enabled: false,
    targetResetTime: DEFAULT_TARGET_RESET_TIME,
    targetLeadHours: DEFAULT_TARGET_LEAD_HOURS,
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
      mode:
        parsed.mode === 'interval'
          ? 'interval'
          : parsed.mode === 'target_reset'
            ? 'target_reset'
            : 'inferred',
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
      targetResetTime:
        typeof parsed.targetResetTime === 'string' && parsed.targetResetTime.trim()
          ? parsed.targetResetTime.trim()
          : DEFAULT_TARGET_RESET_TIME,
      targetLeadHours:
        typeof parsed.targetLeadHours === 'number' && parsed.targetLeadHours >= 0
          ? parsed.targetLeadHours
          : DEFAULT_TARGET_LEAD_HOURS,
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
 * 剥离发往上游 API 时的路由前缀 (如 'pqq/gpt-5.5' -> 'gpt-5.5')
 * 保证上游服务商（OpenAI, Anthropic 等）能够识别真实的基础模型名称
 */
export function stripModelPrefix(model: string, prefix?: string): string {
  const trimmedModel = String(model || '').trim();
  if (!trimmedModel) return '';
  const trimmedPrefix = String(prefix || '').trim().replace(/\/+$/g, '');
  if (trimmedPrefix && trimmedModel.toLowerCase().startsWith(`${trimmedPrefix.toLowerCase()}/`)) {
    return trimmedModel.slice(trimmedPrefix.length + 1).trim();
  }
  return trimmedModel;
}

/**
 * 复用系统已有的模型支持列表获取逻辑，获取凭据真实可用的模型列表
 *
 * 核心设计（代码即文档）：
 * 1. 凭据自身配置中声明的模型 (row.raw.models)
 * 2. CPA 运行时动态模型 (authFilesApi.getModelsForAuthFile)
 * 3. 官方渠道标准模型定义 (authFilesApi.getModelDefinitions)
 * 4. 结合全局排除规则与凭据自身的 excluded-models 排除规则 (buildAccountModelRuleProjection)
 * 5. 过滤掉被禁用的模型，仅返回可用或未知的模型列表
 */
export interface FetchAuthFileSupportedModelsOptions {
  /** 外部已预加载或缓存的运行时模型列表 */
  modelsList?: AuthFileModelItem[];
  /** 外部已预加载或缓存的官方渠道标准模型定义 */
  modelDefinitions?: AuthFileModelItem[];
}

export async function fetchAuthFileSupportedModels(
  row: AccountRow,
  requestScope?: AuthFilesApiRequestScope,
  globalExcluded: Record<string, string[]> = {},
  options?: FetchAuthFileSupportedModelsOptions
): Promise<Array<{ id: string; name?: string; display_name?: string }>> {
  const providerKey = normalizeProviderKey(row.provider);
  const definitionsChannel = providerKey === 'gemini-cli' ? 'gemini' : providerKey;
  const patchTarget = getAuthFilePatchTarget(row.raw);
  const selector = String(patchTarget.runtimeId ?? '').trim() || row.raw.name || row.fileName;

  // 1. 读取凭据自身配置中静态声明的 models (如 pqq.json 中声明的 models 数组)
  const rawModels: Array<{ id: string; name?: string; display_name?: string }> = [];
  const rawRecord = (row.raw ?? {}) as Record<string, unknown>;
  const declaredModels = rawRecord.models;
  if (Array.isArray(declaredModels)) {
    declaredModels.forEach((item: unknown) => {
      if (typeof item === 'string' && item.trim()) {
        rawModels.push({ id: item.trim(), name: item.trim() });
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const id = String(obj.name || obj.id || obj.model || '').trim();
        const alias = String(obj.alias || obj.display_name || '').trim();
        if (id) {
          rawModels.push({ id, name: id, display_name: alias || undefined });
        }
      }
    });
  }

  // 2. 检查是否有外部传入的预加载模型与定义；若缺失则发起网络请求
  let runtimeModels: AuthFileModelItem[] =
    options?.modelsList && options.modelsList.length > 0 ? options.modelsList : [];
  let modelDefinitions: AuthFileModelItem[] =
    options?.modelDefinitions && options.modelDefinitions.length > 0
      ? options.modelDefinitions
      : [];

  if (runtimeModels.length === 0 || modelDefinitions.length === 0) {
    const [runtimeResult, definitionsResult] = await Promise.allSettled([
      runtimeModels.length > 0
        ? Promise.resolve(runtimeModels)
        : requestScope
          ? authFilesApi.getModelsForAuthFile(selector, requestScope)
          : authFilesApi.getModelsForAuthFile(selector),
      modelDefinitions.length > 0
        ? Promise.resolve(modelDefinitions)
        : definitionsChannel
          ? requestScope
            ? authFilesApi.getModelDefinitions(definitionsChannel, requestScope)
            : authFilesApi.getModelDefinitions(definitionsChannel)
          : Promise.resolve([]),
    ]);

    if (runtimeModels.length === 0 && runtimeResult.status === 'fulfilled' && Array.isArray(runtimeResult.value)) {
      runtimeModels = runtimeResult.value;
    }
    if (modelDefinitions.length === 0 && definitionsResult.status === 'fulfilled' && Array.isArray(definitionsResult.value)) {
      modelDefinitions = definitionsResult.value;
    }
  }

  // 3. 复用系统已有的 buildAccountModelRuleProjection 投影函数进行规则计算
  const credentialRules = extractExcludedModelsFromRow(row);
  const projection = buildAccountModelRuleProjection({
    provider: providerKey,
    runtimeModels,
    modelDefinitions,
    credentialRules,
    globalRules: globalExcluded,
    globalRulesKnown: Object.keys(globalExcluded).length > 0,
  });

  // 4. 提取 projection 中可用 (available) 或未明确排除的模型
  const availableFromProjection = projection.rows
    .filter((r) => r.scope === 'available' || r.scope === 'unknown')
    .map((r) => ({
      id: r.id,
      name: r.id,
      display_name: r.display_name,
    }));

  // 5. 整合凭据声明模型、运行时动态模型与官方定义，严格去重并过滤排除项
  const result: Array<{ id: string; name?: string; display_name?: string }> = [];
  const seenIds = new Set<string>();

  const addModel = (m: { id: string; name?: string; display_name?: string }) => {
    const norm = m.id.trim().toLowerCase();
    if (!norm || seenIds.has(norm)) return;
    const isExcluded = credentialRules.some((pattern) => matchesAccountModelRule(m.id, pattern));
    if (isExcluded) return;
    seenIds.add(norm);
    result.push(m);
  };

  rawModels.forEach(addModel);
  availableFromProjection.forEach(addModel);
  runtimeModels.forEach((m) => addModel({ id: m.id, name: m.id, display_name: m.display_name }));

  return result;
}

/**
 * 构建请求体与请求头
 * 严格按照 Codex / Claude / xAI / OpenAI 等协议组装 Headers 与 Body，杜绝 429 平台协议不兼容问题
 */
export function buildWarmupPayload(
  provider: string,
  endpoint: string,
  model: string,
  prompt: string,
  maxTokens: number,
  rawRow?: AccountRow | null
): { header: Record<string, string>; data: string } {
  const normalized = String(provider || '').trim().toLowerCase();
  const prefix = rawRow ? extractPrefixFromRow(rawRow) : undefined;
  // 剥离上游模型的前缀（如 'pqq/gpt-5.5' -> 'gpt-5.5'），避免上游报模型不存在
  const upstreamModel = stripModelPrefix(model, prefix);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer $TOKEN$',
  };

  // 1. Claude /messages 格式
  if (normalized === 'claude' || endpoint.includes('/messages')) {
    headers['x-api-key'] = '$TOKEN$';
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    return {
      header: headers,
      data: JSON.stringify({
        model: upstreamModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    };
  }

  // 2. Codex /responses 格式 (严格符合 Codex 客户端协议规范)
  if (normalized === 'codex' || endpoint.includes('/responses')) {
    headers['User-Agent'] =
      'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)';
    headers['OpenAI-Beta'] = 'codex-1';
    headers['Accept'] = 'application/json';

    // 提取 Chatgpt-Account-Id (若凭据中包含)
    const rawRecord = (rawRow?.raw ?? {}) as Record<string, unknown>;
    const accountId = String(
      rawRecord['chatgpt_account_id'] ??
        rawRecord['chatgpt-account-id'] ??
        rawRecord['accountId'] ??
        rawRecord['account_id'] ??
        ''
    ).trim();
    if (accountId) {
      headers['Chatgpt-Account-Id'] = accountId;
    }

    return {
      header: headers,
      data: JSON.stringify({
        model: upstreamModel,
        input: prompt,
        stream: false,
      }),
    };
  }

  // 3. xAI CLI Proxy /responses 格式
  if (normalized === 'xai' && endpoint.includes('cli-chat-proxy')) {
    headers['x-xai-token-auth'] = 'xai-grok-cli';
    headers['x-grok-client-version'] = '0.2.101';
    headers['User-Agent'] = 'xai-cli/0.2.101';
    return {
      header: headers,
      data: JSON.stringify({
        model: upstreamModel,
        input: prompt,
        stream: false,
      }),
    };
  }

  // 4. 默认 OpenAI /chat/completions 兼容格式 (适用于 OpenAI API Key、Gemini、Kimi、Qwen 等)
  return {
    header: headers,
    data: JSON.stringify({
      model: upstreamModel,
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

  const { header, data } = buildWarmupPayload(row.provider, endpoint, model, prompt, maxTokens, row);

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
