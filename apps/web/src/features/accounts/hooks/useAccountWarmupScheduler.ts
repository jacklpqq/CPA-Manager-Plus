/**
 * 前端凭据预热调度器 Hook
 * 负责定时检查已开启定时预热的凭据，到达预定时间后自动发起预热推理请求并刷新额度
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '@/stores';
import type { AccountQuotaDisplayWindow } from '../model/accountQuotaDisplayWindows';
import type { AccountRow } from '../model/accountRows';
import {
  executeWarmupInference,
  inferNextWarmupTime,
  loadAccountWarmupConfig,
  loadWarmupHistory,
  saveAccountWarmupConfig,
  saveWarmupRecord,
  type AccountWarmupConfig,
  type AccountWarmupRecord,
  type WarmupExecutionResult,
} from '../model/accountWarmup';

/** 凭据预热运行时状态 */
export interface AccountWarmupRuntimeState {
  /** 预热配置 */
  config: AccountWarmupConfig;
  /** 下次预热时间点 (毫秒) */
  nextWarmupAtMs: number | null;
  /** 最近一次执行记录 */
  lastRecord: AccountWarmupRecord | null;
  /** 当前是否正在执行中 */
  isRunning: boolean;
}

export interface UseAccountWarmupSchedulerProps {
  /** 当前展示或加载的凭据列表 */
  rows: AccountRow[];
  /** 刷新凭据额度的方法 (从 AccountsPage 传入) */
  refreshAccountQuota: (row: AccountRow) => Promise<void>;
  /** 额度窗口映射表 */
  quotaDisplayWindowsByRowKey?: Map<string, AccountQuotaDisplayWindow[]>;
}

export interface UseAccountWarmupSchedulerResult {
  /** 获取指定凭据的预热配置与运行时状态 */
  getWarmupState: (row: AccountRow) => AccountWarmupRuntimeState;
  /** 更新指定凭据的预热配置 */
  updateWarmupConfig: (row: AccountRow, nextConfig: AccountWarmupConfig) => void;
  /** 立即触发单次预热请求，并自动刷新该凭据额度 */
  runImmediateWarmup: (row: AccountRow, customConfig?: AccountWarmupConfig) => Promise<WarmupExecutionResult>;
  /** 刷新凭据额度并重新推断下次预热时间 */
  refreshAndReinfer: (row: AccountRow, delaySeconds?: number) => Promise<number | null>;
  /** 判断该凭据是否处于定时预热启用状态 */
  isWarmupScheduled: (rowKey: string) => boolean;
  /** 判断该凭据当前是否正在预热中 */
  isWarmupRunning: (rowKey: string) => boolean;
}

/** 调度器轮询间隔 (5秒) */
const SCHEDULER_TICK_INTERVAL_MS = 5000;

export function useAccountWarmupScheduler({
  rows,
  refreshAccountQuota,
  quotaDisplayWindowsByRowKey,
}: UseAccountWarmupSchedulerProps): UseAccountWarmupSchedulerResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  // 凭据预热运行时状态缓存映射表 (key: selectionKey)
  const [runtimeStates, setRuntimeStates] = useState<Record<string, AccountWarmupRuntimeState>>({});
  const runtimeStatesRef = useRef<Record<string, AccountWarmupRuntimeState>>({});
  runtimeStatesRef.current = runtimeStates;

  // 保持当前 rows 和 windows 的最新引用，避免定时器闭包过旧
  const rowsRef = useRef<AccountRow[]>(rows);
  rowsRef.current = rows;

  const windowsByRowKeyRef = useRef<Map<string, AccountQuotaDisplayWindow[]> | undefined>(
    quotaDisplayWindowsByRowKey
  );
  windowsByRowKeyRef.current = quotaDisplayWindowsByRowKey;

  const refreshAccountQuotaRef = useRef(refreshAccountQuota);
  refreshAccountQuotaRef.current = refreshAccountQuota;

  /**
   * 初始化指定凭据的运行时状态
   */
  const getWarmupState = useCallback((row: AccountRow): AccountWarmupRuntimeState => {
    const key = row.selectionKey;
    const existing = runtimeStatesRef.current[key];
    if (existing) {
      return existing;
    }

    // 从 localStorage 加载持久化配置与最近记录
    const config = loadAccountWarmupConfig(key, row.provider);
    const history = loadWarmupHistory(key);
    const lastRecord = history.length > 0 ? history[0] : null;

    let nextWarmupAtMs: number | null = null;
    if (config.enabled) {
      if (config.mode === 'inferred') {
        const windows = windowsByRowKeyRef.current?.get(key);
        const inferred = inferNextWarmupTime(row, config.inferredDelaySeconds, windows);
        nextWarmupAtMs = inferred.nextWarmupAtMs;
      } else {
        nextWarmupAtMs = Date.now() + config.intervalMinutes * 60 * 1000;
      }
    }

    const state: AccountWarmupRuntimeState = {
      config,
      nextWarmupAtMs,
      lastRecord,
      isRunning: false,
    };

    return state;
  }, []);

  /**
   * 更新指定凭据的预热配置
   */
  const updateWarmupConfig = useCallback(
    (row: AccountRow, nextConfig: AccountWarmupConfig) => {
      const key = row.selectionKey;
      saveAccountWarmupConfig(key, nextConfig);

      let nextWarmupAtMs: number | null = null;
      if (nextConfig.enabled) {
        if (nextConfig.mode === 'inferred') {
          const windows = windowsByRowKeyRef.current?.get(key);
          const inferred = inferNextWarmupTime(row, nextConfig.inferredDelaySeconds, windows);
          nextWarmupAtMs = inferred.nextWarmupAtMs;
        } else {
          nextWarmupAtMs = Date.now() + nextConfig.intervalMinutes * 60 * 1000;
        }
      }

      setRuntimeStates((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] || {
            lastRecord: null,
            isRunning: false,
          }),
          config: nextConfig,
          nextWarmupAtMs,
        },
      }));
    },
    []
  );

  /**
   * 立即执行单次预热推理请求，并自动刷新凭据额度
   */
  const runImmediateWarmup = useCallback(
    async (row: AccountRow, customConfig?: AccountWarmupConfig): Promise<WarmupExecutionResult> => {
      const key = row.selectionKey;
      const currentState = getWarmupState(row);
      const activeConfig = customConfig || currentState.config;

      // 标记为正在执行
      setRuntimeStates((prev) => ({
        ...prev,
        [key]: {
          ...currentState,
          config: activeConfig,
          isRunning: true,
        },
      }));

      try {
        // 1. 发起推理请求
        const result = await executeWarmupInference(row, activeConfig);

        // 2. 构造执行记录并持久化保存
        const record: AccountWarmupRecord = {
          timestamp: Date.now(),
          statusCode: result.statusCode,
          durationMs: result.durationMs,
          responseSnippet: result.responseSnippet,
          success: result.success,
          errorMessage: result.errorMessage,
          model: activeConfig.model,
          triggerSource: 'manual',
        };
        saveWarmupRecord(key, record);

        // 3. 自动触发凭据额度窗口刷新 (满足用户需求背景要求)
        try {
          await refreshAccountQuotaRef.current(row);
        } catch {
          // 额度刷新错误由 refreshAccountQuota 自身或外部拦截处理，不影响预热结果呈现
        }

        // 4. 若启用了基于重置时间的定时预热模式，在额度刷新后重新推算下次预热时间
        let nextWarmupAtMs = currentState.nextWarmupAtMs;
        if (activeConfig.enabled && activeConfig.mode === 'inferred') {
          const windows = windowsByRowKeyRef.current?.get(key);
          const inferred = inferNextWarmupTime(row, activeConfig.inferredDelaySeconds, windows);
          nextWarmupAtMs = inferred.nextWarmupAtMs;
        }

        // 5. 更新状态
        setRuntimeStates((prev) => ({
          ...prev,
          [key]: {
            ...currentState,
            config: activeConfig,
            lastRecord: record,
            nextWarmupAtMs,
            isRunning: false,
          },
        }));

        return result;
      } catch (err: unknown) {
        const errorText = err instanceof Error ? err.message : 'Warmup failed';
        const failRecord: AccountWarmupRecord = {
          timestamp: Date.now(),
          statusCode: 0,
          durationMs: 0,
          responseSnippet: errorText,
          success: false,
          errorMessage: errorText,
          model: activeConfig.model,
          triggerSource: 'manual',
        };
        saveWarmupRecord(key, failRecord);

        setRuntimeStates((prev) => ({
          ...prev,
          [key]: {
            ...currentState,
            config: activeConfig,
            lastRecord: failRecord,
            isRunning: false,
          },
        }));

        return {
          success: false,
          statusCode: 0,
          durationMs: 0,
          responseSnippet: errorText,
          errorMessage: errorText,
        };
      }
    },
    [getWarmupState]
  );

  /**
   * 刷新凭据额度并重新推断下次预热时间
   */
  const refreshAndReinfer = useCallback(
    async (row: AccountRow, delaySeconds?: number): Promise<number | null> => {
      const key = row.selectionKey;
      const currentState = getWarmupState(row);
      const safeDelay =
        typeof delaySeconds === 'number'
          ? delaySeconds
          : currentState.config.inferredDelaySeconds;

      // 1. 调用额度刷新
      await refreshAccountQuotaRef.current(row);

      // 2. 重新提取最新额度窗口并推断时间
      const windows = windowsByRowKeyRef.current?.get(key);
      const inferred = inferNextWarmupTime(row, safeDelay, windows);

      // 3. 更新状态
      setRuntimeStates((prev) => ({
        ...prev,
        [key]: {
          ...currentState,
          nextWarmupAtMs: inferred.nextWarmupAtMs,
        },
      }));

      return inferred.nextWarmupAtMs;
    },
    [getWarmupState]
  );

  /**
   * 检查凭据是否开启定时预热
   */
  const isWarmupScheduled = useCallback(
    (rowKey: string): boolean => {
      const state = runtimeStates[rowKey];
      return Boolean(state?.config?.enabled);
    },
    [runtimeStates]
  );

  /**
   * 检查凭据当前是否正在预热执行中
   */
  const isWarmupRunning = useCallback(
    (rowKey: string): boolean => {
      const state = runtimeStates[rowKey];
      return Boolean(state?.isRunning);
    },
    [runtimeStates]
  );

  /**
   * 前端调度器定时检查并在到达时间时自动触发预热
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const currentRows = rowsRef.current;
      const states = runtimeStatesRef.current;

      for (const row of currentRows) {
        const key = row.selectionKey;
        const itemState = states[key];
        if (!itemState || !itemState.config.enabled || itemState.isRunning) {
          continue;
        }

        const nextAt = itemState.nextWarmupAtMs;
        // 到达或超过指定预热时间
        if (typeof nextAt === 'number' && nextAt > 0 && now >= nextAt) {
          // 标记开始预热
          setRuntimeStates((prev) => ({
            ...prev,
            [key]: {
              ...itemState,
              isRunning: true,
            },
          }));

          // 异步触发预热操作
          void (async () => {
            try {
              const res = await executeWarmupInference(row, itemState.config);
              const triggerMode = itemState.config.mode === 'inferred' ? 'inferred' : 'interval';
              const record: AccountWarmupRecord = {
                timestamp: Date.now(),
                statusCode: res.statusCode,
                durationMs: res.durationMs,
                responseSnippet: res.responseSnippet,
                success: res.success,
                errorMessage: res.errorMessage,
                model: itemState.config.model,
                triggerSource: triggerMode,
              };
              saveWarmupRecord(key, record);

              // 自动刷新凭据额度
              try {
                await refreshAccountQuotaRef.current(row);
              } catch {
                // 忽略刷新异常
              }

              // 计算下一次预热时间
              let nextWarmupAtMs: number | null = null;
              if (itemState.config.mode === 'inferred') {
                const windows = windowsByRowKeyRef.current?.get(key);
                const inferred = inferNextWarmupTime(
                  row,
                  itemState.config.inferredDelaySeconds,
                  windows
                );
                nextWarmupAtMs = inferred.nextWarmupAtMs;
              } else {
                nextWarmupAtMs = Date.now() + itemState.config.intervalMinutes * 60 * 1000;
              }

              setRuntimeStates((prev) => ({
                ...prev,
                [key]: {
                  ...itemState,
                  lastRecord: record,
                  nextWarmupAtMs,
                  isRunning: false,
                },
              }));

              const rowName = row.accountLabel || row.fileName;
              showNotification(
                t('accounts.warmup_scheduled_executed', {
                  name: rowName,
                  status: res.statusCode,
                }),
                res.success ? 'info' : 'warning'
              );
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Schedule failed';
              setRuntimeStates((prev) => ({
                ...prev,
                [key]: {
                  ...itemState,
                  isRunning: false,
                },
              }));
            }
          })();
        }
      }
    }, SCHEDULER_TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [showNotification, t]);

  return {
    getWarmupState,
    updateWarmupConfig,
    runImmediateWarmup,
    refreshAndReinfer,
    isWarmupScheduled,
    isWarmupRunning,
  };
}
