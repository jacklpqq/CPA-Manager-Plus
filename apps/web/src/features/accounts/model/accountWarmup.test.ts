import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCallApi } from '@/services/api/apiCall';
import type { AccountQuotaDisplayWindow } from './accountQuotaDisplayWindows';
import type { AccountRow } from './accountRows';
import {
  DEFAULT_INFERRED_DELAY_SECONDS,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_WARMUP_MAX_TOKENS,
  DEFAULT_WARMUP_PROMPT,
  buildWarmupPayload,
  executeWarmupInference,
  extractModelResponseContent,
  getDefaultWarmupEndpoint,
  getDefaultWarmupModel,
  getWarmupCandidateModels,
  inferNextWarmupTime,
  loadAccountWarmupConfig,
  loadWarmupHistory,
  loadWarmupPrompt,
  saveAccountWarmupConfig,
  saveWarmupPrompt,
  saveWarmupRecord,
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

describe('accountWarmup model', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('Constants and Defaults', () => {
    it('provides sound default configuration constants', () => {
      expect(DEFAULT_WARMUP_PROMPT).toBe('ping');
      expect(DEFAULT_WARMUP_MAX_TOKENS).toBe(16);
      expect(DEFAULT_INFERRED_DELAY_SECONDS).toBe(10);
      expect(DEFAULT_INTERVAL_MINUTES).toBe(60);
    });

    it('returns sensible default models by provider', () => {
      expect(getDefaultWarmupModel('codex')).toBe('gpt-5-codex');
      expect(getDefaultWarmupModel('claude')).toBe('claude-3-7-sonnet-20250219');
      expect(getDefaultWarmupModel('gemini')).toBe('gemini-2.5-pro');
      expect(getDefaultWarmupModel('xai')).toBe('grok-4');
      expect(getDefaultWarmupModel('kimi')).toBe('moonshot-v1-8k');
      expect(getDefaultWarmupModel('unknown-provider')).toBe('gpt-4o-mini');
    });

    it('prefers dynamic models if available for default selection', () => {
      const dynamic = [{ id: 'custom-fine-tuned' }, { id: 'gpt-4o' }];
      expect(getDefaultWarmupModel('codex', dynamic)).toBe('custom-fine-tuned');
    });

    it('combines dynamic models with provider presets without duplicates', () => {
      const dynamic = [{ id: 'gpt-5-codex' }, { id: 'custom-model' }];
      const candidates = getWarmupCandidateModels('codex', dynamic);
      expect(candidates[0]).toBe('gpt-5-codex');
      expect(candidates[1]).toBe('custom-model');
      expect(candidates).toContain('gpt-5.3-codex-spark');
      // No duplicates
      const lower = candidates.map((c) => c.toLowerCase());
      expect(new Set(lower).size).toBe(candidates.length);
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
        'https://api.x.ai/v1/chat/completions'
      );
      expect(getDefaultWarmupEndpoint(makeMockRow({ provider: 'codex' }))).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
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

      const row = makeMockRow();
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

    it('builds OpenAI chat completions payload', () => {
      const result = buildWarmupPayload(
        'codex',
        'https://api.openai.com/v1/chat/completions',
        'gpt-5-codex',
        'ping',
        16
      );

      expect(result.header.Authorization).toBe('Bearer $TOKEN$');
      const data = JSON.parse(result.data);
      expect(data.model).toBe('gpt-5-codex');
      expect(data.messages[0].content).toBe('ping');
      expect(data.max_tokens).toBe(16);
    });

    it('builds Codex responses payload when endpoint has /responses', () => {
      const result = buildWarmupPayload(
        'codex',
        'https://api.openai.com/v1/responses',
        'gpt-5-codex',
        'ping',
        16
      );

      const data = JSON.parse(result.data);
      expect(data.model).toBe('gpt-5-codex');
      expect(data.input).toBe('ping');
      expect(data.stream).toBe(false);
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
});
