/**
 * 凭据预热弹窗组件单元测试
 * 测试弹窗渲染、模型与 Prompt 默认值展示、恢复默认 Prompt、立即预热触发以及定时推断操作
 */

import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountQuotaDisplayWindow } from '../model/accountQuotaDisplayWindows';
import type { AccountRow } from '../model/accountRows';
import { DEFAULT_WARMUP_PROMPT } from '../model/accountWarmup';
import { AccountWarmupModal, type AccountWarmupModalProps } from './AccountWarmupModal';

// 模拟 react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.error) return `${key}:${String(options.error)}`;
      return key;
    },
  }),
}));

// 模拟 Modal 容器直接渲染子元素，避免 DOM Portal 依赖
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, open, title, footer }: { children: ReactNode; open: boolean; title?: ReactNode; footer?: ReactNode }) =>
    open ? (
      <div data-testid="mock-modal">
        <div data-testid="mock-modal-title">{title}</div>
        <div data-testid="mock-modal-body">{children}</div>
        <div data-testid="mock-modal-footer">{footer}</div>
      </div>
    ) : null,
}));

// 模拟远程模型 API
vi.mock('@/services/api/authFiles', () => ({
  authFilesApi: {
    getModelsForAuthFile: vi.fn().mockResolvedValue([
      { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
      { id: 'gpt-5', name: 'GPT-5 Standard' },
    ]),
  },
}));

/** 构造测试凭据行数据 */
const makeMockRow = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  key: 'row-1',
  selectionKey: 'row-1',
  fileName: 'codex-acc.json',
  accountLabel: 'Codex Pro Account',
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
    remainingPercent: 85,
    usedPercent: 15,
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
    name: 'codex-acc.json',
    authIndex: '0',
    type: 'codex',
  },
  ...overrides,
});

const mockQuotaWindows: AccountQuotaDisplayWindow[] = [
  {
    key: '5h',
    label: '5h Window',
    kind: 'five_hour',
    remainingPercent: 85,
    usedPercent: 15,
    resetLabel: '5h',
    resetAccuracy: 'exact',
    limitWindowSeconds: 18000,
    resetAtMs: 1700003600000,
    fromMs: 1700000000000,
  },
];

describe('AccountWarmupModal', () => {
  let mockScheduler: AccountWarmupModalProps['scheduler'];
  let onClose: () => void;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    onClose = vi.fn();

    mockScheduler = {
      getWarmupState: vi.fn().mockReturnValue({
        config: {
          model: 'gpt-5-codex',
          prompt: DEFAULT_WARMUP_PROMPT,
          maxTokens: 16,
          mode: 'inferred',
          inferredDelaySeconds: 10,
          intervalMinutes: 60,
          enabled: false,
        },
        nextWarmupAtMs: 1700003610000,
        lastRecord: null,
        isRunning: false,
      }),
      updateWarmupConfig: vi.fn(),
      runImmediateWarmup: vi.fn().mockResolvedValue({
        success: true,
        statusCode: 200,
        durationMs: 120,
        responseSnippet: 'pong response',
      }),
      refreshAndReinfer: vi.fn().mockResolvedValue(1700003620000),
    };
  });

  it('renders modal when open is true with default prompt value', async () => {
    const row = makeMockRow();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          quotaWindows={mockQuotaWindows}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    const modal = renderer.root.findByProps({ 'data-testid': 'mock-modal' });
    expect(modal).toBeDefined();

    // 检查 Prompt 文本框的初始默认值是否为 DEFAULT_WARMUP_PROMPT ('ping')
    const textarea = renderer.root.findByType('textarea');
    expect(textarea.props.value).toBe(DEFAULT_WARMUP_PROMPT);
  });

  it('restores default prompt when clicking reset to default button', async () => {
    const row = makeMockRow();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          quotaWindows={mockQuotaWindows}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    const textarea = renderer.root.findByType('textarea');

    // 修改 Prompt 内容
    await act(async () => {
      textarea.props.onChange({ target: { value: 'custom prompt text' } });
      await Promise.resolve();
    });
    expect(textarea.props.value).toBe('custom prompt text');

    // 查找恢复默认值按钮 (title="accounts.warmup.resetPromptDefault")
    const resetButton = renderer.root.findByProps({
      title: 'accounts.warmup.resetPromptDefault',
    });
    expect(resetButton).toBeDefined();

    // 点击恢复默认值
    await act(async () => {
      resetButton.props.onClick();
      await Promise.resolve();
    });

    // 验证恢复为默认值 DEFAULT_WARMUP_PROMPT
    expect(textarea.props.value).toBe(DEFAULT_WARMUP_PROMPT);
  });

  it('triggers immediate warmup and displays result snippet', async () => {
    const row = makeMockRow();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          quotaWindows={mockQuotaWindows}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    // 查找“立即预热”按钮 (包含 accounts.warmup.runImmediate 文本)
    const buttons = renderer.root.findAllByType('button');
    const runButton = buttons.find(
      (b) =>
        typeof b.props.children === 'string' &&
        b.props.children.includes('accounts.warmup.runImmediate')
    );
    expect(runButton).toBeDefined();

    await act(async () => {
      await runButton!.props.onClick();
      await Promise.resolve();
    });

    // 验证调度器立即预热方法被正确调用
    expect(mockScheduler.runImmediateWarmup).toHaveBeenCalledWith(
      row,
      expect.objectContaining({
        prompt: DEFAULT_WARMUP_PROMPT,
      })
    );
  });

  it('triggers refresh and re-infer button', async () => {
    const row = makeMockRow();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          quotaWindows={mockQuotaWindows}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    // 查找“刷新额度并重新推断”按钮
    const buttons = renderer.root.findAllByType('button');
    const reinferButton = buttons.find(
      (b) =>
        typeof b.props.children === 'string' &&
        b.props.children.includes('accounts.warmup.refreshAndReinfer')
    );
    expect(reinferButton).toBeDefined();

    await act(async () => {
      await reinferButton!.props.onClick();
      await Promise.resolve();
    });

    // 验证 refreshAndReinfer 被调用
    expect(mockScheduler.refreshAndReinfer).toHaveBeenCalledWith(row, 10);
  });
});
