/**
 * 凭据预热弹窗组件单元测试
 * 测试弹窗渲染、模型与 Prompt 默认值展示、恢复默认 Prompt、立即预热触发以及定时推断操作
 */

import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountQuotaDisplayWindow } from '../model/accountQuotaDisplayWindows';
import type { AccountRow } from '../model/accountRows';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/useAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useModelsStore } from '@/stores/useModelsStore';
import { DEFAULT_WARMUP_PROMPT } from '../model/accountWarmup';
import { AccountWarmupModal, type AccountWarmupModalProps } from './AccountWarmupModal';

/**
 * 辅助函数：根据包含的翻译键文本递归检索目标 Button 实例
 */
const findButtonByText = (root: ReactTestRenderer['root'], targetText: string) => {
  const checkValue = (val: unknown): boolean => {
    if (typeof val === 'string') return val.includes(targetText);
    if (Array.isArray(val)) return val.some(checkValue);
    if (val && typeof val === 'object' && 'props' in val) {
      return checkValue((val as { props?: { children?: unknown } }).props?.children);
    }
    return false;
  };

  const buttons = root.findAllByType(Button);
  return buttons.find((b) => checkValue(b.props.children));
};

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
        {footer && <div data-testid="mock-modal-footer">{footer}</div>}
      </div>
    ) : null,
}));

// 模拟 AutocompleteInput 组件，避免在 Node 环境执行 document 事件监听与 DOM 计算
vi.mock('@/components/ui/AutocompleteInput', () => ({
  AutocompleteInput: ({
    value,
    onChange,
    placeholder,
    disabled,
    options,
  }: {
    value?: string;
    onChange?: (val: string) => void;
    placeholder?: string;
    disabled?: boolean;
    options?: unknown[];
  }) => (
    <input
      data-testid="mock-autocomplete-input"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      data-options={JSON.stringify(options)}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

// 模拟远程模型 API
const { mockGetModelsForAuthFile, mockGetModelDefinitions } = vi.hoisted(() => ({
  mockGetModelsForAuthFile: vi.fn().mockResolvedValue([
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'pqq/gpt-5.5', name: 'PQQ GPT-5.5' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  ]),
  mockGetModelDefinitions: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    authFilesApi: {
      getModelsForAuthFile: mockGetModelsForAuthFile,
      getModelDefinitions: mockGetModelDefinitions,
    },
  };
});

vi.mock('@/services/api/authFiles', () => ({
  authFilesApi: {
    getModelsForAuthFile: mockGetModelsForAuthFile,
    getModelDefinitions: mockGetModelDefinitions,
  },
}));

vi.mock('@/services/api/warmup', () => ({
  warmupApi: {
    getSchedule: vi.fn().mockResolvedValue(null),
    listSchedules: vi.fn().mockResolvedValue([]),
    saveSchedule: vi.fn().mockImplementation((sched) => Promise.resolve(sched)),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    runImmediate: vi.fn().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 100, responseSnippet: 'pong' }),
    listLogs: vi.fn().mockResolvedValue([]),
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
    toMs: 1700003600000,
  },
];

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

describe('AccountWarmupModal', () => {
  let mockScheduler: AccountWarmupModalProps['scheduler'];
  let onClose: () => void;

  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      ...(typeof window !== 'undefined' ? window : {}),
      localStorage: storage,
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(),
      querySelectorAll: vi.fn(),
      getElementById: vi.fn(),
    });
    vi.clearAllMocks();
    onClose = vi.fn();

    useModelsStore.setState({ models: [], loading: false, error: null, cache: null });
    useAuthStore.setState({ apiBase: 'http://127.0.0.1:8317' } as unknown as any);
    useConfigStore.setState({ config: { apiKeys: ['test-cpa-key'] } } as unknown as any);

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
      refreshAndReinfer: vi.fn().mockResolvedValue({
        nextWarmupAtMs: 1700003620000,
        resetAtMs: 1700003610000,
        sourceWindowLabel: '5h Window',
        isFuture: true,
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    // 查找恢复默认值按钮 (title="accounts.warmup_prompt_restore_default")
    const resetButton = renderer.root.findByProps({
      title: 'accounts.warmup_prompt_restore_default',
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

    // 查找“立即预热”按钮 (包含 accounts.warmup_now_button 文本)
    const runButton = findButtonByText(renderer.root, 'accounts.warmup_now_button');
    expect(runButton).toBeDefined();

    await act(async () => {
      await runButton!.props.onClick?.();
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
    vi.mocked(mockScheduler.getWarmupState).mockReturnValue({
      config: {
        model: 'gpt-5-codex',
        prompt: DEFAULT_WARMUP_PROMPT,
        maxTokens: 16,
        mode: 'inferred',
        inferredDelaySeconds: 10,
        intervalMinutes: 60,
        enabled: true,
      },
      nextWarmupAtMs: 1700003610000,
      lastRecord: null,
      isRunning: false,
    });

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

    // 查找“刷新额度并重新推断”按钮 (包含 accounts.warmup_inferred_refresh_recalculate 文本)
    const reinferButton = findButtonByText(renderer.root, 'accounts.warmup_inferred_refresh_recalculate');
    expect(reinferButton).toBeDefined();

    await act(async () => {
      await reinferButton!.props.onClick?.();
      await Promise.resolve();
    });

    // 验证 refreshAndReinfer 被调用
    expect(mockScheduler.refreshAndReinfer).toHaveBeenCalledWith(row, 10);
  });

  it('fetches dynamic models using selector and requestScope, and auto selects first dynamic model', async () => {
    mockGetModelsForAuthFile.mockClear();
    const row = makeMockRow({
      raw: {
        name: 'custom-file.json',
        id: 'runtime-id-123',
        type: 'codex',
      },
    });

    const mockRequestScope: AccountWarmupModalProps['requestScope'] = {
      apiBase: 'https://api.example.com',
      managementKey: 'test-management-key',
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          requestScope={mockRequestScope}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    // 验证以 runtimeId 或 name 调用了真实 API 并传递了 requestScope
    expect(mockGetModelsForAuthFile).toHaveBeenCalledWith('runtime-id-123', mockRequestScope);

    // 验证 AutocompleteInput 被自动设置为动态列表首项 'gpt-5.5'
    const input = renderer.root.findByProps({ 'data-testid': 'mock-autocomplete-input' });
    expect(input.props.value).toBe('gpt-5.5');
  });

  it('allows manually refreshing dynamic models by clicking refresh button', async () => {
    mockGetModelsForAuthFile.mockClear();
    const row = makeMockRow();
    let renderer!: ReactTestRenderer;

    const onRefreshModels = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          onRefreshModels={onRefreshModels}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    expect(mockGetModelsForAuthFile).toHaveBeenCalledTimes(1);

    // 验证展示了 CPA 网关标准协议端点提示
    const bodyStr = JSON.stringify(renderer.toJSON());
    expect(bodyStr).toContain('/v1/chat/completions');

    // 找到刷新模型列表按钮 (title="accounts.warmup_model_refresh")
    const refreshBtn = renderer.root.findByProps({ title: 'accounts.warmup_model_refresh' });
    expect(refreshBtn).toBeDefined();

    await act(async () => {
      refreshBtn.props.onClick();
      await Promise.resolve();
    });

    // 验证触发了外部模型刷新回调
    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    // 再次触发加载
    expect(mockGetModelsForAuthFile).toHaveBeenCalledTimes(2);
  });

  it('supports saving target_reset mode with custom reset time and lead hours', async () => {
    const row = makeMockRow();
    let renderer!: ReactTestRenderer;

    // 模拟凭据已配置为 target_reset 模式
    vi.mocked(mockScheduler.getWarmupState).mockReturnValue({
      config: {
        model: 'gpt-5.5',
        prompt: DEFAULT_WARMUP_PROMPT,
        maxTokens: 16,
        mode: 'target_reset',
        inferredDelaySeconds: 10,
        intervalMinutes: 60,
        enabled: true,
        targetResetTime: '09:20',
        targetLeadHours: 5,
      },
      nextWarmupAtMs: 1700000000000,
      lastRecord: null,
      isRunning: false,
    });

    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    // 点击保存按钮
    const saveBtn = findButtonByText(renderer.root, 'common.save');
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn!.props.onClick?.();
      await Promise.resolve();
    });

    expect(mockScheduler.updateWarmupConfig).toHaveBeenCalledWith(
      row,
      expect.objectContaining({
        mode: 'target_reset',
        targetResetTime: '09:20',
        targetLeadHours: 5,
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('links directly with global useModelsStore and prioritizes current account prefix', async () => {
    useModelsStore.setState({
      models: [
        { name: 'p390/gpt-5.5' },
        { name: 'pqq/gpt-5.5' },
        { name: 'gpt-6-astra' },
      ],
      loading: false,
      error: null,
      cache: null,
    });

    const row = makeMockRow({
      raw: {
        name: 'p390.json',
        prefix: 'p390',
        type: 'codex',
      },
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AccountWarmupModal
          open={true}
          row={row}
          onClose={onClose}
          scheduler={mockScheduler}
        />
      );
      await Promise.resolve();
    });

    // 验证自动优先选中当前账号前缀模型 p390/gpt-5.5，且候选列表中绝不包含其他账号 pqq/ 的模型
    const input = renderer.root.findByProps({ 'data-testid': 'mock-autocomplete-input' });
    expect(input.props.value).toBe('p390/gpt-5.5');
    const options = JSON.parse(input.props['data-options']);
    expect(options[0]).toBe('p390/gpt-5.5');
    expect(options).toContain('p390/gpt-6-astra');
    expect(options).not.toContain('pqq/gpt-5.5');
  });
});
