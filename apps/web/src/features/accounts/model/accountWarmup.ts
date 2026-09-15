/**
 * 凭据预热（Warmup）核心模型与辅助方法
 * 包含：定时预热时间推断、立即预热推理请求封装、响应解析、配置持久化与模型候选列表
 */

import { apiCallApi, getApiCallErrorMessage, type ApiCallResult } from '@/services/api/apiCall';
import { authFilesApi, type AuthFilesApiRequestScope } from '@/services/api/authFiles';
import { useConfigStore } from '@/stores/useConfigStore';
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
  codex: ['gpt-5.5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
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

  // 1. 提取当前凭据前缀 (例如 p390)
  let prefix = options?.prefix;
  if (!prefix && options?.row) {
    prefix = extractPrefixFromRow(options.row);
  }
  const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/\/+$/g, '') : '';
  const prefixMatch = cleanPrefix ? `${cleanPrefix}/` : '';

  // 2. 提取排除模型规则
  let excludedRules = options?.excludedModels;
  if (!excludedRules && options?.row) {
    excludedRules = extractExcludedModelsFromRow(options.row);
  }
  const cleanExcludedRules = Array.isArray(excludedRules) ? excludedRules : [];
  const isModelExcluded = (modelId: string): boolean => {
    if (cleanExcludedRules.length === 0) return false;
    const stripped = stripModelPrefix(modelId, cleanPrefix);
    return cleanExcludedRules.some(
      (rule) =>
        matchesAccountModelRule(modelId, rule) ||
        (stripped && matchesAccountModelRule(stripped, rule))
    );
  };

  // 3. 过滤并优先处理当前账号专属前缀模型
  if (Array.isArray(dynamicModels) && dynamicModels.length > 0) {
    const rawIds = dynamicModels
      .map((item) => String(item.id || item.name || '').trim())
      .filter(Boolean);

    // 【第一梯队 - 绝对优先】：显式以当前凭据 prefix 开头的模型 (例如 p390/gpt-5.5)
    if (cleanPrefix) {
      for (const id of rawIds) {
        if (id.startsWith(prefixMatch) && !isModelExcluded(id) && !seen.has(id.toLowerCase())) {
          seen.add(id.toLowerCase());
          result.push(id);
        }
      }
    }

    // 【第二梯队】：不带斜杠的公共基础模型，拼接当前前缀后加入
    for (const id of rawIds) {
      if (!id.includes('/') && !isModelExcluded(id)) {
        const targetPrefixed = cleanPrefix ? `${cleanPrefix}/${id}` : id;
        if (!seen.has(targetPrefixed.toLowerCase()) && !isModelExcluded(targetPrefixed)) {
          seen.add(targetPrefixed.toLowerCase());
          result.push(targetPrefixed);
        }
        if (!cleanPrefix && !seen.has(id.toLowerCase())) {
          seen.add(id.toLowerCase());
          result.push(id);
        }
      }
    }
  }

  if (result.length > 0) {
    return result;
  }

  // 4. 兜底回退备用列表
  const normalized = String(provider || '').trim().toLowerCase();
  const presets =
    normalized === 'codex'
      ? ['gpt-5.5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
      : DEFAULT_WARMUP_MODELS_BY_PROVIDER[normalized] || DEFAULT_WARMUP_MODELS_BY_PROVIDER.openai;

  for (const preset of presets) {
    const target = cleanPrefix ? `${cleanPrefix}/${preset}` : preset;
    if (!isModelExcluded(target) && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase());
      result.push(target);
    }
  }

  return result;
}

/**
 * 依据凭据属性与环境配置获取默认预热请求的 Endpoint
 * 完全复用 CLI Proxy API 标准会话调用接口 (/v1/chat/completions)
 *
 * 核心设计（代码即文档）：
 * 1. 预热必须 100% 完全复用 CLI Proxy API (CPA) 标准模型调用机制，禁止绕过网关直连上游公网端点；
 * 2. 默认请求网关标准接口 POST /v1/chat/completions；
 * 3. 上游协议适配（OpenAI、Codex、Claude、Gemini 等）全部由 CPA 网关自动翻译处理；
 * 4. 若传入 apiBase，则基于该基础地址拼接 /v1/chat/completions。
 */
export function getDefaultWarmupEndpoint(row?: AccountRow | null, apiBase?: string): string {
  if (apiBase && apiBase.trim()) {
    return `${apiBase.trim().replace(/\/+$/g, '')}/v1/chat/completions`;
  }
  const rawBase =
    (row?.raw?.['base_url'] ||
      row?.raw?.baseUrl ||
      row?.raw?.['endpoint'] ||
      row?.raw?.endpoint) as string | undefined;

  if (rawBase && typeof rawBase === 'string' && rawBase.trim()) {
    const trimmedBase = rawBase.trim().replace(/\/+$/g, '');
    if (trimmedBase.endsWith('/chat/completions')) return trimmedBase;
    if (trimmedBase.endsWith('/v1')) return `${trimmedBase}/chat/completions`;
    return `${trimmedBase}/v1/chat/completions`;
  }

  return 'http://127.0.0.1:8317/v1/chat/completions';
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
/**
 * 自动提取首选 CPA API Key
 * 优先使用显式传入的 key，其次从全局配置 store 中获取首个有效 API Key
 */
export function resolveCpaApiKey(explicitKey?: string): string {
  if (explicitKey && explicitKey.trim()) return explicitKey.trim();
  const config = useConfigStore.getState().config;
  const configKeys = Array.isArray(config?.apiKeys)
    ? config.apiKeys
    : Array.isArray((config as Record<string, unknown> | null)?.['api-keys'])
      ? ((config as Record<string, unknown>)['api-keys'] as string[])
      : [];
  for (const key of configKeys) {
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  return '';
}

/**
 * 构建 CPA 标准预热请求体与请求头
 * 遵循 OpenAI Chat 协议标准，携带 X-Session-ID / X-Session-Affinity 保证会话纯净隔离
 */
export function buildWarmupPayload(
  provider: string,
  endpoint: string,
  model: string,
  prompt: string,
  maxTokens: number,
  rawRow?: AccountRow | null,
  apiKey?: string
): { header: Record<string, string>; data: string } {
  const prefix = rawRow ? extractPrefixFromRow(rawRow) : undefined;
  const targetModel =
    prefix && !model.startsWith(`${prefix}/`) ? `${prefix}/${model}` : model;

  const reqSessionId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `warmup-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const resolvedKey = resolveCpaApiKey(apiKey);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Session-ID': reqSessionId,
    'X-Session-Affinity': reqSessionId,
  };
  if (resolvedKey) {
    headers['Authorization'] = `Bearer ${resolvedKey}`;
  }

  return {
    header: headers,
    data: JSON.stringify({
      model: targetModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    }),
  };
}

/**
 * 执行凭据预热推理（完全复用 CLI Proxy API 官方会话调用方式）
 *
 * 核心设计（代码即文档）：
 * 1. 100% 完全复用 CLI Proxy API (CPA) 标准 Chat Completions 调用机制，禁止绕过网关直连上游公网端点；
 * 2. 路由依赖模型前缀（如 p390/gpt-5.5），由网关精准分发至对应账号；
 * 3. 携带 X-Session-ID / X-Session-Affinity 作为 1-token 无状态探测会话，杜绝上下文污染；
 * 4. 使用统一的网关 API Key 鉴权 (Bearer <CPA_KEY>)；
 * 5. 通过管理后台 /api-call 代理请求至本地 CPA 网关 (默认 http://127.0.0.1:8317/v1/chat/completions)。
 */
export async function executeWarmupInference(
  row: AccountRow,
  config: AccountWarmupConfig,
  options?: { apiBase?: string; apiKey?: string }
): Promise<WarmupExecutionResult> {
  const prefix = extractPrefixFromRow(row);
  const rawModel = config.model.trim() || getDefaultWarmupModel(row.provider);
  // 确保目标模型带有当前账号路由前缀 (如 p390/gpt-5.5)
  const targetModel =
    prefix && !rawModel.startsWith(`${prefix}/`) ? `${prefix}/${rawModel}` : rawModel;

  const prompt = config.prompt.trim() || DEFAULT_WARMUP_PROMPT;
  const maxTokens = config.maxTokens > 0 ? config.maxTokens : DEFAULT_WARMUP_MAX_TOKENS;

  // 构造随机独立的 Session ID，杜绝上下文串扰
  const reqSessionId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `warmup-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const apiKey = resolveCpaApiKey(options?.apiKey);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Session-ID': reqSessionId,
    'X-Session-Affinity': reqSessionId,
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const payload = {
    model: targetModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    stream: false,
  };

  const startTime = performance.now();

  // 完全通过网关内部管理代理发送至网关标准端点 (http://127.0.0.1:8317/v1/chat/completions)
  try {
    const defaultEndpoint = options?.apiBase
      ? `${options.apiBase.replace(/\/+$/, '')}/v1/chat/completions`
      : 'http://127.0.0.1:8317/v1/chat/completions';
    const apiCallResult: ApiCallResult = await apiCallApi.request(
      {
        method: 'POST',
        url: config.customEndpoint?.trim() || defaultEndpoint,
        header: headers,
        data: JSON.stringify(payload),
      },
      { timeout: 30000 }
    );

    const durationMs = Math.round(performance.now() - startTime);

    if (apiCallResult.statusCode >= 200 && apiCallResult.statusCode < 300) {
      const content = extractModelResponseContent(apiCallResult.body, apiCallResult.bodyText);
      return {
        success: true,
        statusCode: apiCallResult.statusCode,
        durationMs,
        responseSnippet: content || '(OK)',
        rawResult: apiCallResult,
      };
    }

    const errorMessage = getApiCallErrorMessage(apiCallResult);
    return {
      success: false,
      statusCode: apiCallResult.statusCode,
      durationMs,
      responseSnippet: errorMessage,
      errorMessage,
      rawResult: apiCallResult,
    };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - startTime);
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      statusCode: 0,
      durationMs,
      responseSnippet: message,
      errorMessage: message,
    };
  }
}
