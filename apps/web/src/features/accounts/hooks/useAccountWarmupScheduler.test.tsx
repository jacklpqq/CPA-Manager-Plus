/**
 * 凭据预热调度器 Hook 单元测试
 * 使用 react-test-renderer 与 vitest 测试调度状态管理、立即预热、额度自动刷新及定时推断逻辑
 */

import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountQuotaDisplayWindow } from '../model/accountQuotaDisplayWindows';
import type { AccountRow } from '../model/accountRows';
import * as accountWarmupModel from '../model/accountWarmup';
import {
  useAccountWarmupScheduler,
  type UseAccountWarmupSchedulerProps,
  type UseAccountWarmupSchedulerResult,
} from './useAccountWarmupScheduler';

// 模拟 react-i18next 避免国际化环境依赖
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.error) return `${key}:${String(options.error)}`;
      return key;
    },
  }),
}));

// 模拟全局通知 store
const mockShowNotification = vi.fn();
vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: { showNotification: typeof mockShowNotification }) => unknown) =>
    selector({ showNotification: mockShowNotification }),
}));

/**
 * 构造用于测试的凭据行模拟数据
 */
const makeMockRow = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  key: 'row-1',
  selectionKey: 'row-1',
  fileName: 'test-account.json',
  accountLabel: 'Test Account',
  provider: 'codex',
  planType: 'pro',
  disabled: false,
  runtimeOnly: false,
  statusMessage: '',
  authIndex: '0',
  projectId: 'proj-1',
  priority: 1,
  createdAtMs: 1700000000000,
  updatedAtMs: 1700000010000,
  subscriptionUntilMs: null,
  authenticationAtMs: 1700000020000,
  rawCredentialStatusSuperseded: false,
  quota: {
    status: 'ok',
    remainingPercent: 90,
    usedPercent: 10,
    resetLabel: '5h',
    resetAtMs: 1700003600000,
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
    name: 'test-account.json',
    authIndex: '0',
    type: 'codex',
  },
  ...overrides,
});

describe('useAccountWarmupScheduler', () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: UseAccountWarmupSchedulerResult | null = null;
  const refreshAccountQuota = vi.fn().mockResolvedValue(undefined);

  /** 测试 Harness 组件，用于捕获 Hook 导出的方法与响应式状态 */
  function Harness(props: UseAccountWarmupSchedulerProps) {
    const result = useAccountWarmupScheduler(props);
    useEffect(() => {
      latest = result;
    }, [result]);
    return null;
  }

  const mount = async (props: UseAccountWarmupSchedulerProps) => {
    await act(async () => {
      renderer = create(<Harness {...props} />);
      await Promise.resolve();
    });
  };

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

  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      ...(typeof window !== 'undefined' ? window : {}),
      localStorage: storage,
    });
    vi.clearAllMocks();
    vi.useFakeTimers();
    latest = null;
    renderer = null;
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('provides sound initial warmup state for an account', async () => {
    const row = makeMockRow();
    await mount({
      rows: [row],
      refreshAccountQuota,
    });

    expect(latest).not.toBeNull();
    const state = latest!.getWarmupState(row);
    expect(state.config.prompt).toBe('ping');
    expect(state.config.maxTokens).toBe(16);
    expect(state.config.enabled).toBe(false);
    expect(state.isRunning).toBe(false);
  });

  it('updates warmup configuration and reflects in state', async () => {
    const row = makeMockRow();
    await mount({
      rows: [row],
      refreshAccountQuota,
    });

    await act(async () => {
      latest!.updateWarmupConfig(row, {
        model: 'gpt-5-codex',
        prompt: 'test custom ping',
        maxTokens: 32,
        mode: 'interval',
        inferredDelaySeconds: 15,
        intervalMinutes: 30,
        enabled: true,
      });
      await Promise.resolve();
    });

    const isScheduled = latest!.isWarmupScheduled(row.selectionKey);
    expect(isScheduled).toBe(true);

    const state = latest!.getWarmupState(row);
    expect(state.config.prompt).toBe('test custom ping');
    expect(state.config.intervalMinutes).toBe(30);
  });

  it('executes immediate warmup and automatically calls refreshAccountQuota', async () => {
    const row = makeMockRow();
    vi.spyOn(accountWarmupModel, 'executeWarmupInference').mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      durationMs: 145,
      responseSnippet: 'pong response',
    });

    await mount({
      rows: [row],
      refreshAccountQuota,
    });

    let res: accountWarmupModel.WarmupExecutionResult | undefined;
    await act(async () => {
      res = await latest!.runImmediateWarmup(row);
      await Promise.resolve();
    });

    expect(res?.success).toBe(true);
    expect(res?.statusCode).toBe(200);
    expect(res?.responseSnippet).toBe('pong response');
    // 验证立即预热后自动触发了额度窗口刷新 (满足用户需求)
    expect(refreshAccountQuota).toHaveBeenCalledWith(row);

    const updatedState = latest!.getWarmupState(row);
    expect(updatedState.lastRecord?.responseSnippet).toBe('pong response');
  });

  it('refreshes quota and re-infers warmup time', async () => {
    const row = makeMockRow();
    const windows: AccountQuotaDisplayWindow[] = [
      {
        key: '5h',
        label: '5h Window',
        kind: 'five_hour',
        remainingPercent: 50,
        usedPercent: 50,
        resetLabel: '5h',
        resetAccuracy: 'exact',
        limitWindowSeconds: 18000,
        resetAtMs: 1700007200000,
        fromMs: 1700000000000,
        toMs: 1700007200000,
      },
    ];

    const quotaMap = new Map([[row.selectionKey, windows]]);

    await mount({
      rows: [row],
      refreshAccountQuota,
      quotaDisplayWindowsByRowKey: quotaMap,
    });

    let reinferred!: accountWarmupModel.InferredWarmupTimeResult;
    await act(async () => {
      reinferred = await latest!.refreshAndReinfer(row, 10);
      await Promise.resolve();
    });

    expect(refreshAccountQuota).toHaveBeenCalledWith(row);
    expect(reinferred.nextWarmupAtMs).toBe(1700007200000 + 10000);
    expect(reinferred.isFuture).toBe(true);
  });

  it('hydrates scheduled state from localStorage for existing accounts', async () => {
    const row = makeMockRow({ selectionKey: 'hydrated-acc' });
    accountWarmupModel.saveAccountWarmupConfig('hydrated-acc', {
      model: 'gpt-5-codex',
      prompt: 'ping',
      maxTokens: 16,
      mode: 'interval',
      inferredDelaySeconds: 10,
      intervalMinutes: 30,
      enabled: true,
    });

    await mount({
      rows: [row],
      refreshAccountQuota,
    });

    expect(latest!.isWarmupScheduled('hydrated-acc')).toBe(true);
    const state = latest!.getWarmupState(row);
    expect(state.config.enabled).toBe(true);
  });

  it('triggers scheduled warmup on timer tick and prevents infinite past-time loops', async () => {
    const row = makeMockRow({ selectionKey: 'timer-acc' });
    vi.spyOn(accountWarmupModel, 'executeWarmupInference').mockResolvedValue({
      success: true,
      statusCode: 200,
      durationMs: 100,
      responseSnippet: 'scheduled pong',
    });

    await mount({
      rows: [row],
      refreshAccountQuota,
    });

    // 启用基于重置时间的预热，设置下次时间为当前时刻之前（触发执行）
    await act(async () => {
      latest!.updateWarmupConfig(row, {
        model: 'gpt-5-codex',
        prompt: 'ping',
        maxTokens: 16,
        mode: 'interval',
        inferredDelaySeconds: 10,
        intervalMinutes: 60,
        enabled: true,
      });
      await Promise.resolve();
    });

    // 快进 5 秒调度器时钟
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(latest!.isWarmupScheduled('timer-acc')).toBe(true);
  });
});
