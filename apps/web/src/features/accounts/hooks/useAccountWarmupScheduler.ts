/**
 * 前端凭据预热调度器 Hook
 * 负责定时检查已开启定时预热的凭据，到达预定时间后自动发起预热推理请求并刷新额度
 * 代码即文档：具备详尽的中文注解与全套类型定义
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
  type InferredWarmupTimeResult,
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
  /** 额度窗口映射表 (可选) */
  quotaDisplayWindowsByRowKey?: Map<string, AccountQuotaDisplayWindow[]>;
  /** 获取特定凭据最新额度窗口的计算函数 (优于静态映射表，避免分页缺失与闭包过期) */
  getQuotaWindows?: (row: AccountRow) => AccountQuotaDisplayWindow[];
}

export interface UseAccountWarmupSchedulerResult {
  /** 获取指定凭据的预热配置与运行时状态 */
  getWarmupState: (row: AccountRow) => AccountWarmupRuntimeState;
  /** 更新指定凭据的预热配置 */
  updateWarmupConfig: (row: AccountRow, nextConfig: AccountWarmupConfig) => void;
  /** 立即触发单次预热请求，并自动刷新该凭据额度 */
  runImmediateWarmup: (row: AccountRow, customConfig?: AccountWarmupConfig) => Promise<WarmupExecutionResult>;
  /** 刷新凭据额度并重新推断下次预热时间，返回完整推断结果 */
  refreshAndReinfer: (row: AccountRow, delaySeconds?: number) => Promise<InferredWarmupTimeResult>;
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
  getQuotaWindows,
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

  const getQuotaWindowsRef = useRef(getQuotaWindows);
  getQuotaWindowsRef.current = getQuotaWindows;

  const refreshAccountQuotaRef = useRef(refreshAccountQuota);
  refreshAccountQuotaRef.current = refreshAccountQuota;

  /**
   * 辅助函数：安全解析凭据对应的额度窗口列表（优先使用动态函数，避免分页缺失）
   */
  const resolveQuotaWindows = useCallback((row: AccountRow): AccountQuotaDisplayWindow[] => {
    if (getQuotaWindowsRef.current) {
      return getQuotaWindowsRef.current(row);
    }
    return windowsByRowKeyRef.current?.get(row.selectionKey) || [];
  }, []);

  /**
   * 初始化指定凭据的运行时状态（若内存未命中则从 localStorage 读取并根据当前窗口推断）
   */
  const getWarmupState = useCallback(
    (row: AccountRow): AccountWarmupRuntimeState => {
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
          const windows = resolveQuotaWindows(row);
          const inferred = inferNextWarmupTime(row, config.inferredDelaySeconds, windows);
          // 若推算出的时间在未来，则正常排期；若在过去且已跑过该时间戳，则避免立即重跑
          if (inferred.nextWarmupAtMs && inferred.isFuture) {
            nextWarmupAtMs = inferred.nextWarmupAtMs;
          } else if (
            inferred.nextWarmupAtMs &&
            (!lastRecord || lastRecord.timestamp < (inferred.resetAtMs || 0))
          ) {
            nextWarmupAtMs = inferred.nextWarmupAtMs;
          }
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

      runtimeStatesRef.current[key] = state;
      return state;
    },
    [resolveQuotaWindows]
  );

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
          const windows = resolveQuotaWindows(row);
          const inferred = inferNextWarmupTime(row, nextConfig.inferredDelaySeconds, windows);
          nextWarmupAtMs = inferred.isFuture ? inferred.nextWarmupAtMs : null;
        } else {
          nextWarmupAtMs = Date.now() + nextConfig.intervalMinutes * 60 * 1000;
        }
      }

      setRuntimeStates((prev) => {
        const updated = {
          ...prev,
          [key]: {
            ...(prev[key] || {
              lastRecord: null,
              isRunning: false,
            }),
            config: nextConfig,
            nextWarmupAtMs,
          },
        };
        runtimeStatesRef.current = updated;
        return updated;
      });
    },
    [resolveQuotaWindows]
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
      setRuntimeStates((prev) => {
        const updated = {
          ...prev,
          [key]: {
            ...currentState,
            config: activeConfig,
            isRunning: true,
          },
        };
        runtimeStatesRef.current = updated;
        return updated;
      });

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

        // 3. 自动触发凭据额度窗口刷新 (满足需求背景核心联动逻辑)
        try {
          await refreshAccountQuotaRef.current(row);
        } catch {
          // 额度刷新错误由 refreshAccountQuota 自身处理，不阻断预热结果呈现
        }

        // 提取刷新后的最新行数据与额度窗口
        const freshRow = rowsRef.current.find((r) => r.selectionKey === key) || row;
        const freshWindows = resolveQuotaWindows(freshRow);

        // 4. 若启用了基于重置时间的定时预热模式，在额度刷新后重新推算下次预热时间
        let nextWarmupAtMs = currentState.nextWarmupAtMs;
        if (activeConfig.enabled && activeConfig.mode === 'inferred') {
          const inferred = inferNextWarmupTime(freshRow, activeConfig.inferredDelaySeconds, freshWindows);
          nextWarmupAtMs = inferred.isFuture ? inferred.nextWarmupAtMs : null;
        }

        // 5. 更新状态
        setRuntimeStates((prev) => {
          const updated = {
            ...prev,
            [key]: {
              ...currentState,
              config: activeConfig,
              lastRecord: record,
              nextWarmupAtMs,
              isRunning: false,
            },
          };
          runtimeStatesRef.current = updated;
          return updated;
        });

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

        setRuntimeStates((prev) => {
          const updated = {
            ...prev,
            [key]: {
              ...currentState,
              config: activeConfig,
              lastRecord: failRecord,
              isRunning: false,
            },
          };
          runtimeStatesRef.current = updated;
          return updated;
        });

        return {
          success: false,
          statusCode: 0,
          durationMs: 0,
          responseSnippet: errorText,
          errorMessage: errorText,
        };
      }
    },
    [getWarmupState, resolveQuotaWindows]
  );

  /**
   * 刷新凭据额度并重新推断下次预热时间
   */
  const refreshAndReinfer = useCallback(
    async (row: AccountRow, delaySeconds?: number): Promise<InferredWarmupTimeResult> => {
      const key = row.selectionKey;
      const currentState = getWarmupState(row);
      const safeDelay =
        typeof delaySeconds === 'number'
          ? delaySeconds
          : currentState.config.inferredDelaySeconds;

      // 1. 调用额度刷新
      await refreshAccountQuotaRef.current(row);

      // 2. 重新提取刷新后的最新凭据行与额度窗口并推断时间
      const freshRow = rowsRef.current.find((r) => r.selectionKey === key) || row;
      const windows = resolveQuotaWindows(freshRow);
      const inferred = inferNextWarmupTime(freshRow, safeDelay, windows);

      // 3. 仅当重置时间在未来时更新下次时间，若已到期则置空避免死循环
      const nextWarmupAtMs = inferred.isFuture ? inferred.nextWarmupAtMs : null;

      // 4. 更新状态
      setRuntimeStates((prev) => {
        const updated = {
          ...prev,
          [key]: {
            ...currentState,
            nextWarmupAtMs,
          },
        };
        runtimeStatesRef.current = updated;
        return updated;
      });

      return inferred;
    },
    [getWarmupState, resolveQuotaWindows]
  );

  /**
   * 检查凭据是否开启定时预热（优先内存，兜底持久化）
   */
  const isWarmupScheduled = useCallback(
    (rowKey: string): boolean => {
      const state = runtimeStates[rowKey];
      if (state) {
        return Boolean(state.config?.enabled);
      }
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          const raw = window.localStorage.getItem(`cpamp_account_warmup_config_${rowKey}`);
          if (raw) {
            const parsed = JSON.parse(raw);
            return Boolean(parsed?.enabled);
          }
        }
      } catch {
        // 忽略读取异常
      }
      return false;
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
    // 挂载或 rows 变更时，自动水合所有已保存定时预热配置的凭据状态
    const currentRows = rowsRef.current;
    for (const row of currentRows) {
      const key = row.selectionKey;
      if (!runtimeStatesRef.current[key]) {
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(`cpamp_account_warmup_config_${key}`);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && parsed.enabled) {
                getWarmupState(row);
              }
            }
          }
        } catch {
          // 忽略初始化错误
        }
      }
    }

    const timer = setInterval(() => {
      const now = Date.now();
      const rowsSnapshot = rowsRef.current;

      for (const row of rowsSnapshot) {
        const key = row.selectionKey;
        let itemState = runtimeStatesRef.current[key];
        if (!itemState) {
          itemState = getWarmupState(row);
        }
        if (!itemState || !itemState.config.enabled || itemState.isRunning) {
          continue;
        }

        const nextAt = itemState.nextWarmupAtMs;
        // 到达或超过指定预热时间
        if (typeof nextAt === 'number' && nextAt > 0 && now >= nextAt) {
          // 防死循环保护：若推断模式下最近一次记录时间戳晚于或等于该预热时间点，则跳过
          if (
            itemState.config.mode === 'inferred' &&
            itemState.lastRecord &&
            itemState.lastRecord.timestamp >= nextAt
          ) {
            continue;
          }

          // 标记开始预热
          setRuntimeStates((prev) => {
            const updated = {
              ...prev,
              [key]: {
                ...itemState,
                isRunning: true,
              },
            };
            runtimeStatesRef.current = updated;
            return updated;
          });

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
                const freshRow = rowsRef.current.find((r) => r.selectionKey === key) || row;
                const windows = resolveQuotaWindows(freshRow);
                const inferred = inferNextWarmupTime(
                  freshRow,
                  itemState.config.inferredDelaySeconds,
                  windows
                );
                // 仅当推断时间属于未来时设定下一次执行，避免过去时间 5 秒死循环
                nextWarmupAtMs =
                  inferred.nextWarmupAtMs && inferred.nextWarmupAtMs > Date.now()
                    ? inferred.nextWarmupAtMs
                    : null;
              } else {
                nextWarmupAtMs = Date.now() + itemState.config.intervalMinutes * 60 * 1000;
              }

              setRuntimeStates((prev) => {
                const updated = {
                  ...prev,
                  [key]: {
                    ...itemState,
                    lastRecord: record,
                    nextWarmupAtMs,
                    isRunning: false,
                  },
                };
                runtimeStatesRef.current = updated;
                return updated;
              });

              const rowName = row.accountLabel || row.fileName;
              showNotification(
                t('accounts.warmup_scheduled_executed', {
                  name: rowName,
                  status: res.statusCode,
                }),
                res.success ? 'info' : 'warning'
              );
            } catch (err: unknown) {
              setRuntimeStates((prev) => {
                const updated = {
                  ...prev,
                  [key]: {
                    ...itemState,
                    isRunning: false,
                  },
                };
                runtimeStatesRef.current = updated;
                return updated;
              });
            }
          })();
        }
      }
    }, SCHEDULER_TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [getWarmupState, resolveQuotaWindows, showNotification, t]);

  return {
    getWarmupState,
    updateWarmupConfig,
    runImmediateWarmup,
    refreshAndReinfer,
    isWarmupScheduled,
    isWarmupRunning,
  };
}

