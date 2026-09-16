/**
 * 凭据预热服务端 API 客户端单元测试
 */

import { describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { warmupApi, type ServerWarmupSchedule } from './warmup';

vi.mock('./client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  createScopedApiRequestConfig: vi.fn((scope) => ({
    headers: { Authorization: `Bearer ${scope.managementKey}` },
  })),
}));

describe('warmupApi', () => {
  it('listSchedules fetches and returns schedule items', async () => {
    const mockList: ServerWarmupSchedule[] = [
      {
        selectionKey: 'acc-1',
        accountKey: 'user@example.com',
        provider: 'codex',
        prefix: 'p390',
        model: 'p390/gpt-5.5',
        prompt: 'ping',
        maxTokens: 16,
        mode: 'target_reset',
        targetResetTime: '10:00',
        leadHours: 5,
        intervalMinutes: 60,
        inferredDelaySeconds: 10,
        enabled: true,
        nextRunAtMs: 1700000000000,
      },
    ];

    vi.mocked(apiClient.get).mockResolvedValueOnce({ items: mockList });

    const res = await warmupApi.listSchedules();
    expect(apiClient.get).toHaveBeenCalledWith('/warmup/schedules', undefined);
    expect(res).toEqual(mockList);
  });

  it('getSchedule retrieves single item by selectionKey', async () => {
    const mockItem: ServerWarmupSchedule = {
      selectionKey: 'acc-1',
      accountKey: 'user@example.com',
      provider: 'codex',
      prefix: 'p390',
      model: 'p390/gpt-5.5',
      prompt: 'ping',
      maxTokens: 16,
      mode: 'target_reset',
      targetResetTime: '10:00',
      leadHours: 5,
      intervalMinutes: 60,
      inferredDelaySeconds: 10,
      enabled: true,
      nextRunAtMs: 1700000000000,
    };

    vi.mocked(apiClient.get).mockResolvedValueOnce({ item: mockItem });

    const res = await warmupApi.getSchedule('acc-1');
    expect(apiClient.get).toHaveBeenCalledWith('/warmup/schedules?selectionKey=acc-1', undefined);
    expect(res).toEqual(mockItem);
  });

  it('saveSchedule sends PUT request with payload', async () => {
    const payload: ServerWarmupSchedule = {
      selectionKey: 'acc-1',
      accountKey: 'user@example.com',
      provider: 'codex',
      prefix: 'p390',
      model: 'p390/gpt-5.5',
      prompt: 'ping',
      maxTokens: 16,
      mode: 'target_reset',
      targetResetTime: '10:00',
      leadHours: 5,
      intervalMinutes: 60,
      inferredDelaySeconds: 10,
      enabled: true,
      nextRunAtMs: 0,
    };

    vi.mocked(apiClient.put).mockResolvedValueOnce({ ...payload, id: 1 });

    const res = await warmupApi.saveSchedule(payload);
    expect(apiClient.put).toHaveBeenCalledWith('/warmup/schedules', payload, undefined);
    expect(res.id).toBe(1);
  });

  it('deleteSchedule sends DELETE request', async () => {
    vi.mocked(apiClient.delete).mockResolvedValueOnce({ ok: true });

    await warmupApi.deleteSchedule('acc-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/warmup/schedules?selectionKey=acc-1', undefined);
  });

  it('runImmediate sends POST to /warmup/run', async () => {
    const mockResult = {
      success: true,
      statusCode: 200,
      latencyMs: 1200,
      responseSnippet: 'pong',
    };

    vi.mocked(apiClient.post).mockResolvedValueOnce(mockResult);

    const res = await warmupApi.runImmediate('acc-1');
    expect(apiClient.post).toHaveBeenCalledWith(
      '/warmup/run',
      { selectionKey: 'acc-1', customConfig: undefined },
      undefined
    );
    expect(res).toEqual(mockResult);
  });

  it('listLogs fetches execution history', async () => {
    const mockLogs = [
      {
        id: 1,
        selectionKey: 'acc-1',
        accountKey: 'user@example.com',
        provider: 'codex',
        model: 'p390/gpt-5.5',
        triggerSource: 'scheduled',
        status: 'success',
        statusCode: 200,
        latencyMs: 1200,
        responseSnippet: 'pong',
        createdAtMs: 1700000000000,
      },
    ];

    vi.mocked(apiClient.get).mockResolvedValueOnce({ items: mockLogs });

    const res = await warmupApi.listLogs('acc-1', 10);
    expect(apiClient.get).toHaveBeenCalledWith('/warmup/logs?selectionKey=acc-1&limit=10', undefined);
    expect(res).toEqual(mockLogs);
  });
});
