import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCallApi } from '@/services/api/apiCall';
import type { AccountQuotaDisplayWindow } from './accountQuotaDisplayWindows';
import type { AccountRow } from './accountRows';
import {
  DEFAULT_INFERRED_DELAY_SECONDS,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_TARGET_LEAD_HOURS,
  DEFAULT_TARGET_RESET_TIME,
  DEFAULT_WARMUP_MAX_TOKENS,
  DEFAULT_WARMUP_PROMPT,
  buildWarmupPayload,
  calculateTargetResetWarmupTime,
  executeWarmupInference,
  extractExcludedModelsFromRow,
  extractModelResponseContent,
  extractPrefixFromRow,
  fetchAuthFileSupportedModels,
  getDefaultWarmupEndpoint,
  getDefaultWarmupModel,
  getWarmupCandidateModels,
  inferNextWarmupTime,
  loadAccountWarmupConfig,
  loadWarmupHistory,
  loadWarmupPrompt,
  parseTimeToMinutes,
  saveAccountWarmupConfig,
  saveWarmupPrompt,
  saveWarmupRecord,
  stripModelPrefix,
  type AccountWarmupConfig,
  type AccountWarmupRecord,
} from './accountWarmup';

const makeMockRow = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  key: 'row-1',
  selectionKey: 'row-1',
  fileName: 'codex-acc.json',
  accountLabel: 'Codex Account',
  provider: 'codex',
  planType: 'pro',
  disabled: false,
  runtimeOnly: false,
  statusMessage: '',
  authIndex: '0',
  projectId: 'proj-1',
  priority: 1,
  createdAtMs: Date.now() - 100000,
  updatedAtMs: Date.now() - 50000,
  subscriptionUntilMs: null,
  authenticationAtMs: Date.now() - 10000,
  rawCredentialStatusSuperseded: false,
  quota: {
    status: 'ok',
    remainingPercent: 85,
    usedPercent: 15,
    resetLabel: '5h',
    resetAtMs: Date.now() + 3600000,
    resetAccuracy: 'exact',
    planType: 'pro',
    source: 'cache',
  },
  usage: {
    success: 10,
    failure: 0,
    successRate: 1,
    recentRequests: [],
  },
  inspection: null,
  raw: {
    name: 'codex-acc.json',
    authIndex: '0',
    type: 'codex',
  },
  ...overrides,
});

/**
 * 内存 Storage 模拟实现，供单元测试在 Node 环境中运行 localStorage 读写
 */
const createMemoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
};

describe('accountWarmup model', () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      ...(typeof window !== 'undefined' ? window : {}),
      localStorage: storage,
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Constants and Defaults', () => {
    it('provides sound default configuration constants', () => {
      expect(DEFAULT_WARMUP_PROMPT).toBe('ping');
      expect(DEFAULT_WARMUP_MAX_TOKENS).toBe(16);
      expect(DEFAULT_INFERRED_DELAY_SECONDS).toBe(10);
      expect(DEFAULT_INTERVAL_MINUTES).toBe(60);
      expect(DEFAULT_TARGET_RESET_TIME).toBe('09:20');
      expect(DEFAULT_TARGET_LEAD_HOURS).toBe(5);
    });

    it('returns sensible default models by provider when dynamic list is empty', () => {
      expect(getDefaultWarmupModel('codex')).toBe('gpt-5-codex');
      expect(getDefaultWarmupModel('claude')).toBe('claude-3-7-sonnet-20250219');
      expect(getDefaultWarmupModel('gemini')).toBe('gemini-2.5-pro');
      expect(getDefaultWarmupModel('xai')).toBe('grok-4');
      expect(getDefaultWarmupModel('kimi')).toBe('moonshot-v1-8k');
      expect(getDefaultWarmupModel('unknown-provider')).toBe('gpt-4o-mini');
    });

    it('prefers dynamic models if available for default selection', () => {
      const dynamic = [{ id: 'gpt-5.5' }, { id: 'pqq/gpt-5.5' }];
      expect(getDefaultWarmupModel('codex', dynamic)).toBe('gpt-5.5');
    });

    it('uses dynamic models exclusively when available, preventing hardcoded clutter', () => {
      const dynamic = [{ id: 'gpt-5.5' }, { id: 'gpt-6-astra' }];
      const candidates = getWarmupCandidateModels('codex', dynamic);
      expect(candidates).toEqual(['gpt-5.5', 'gpt-6-astra']);
      expect(candidates).not.toContain('gpt-5-codex'); // 没有注入写死模型
    });

    it('supports credential prefix and complements prefixed model options', () => {
      const dynamic = [{ id: 'gpt-5.5' }, { id: 'gpt-6-astra' }];
      const candidates = getWarmupCandidateModels('codex', dynamic, { prefix: 'pqq' });
      expect(candidates).toContain('gpt-5.5');
      expect(candidates).toContain('pqq/gpt-5.5');
      expect(candidates).toContain('gpt-6-astra');
      expect(candidates).toContain('pqq/gpt-6-astra');
    });

    it('filters out excluded models configured on credential', () => {
      const dynamic = [{ id: 'gpt-5.5' }, { id: 'gpt-6-astra' }, { id: 'disabled-model' }];
      const candidates = getWarmupCandidateModels('codex', dynamic, {
        excludedModels: ['disabled-model'],
      });
      expect(candidates).toContain('gpt-5.5');
      expect(candidates).toContain('gpt-6-astra');
      expect(candidates).not.toContain('disabled-model');
    });

    it('extracts prefix and excluded models directly from row', () => {
      const row = makeMockRow({
        raw: {
          name: 'test.json',
          prefix: 'team',
          'excluded-models': ['o1-preview'],
        },
      });
      expect(extractPrefixFromRow(row)).toBe('team');
      expect(extractExcludedModelsFromRow(row)).toEqual(['o1-preview']);
    });
  });

  describe('getDefaultWarmupEndpoint', () => {
    it('uses row.raw.baseUrl when configured', () => {
      const row = makeMockRow({
        provider: 'openai',
        raw: {
          name: 'openai.json',
          baseUrl: 'https://custom-gateway.example/v1',
        },
      });
      expect(getDefaultWarmupEndpoint(row)).toBe('https://custom-gateway.example/v1/chat/completions');
    });

    it('resolves default endpoints by provider', () => {
      expect(getDefaultWarmupEndpoint(makeMockRow({ provider: 'claude' }))).toBe(
        'https://api.anthropic.com/v1/messages'
      );
      expect(getDefaultWarmupEndpoint(makeMockRow({ provider: 'gemini' }))).toBe(
        'https://generativelanguage.googleapis.com/v1beta/chat/completions'
      );
      expect(getDefaultWarmupEndpoint(makeMockRow({ provider: 'xai' }))).toBe(
        'https://cli-chat-proxy.grok.com/v1/responses'
      );
      expect(getDefaultWarmupEndpoint(makeMockRow({ provider: 'codex' }))).toBe(
        'https://api.openai.com/v1/responses'
      );
    });

    it('builds codex responses endpoint properly when custom baseUrl is provided', () => {
      const row = makeMockRow({
        provider: 'codex',
        raw: {
          name: 'codex.json',
          baseUrl: 'https://codex-proxy.example.com/v1',
        },
      });
      expect(getDefaultWarmupEndpoint(row)).toBe('https://codex-proxy.example.com/v1/responses');
    });
  });

  describe('extractModelResponseContent', () => {
    it('extracts text from OpenAI chat completions format', () => {
      const body = {
        choices: [{ message: { content: 'pong from openai' } }],
      };
      expect(extractModelResponseContent(body, '')).toBe('pong from openai');
    });

    it('extracts text from Claude messages format', () => {
      const body = {
        content: [{ type: 'text', text: 'pong from claude' }],
      };
      expect(extractModelResponseContent(body, '')).toBe('pong from claude');
    });

    it('extracts text from Gemini generateContent format', () => {
      const body = {
        candidates: [{ content: { parts: [{ text: 'pong from gemini' }] } }],
      };
      expect(extractModelResponseContent(body, '')).toBe('pong from gemini');
    });

    it('extracts text from Codex responses format', () => {
      const body = {
        output: [{ content: [{ text: 'pong from codex' }] }],
      };
      expect(extractModelResponseContent(body, '')).toBe('pong from codex');
    });

    it('extracts error messages from response object', () => {
      const body = {
        error: { message: 'Rate limit exceeded' },
      };
      expect(extractModelResponseContent(body, '')).toBe('Rate limit exceeded');
    });

    it('falls back to bodyText when body object has no recognized fields', () => {
      expect(extractModelResponseContent({}, 'raw response text')).toBe('raw response text');
    });
  });

  describe('inferNextWarmupTime', () => {
    const now = 1700000000000;

    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
    });

    it('prioritizes five_hour quota window over other windows', () => {
      const windows: AccountQuotaDisplayWindow[] = [
        {
          key: 'daily-win',
          label: 'Daily Window',
          kind: 'daily',
          remainingPercent: 90,
          usedPercent: 10,
          resetLabel: '24h',
          resetAccuracy: 'exact',
          limitWindowSeconds: 86400,
          resetAtMs: now + 50000,
          fromMs: now,
          toMs: now + 50000,
        },
        {
          key: 'five-hour-win',
          label: '5小时主窗口',
          kind: 'five_hour',
          remainingPercent: 50,
          usedPercent: 50,
          resetLabel: '5h',
          resetAccuracy: 'exact',
          limitWindowSeconds: 18000,
          resetAtMs: now + 30000,
          fromMs: now,
          toMs: now + 30000,
        },
      ];

      const row = makeMockRow();
      const delaySeconds = 10;
      const result = inferNextWarmupTime(row, delaySeconds, windows);

      expect(result.resetAtMs).toBe(now + 30000);
      expect(result.nextWarmupAtMs).toBe(now + 30000 + 10000);
      expect(result.sourceWindowLabel).toBe('5小时主窗口');
      expect(result.isFuture).toBe(true);
    });

    it('selects nearest future reset window if five_hour window is absent', () => {
      const windows: AccountQuotaDisplayWindow[] = [
        {
          key: 'far-win',
          label: 'Far Window',
          kind: 'weekly',
          remainingPercent: 90,
          usedPercent: 10,
          resetLabel: '7d',
          resetAccuracy: 'exact',
          limitWindowSeconds: 604800,
          resetAtMs: now + 200000,
          fromMs: now,
          toMs: now + 200000,
        },
        {
          key: 'near-win',
          label: 'Near Window',
          kind: 'daily',
          remainingPercent: 50,
          usedPercent: 50,
          resetLabel: '1d',
          resetAccuracy: 'exact',
          limitWindowSeconds: 86400,
          resetAtMs: now + 40000,
          fromMs: now,
          toMs: now + 40000,
        },
      ];

      const row = makeMockRow();
      const result = inferNextWarmupTime(row, 15, windows);

      expect(result.resetAtMs).toBe(now + 40000);
      expect(result.nextWarmupAtMs).toBe(now + 40000 + 15000);
      expect(result.sourceWindowLabel).toBe('Near Window');
      expect(result.isFuture).toBe(true);
    });

    it('falls back to row.quota.resetAtMs if windows list is empty', () => {
      const row = makeMockRow({
        quota: {
          status: 'ok',
          remainingPercent: 80,
          usedPercent: 20,
          resetLabel: '1h',
          resetAtMs: now + 12000,
          resetAccuracy: 'exact',
          planType: 'pro',
          source: 'cache',
        },
      });

      const result = inferNextWarmupTime(row, 5, []);
      expect(result.resetAtMs).toBe(now + 12000);
      expect(result.nextWarmupAtMs).toBe(now + 12000 + 5000);
      expect(result.isFuture).toBe(true);
    });

    it('returns null if no valid reset time is found', () => {
      const row = makeMockRow({
        quota: {
          status: 'ok',
          remainingPercent: 100,
          usedPercent: 0,
          resetLabel: '',
          resetAtMs: null,
          resetAccuracy: 'unknown',
          planType: null,
          source: 'none',
        },
      });

      const result = inferNextWarmupTime(row, 10, []);
      expect(result.nextWarmupAtMs).toBeNull();
      expect(result.resetAtMs).toBeNull();
      expect(result.isFuture).toBe(false);
    });

    it('marks isFuture: false and falls back to past five_hour window when all reset times have expired', () => {
      const windows: AccountQuotaDisplayWindow[] = [
        {
          key: 'five-hour-win',
          label: '5小时主窗口',
          kind: 'five_hour',
          remainingPercent: 0,
          usedPercent: 100,
          resetLabel: '5h',
          resetAccuracy: 'exact',
          limitWindowSeconds: 18000,
          resetAtMs: now - 30000,
          fromMs: now - 18000000,
          toMs: now - 30000,
        },
      ];

      const row = makeMockRow({
        quota: {
          status: 'ok',
          remainingPercent: 0,
          usedPercent: 100,
          resetLabel: '5h',
          resetAtMs: now - 30000,
          resetAccuracy: 'exact',
          planType: 'pro',
          source: 'cache',
        },
      });
      const result = inferNextWarmupTime(row, 10, windows);
      expect(result.resetAtMs).toBe(now - 30000);
      expect(result.nextWarmupAtMs).toBe(now - 30000 + 10000);
      expect(result.isFuture).toBe(false);
    });
  });

  describe('Prompt persistence and Storage', () => {
    it('loads default prompt "ping" when localStorage is empty', () => {
      expect(loadWarmupPrompt()).toBe('ping');
    });

    it('persists and loads updated prompt', () => {
      saveWarmupPrompt('hello custom test');
      expect(loadWarmupPrompt()).toBe('hello custom test');
    });

    it('loads and saves account warmup config', () => {
      const key = 'acc-1';
      const config: AccountWarmupConfig = {
        model: 'gpt-5-codex',
        prompt: 'test prompt',
        maxTokens: 32,
        mode: 'interval',
        inferredDelaySeconds: 20,
        intervalMinutes: 45,
        enabled: true,
      };

      saveAccountWarmupConfig(key, config);
      const loaded = loadAccountWarmupConfig(key, 'codex');
      expect(loaded.model).toBe('gpt-5-codex');
      expect(loaded.prompt).toBe('test prompt');
      expect(loaded.maxTokens).toBe(32);
      expect(loaded.mode).toBe('interval');
      expect(loaded.intervalMinutes).toBe(45);
      expect(loaded.enabled).toBe(true);
    });

    it('records and loads execution history, capped at 20 items', () => {
      const key = 'acc-history-test';
      for (let i = 0; i < 25; i++) {
        const record: AccountWarmupRecord = {
          timestamp: Date.now() + i,
          statusCode: 200,
          durationMs: 150 + i,
          responseSnippet: `pong ${i}`,
          success: true,
          model: 'gpt-5-codex',
          triggerSource: 'manual',
        };
        saveWarmupRecord(key, record);
      }

      const history = loadWarmupHistory(key);
      expect(history.length).toBe(20);
      expect(history[0].responseSnippet).toBe('pong 24');
    });
  });

  describe('stripModelPrefix', () => {
    it('strips configured prefix from model identifier', () => {
      expect(stripModelPrefix('pqq/gpt-5.5', 'pqq')).toBe('gpt-5.5');
      expect(stripModelPrefix('gpt-5.5', 'pqq')).toBe('gpt-5.5');
      expect(stripModelPrefix('pqq/gpt-5.5', '')).toBe('pqq/gpt-5.5');
      expect(stripModelPrefix('', 'pqq')).toBe('');
    });
  });

  describe('buildWarmupPayload', () => {
    it('builds Claude messages payload with anthropic headers', () => {
      const result = buildWarmupPayload(
        'claude',
        'https://api.anthropic.com/v1/messages',
        'claude-3-7-sonnet-20250219',
        'ping',
        16
      );

      expect(result.header['x-api-key']).toBe('$TOKEN$');
      expect(result.header['anthropic-version']).toBe('2023-06-01');
      const data = JSON.parse(result.data);
      expect(data.model).toBe('claude-3-7-sonnet-20250219');
      expect(data.messages[0].content).toBe('ping');
      expect(data.max_tokens).toBe(16);
    });

    it('builds OpenAI chat completions payload for openai provider', () => {
      const result = buildWarmupPayload(
        'openai',
        'https://api.openai.com/v1/chat/completions',
        'gpt-4o',
        'ping',
        16
      );

      expect(result.header.Authorization).toBe('Bearer $TOKEN$');
      const data = JSON.parse(result.data);
      expect(data.model).toBe('gpt-4o');
      expect(data.messages[0].content).toBe('ping');
      expect(data.max_tokens).toBe(16);
    });

    it('builds Codex responses payload with codex-tui headers and strips prefix', () => {
      const row = makeMockRow({
        raw: {
          name: 'pqq.json',
          prefix: 'pqq',
          chatgpt_account_id: 'acc-uuid-1234',
        },
      });

      const result = buildWarmupPayload(
        'codex',
        'https://api.openai.com/v1/responses',
        'pqq/gpt-5.5',
        'ping',
        16,
        row
      );

      expect(result.header['User-Agent']).toContain('codex-tui');
      expect(result.header['OpenAI-Beta']).toBe('codex-1');
      expect(result.header['Chatgpt-Account-Id']).toBe('acc-uuid-1234');
      const data = JSON.parse(result.data);
      expect(data.model).toBe('gpt-5.5'); // 验证剥离了 'pqq/' 前缀
      expect(data.input).toBe('ping');
      expect(data.stream).toBe(false);
    });
  });

  describe('fetchAuthFileSupportedModels', () => {
    it('integrates preloaded models, credential declared models and filters excluded models', async () => {
      const row = makeMockRow({
        raw: {
          name: 'custom.json',
          models: ['declared-model-1', 'declared-model-2'],
          'excluded-models': ['declared-model-2'],
        },
      });

      const models = await fetchAuthFileSupportedModels(row, undefined, {}, {
        modelsList: [
          { id: 'runtime-model-1', name: 'Runtime Model 1' },
          { id: 'declared-model-2', name: 'Excluded Model' },
        ],
        modelDefinitions: [
          { id: 'definition-model-1', name: 'Def Model 1' },
        ],
      });

      const ids = models.map((m) => m.id);
      expect(ids).toContain('declared-model-1');
      expect(ids).toContain('runtime-model-1');
      expect(ids).not.toContain('declared-model-2'); // 验证排除项生效
    });
  });

  describe('executeWarmupInference', () => {
    it('successfully calls apiCallApi.request and extracts snippet', async () => {
      const row = makeMockRow();
      const config: AccountWarmupConfig = {
        model: 'gpt-5-codex',
        prompt: 'ping',
        maxTokens: 16,
        mode: 'inferred',
        inferredDelaySeconds: 10,
        intervalMinutes: 60,
        enabled: false,
      };

      vi.spyOn(apiCallApi, 'request').mockResolvedValueOnce({
        statusCode: 200,
        hasStatusCode: true,
        header: {},
        bodyText: '',
        body: {
          choices: [{ message: { content: 'pong' } }],
        },
      });

      const outcome = await executeWarmupInference(row, config);
      expect(outcome.success).toBe(true);
      expect(outcome.statusCode).toBe(200);
      expect(outcome.responseSnippet).toBe('pong');
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles HTTP error responses properly', async () => {
      const row = makeMockRow();
      const config: AccountWarmupConfig = {
        model: 'gpt-5-codex',
        prompt: 'ping',
        maxTokens: 16,
        mode: 'inferred',
        inferredDelaySeconds: 10,
        intervalMinutes: 60,
        enabled: false,
      };

      vi.spyOn(apiCallApi, 'request').mockResolvedValueOnce({
        statusCode: 429,
        hasStatusCode: true,
        header: {},
        bodyText: 'Rate limit exceeded',
        body: {
          error: { message: 'Too Many Requests' },
        },
      });

      const outcome = await executeWarmupInference(row, config);
      expect(outcome.success).toBe(false);
      expect(outcome.statusCode).toBe(429);
      expect(outcome.errorMessage).toContain('Too Many Requests');
    });
  });

  describe('calculateTargetResetWarmupTime and parseTimeToMinutes', () => {
    it('parses valid and invalid time strings properly', () => {
      expect(parseTimeToMinutes('09:20')).toEqual({ hours: 9, minutes: 20, totalMinutes: 560 });
      expect(parseTimeToMinutes('00:00')).toEqual({ hours: 0, minutes: 0, totalMinutes: 0 });
      expect(parseTimeToMinutes('23:59')).toEqual({ hours: 23, minutes: 59, totalMinutes: 1439 });
      expect(parseTimeToMinutes('invalid')).toEqual({ hours: 9, minutes: 20, totalMinutes: 560 });
    });

    it('calculates 5h lead warmup time accurately for daily 09:20 reset', () => {
      // 假设当前时间为 2026-09-14 01:00 (04:20 预热尚未到达)
      const refTime = new Date(2026, 8, 14, 1, 0, 0, 0).getTime();
      const result = calculateTargetResetWarmupTime('09:20', 5, refTime);

      expect(result.warmupTimeStr).toBe('04:20');
      expect(result.targetResetTimeStr).toBe('09:20');
      expect(result.leadHours).toBe(5);

      // 下次预热时间应在当天的 04:20
      const nextDate = new Date(result.nextWarmupAtMs);
      expect(nextDate.getFullYear()).toBe(2026);
      expect(nextDate.getMonth()).toBe(8);
      expect(nextDate.getDate()).toBe(14);
      expect(nextDate.getHours()).toBe(4);
      expect(nextDate.getMinutes()).toBe(20);

      // 预期重置时间应在当天的 09:20 (相隔恰好 5 小时)
      expect(result.expectedResetAtMs - result.nextWarmupAtMs).toBe(5 * 3600 * 1000);
    });

    it('schedules for next day if todays warmup time has already passed', () => {
      // 假设当前时间为 2026-09-14 10:00 (今天的 04:20 已经过去了)
      const refTime = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();
      const result = calculateTargetResetWarmupTime('09:20', 5, refTime);

      expect(result.warmupTimeStr).toBe('04:20');
      // 下次预热应安排在明天的 04:20
      const nextDate = new Date(result.nextWarmupAtMs);
      expect(nextDate.getDate()).toBe(15);
      expect(nextDate.getHours()).toBe(4);
      expect(nextDate.getMinutes()).toBe(20);
    });

    it('handles midnight wrap-around when lead hours exceed target hours', () => {
      // 期望重置时间 02:00，提前 5 小时 -> 前一日 21:00
      // 设当前时间为 18:00 (当天的 21:00 尚未到达)
      const refTime = new Date(2026, 8, 14, 18, 0, 0, 0).getTime();
      const result = calculateTargetResetWarmupTime('02:00', 5, refTime);

      expect(result.warmupTimeStr).toBe('21:00');
      const nextDate = new Date(result.nextWarmupAtMs);
      expect(nextDate.getHours()).toBe(21);
      expect(nextDate.getMinutes()).toBe(0);
      expect(result.expectedResetAtMs - result.nextWarmupAtMs).toBe(5 * 3600 * 1000);
    });
  });
});

