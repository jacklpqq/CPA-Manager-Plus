/**
 * 凭据脱机预热服务端 API 客户端
 * 提供与 Go 服务端 (/v0/management/warmup) 的配置同步、状态查询、即时测试与历史日志拉取能力
 * 代码即文档：具备详尽的中文注解与类型定义
 */

import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import type { AccountWarmupMode } from '@/features/accounts/model/accountWarmup';

/** 服务端持久化的预热调度实体 */
export interface ServerWarmupSchedule {
  id?: number;
  selectionKey: string;
  accountKey: string;
  provider: string;
  prefix: string;
  model: string;
  prompt: string;
  maxTokens: number;
  mode: AccountWarmupMode;
  targetResetTime: string;
  leadHours: number;
  intervalMinutes: number;
  inferredDelaySeconds: number;
  enabled: boolean;
  nextRunAtMs: number;
  lastRunAtMs?: number;
  lastStatus?: 'success' | 'failed' | string;
  lastLatencyMs?: number;
  lastResponse?: string;
  lastError?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

/** 服务端持久化的预热执行明细日志实体 */
export interface ServerWarmupLog {
  id: number;
  scheduleId?: number;
  selectionKey: string;
  accountKey: string;
  provider: string;
  model: string;
  triggerSource: 'scheduled' | 'manual' | 'startup_catchup' | string;
  status: 'success' | 'failed' | string;
  statusCode: number;
  latencyMs: number;
  responseSnippet: string;
  errorMessage?: string;
  createdAtMs: number;
}

/** 立即预热推理响应结果 */
export interface ServerWarmupRunResult {
  success: boolean;
  statusCode: number;
  latencyMs: number;
  responseSnippet: string;
  errorMessage?: string;
}

export const warmupApi = {
  /**
   * 列出服务端所有已配置的预热调度列表
   */
  async listSchedules(scope?: ApiClientRequestScope): Promise<ServerWarmupSchedule[]> {
    const config = scope ? createScopedApiRequestConfig(scope) : undefined;
    const res = await apiClient.get<{ items: ServerWarmupSchedule[] }>('/warmup/schedules', config);
    return Array.isArray(res?.items) ? res.items : [];
  },

  /**
   * 获取指定凭据的服务端预热调度配置
   */
  async getSchedule(selectionKey: string, scope?: ApiClientRequestScope): Promise<ServerWarmupSchedule | null> {
    const config = scope ? createScopedApiRequestConfig(scope) : undefined;
    const res = await apiClient.get<{ item: ServerWarmupSchedule | null }>(
      `/warmup/schedules?selectionKey=${encodeURIComponent(selectionKey)}`,
      config
    );
    return res?.item ?? null;
  },

  /**
   * 保存或更新凭据预热调度配置到服务端 SQLite
   */
  async saveSchedule(
    schedule: ServerWarmupSchedule,
    scope?: ApiClientRequestScope
  ): Promise<ServerWarmupSchedule> {
    const config = scope ? createScopedApiRequestConfig(scope) : undefined;
    const res = await apiClient.put<ServerWarmupSchedule>('/warmup/schedules', schedule, config);
    return res;
  },

  /**
   * 从服务端删除指定凭据的预热调度
   */
  async deleteSchedule(selectionKey: string, scope?: ApiClientRequestScope): Promise<void> {
    const config = scope ? createScopedApiRequestConfig(scope) : undefined;
    await apiClient.delete(`/warmup/schedules?selectionKey=${encodeURIComponent(selectionKey)}`, config);
  },

  /**
   * 触发服务端立即执行一次预热测试
   */
  async runImmediate(
    selectionKey: string,
    customConfig?: Partial<ServerWarmupSchedule>,
    scope?: ApiClientRequestScope
  ): Promise<ServerWarmupRunResult> {
    const config = scope ? createScopedApiRequestConfig(scope) : undefined;
    const res = await apiClient.post<ServerWarmupRunResult>(
      '/warmup/run',
      {
        selectionKey,
        customConfig,
      },
      config
    );
    return res;
  },

  /**
   * 获取指定凭据的历史执行日志
   */
  async listLogs(
    selectionKey: string,
    limit: number = 20,
    scope?: ApiClientRequestScope
  ): Promise<ServerWarmupLog[]> {
    const config = scope ? createScopedApiRequestConfig(scope) : undefined;
    const res = await apiClient.get<{ items: ServerWarmupLog[] }>(
      `/warmup/logs?selectionKey=${encodeURIComponent(selectionKey)}&limit=${limit}`,
      config
    );
    return Array.isArray(res?.items) ? res.items : [];
  },
};
