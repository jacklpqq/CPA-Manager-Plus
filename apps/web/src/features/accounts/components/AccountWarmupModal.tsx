/**
 * 凭据预热弹窗组件
 * 支持立即预热（推理测试、耗时/状态码/模型返回内容展示、自动刷新额度）
 * 支持定时预热：
 * 1. 自动推断模式（读取 5h 主额度窗口重置时间推断下次预热时间）
 * 2. 目标重置时间模式（指定每日期望窗口重置时间如 09:20，凭证提前 5H 在 04:20 预热）
 * 3. 固定间隔模式（按分钟周期性预热）
 * 支持指定模型（通过凭据真实动态获取可用模型列表 + 前缀与排除规则过滤 + 刷新按钮）
 * 支持自定义发送内容（默认 ping，支持恢复默认与持久化）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconCheck,
  IconClock,
  IconFlame,
  IconRefreshCw,
  IconRotateCcw,
  IconTriangleAlert,
  IconX,
import type { AuthFilesApiRequestScope } from '@/services/api';
import { formatQuotaResetTime } from '@/utils/quota/formatters';
import type { AccountQuotaDisplayWindow } from '../model/accountQuotaDisplayWindows';
import type { AccountRow } from '../model/accountRows';
import {
  DEFAULT_INFERRED_DELAY_SECONDS,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_TARGET_LEAD_HOURS,
  DEFAULT_TARGET_RESET_TIME,
  DEFAULT_WARMUP_MAX_TOKENS,
  DEFAULT_WARMUP_PROMPT,
  calculateTargetResetWarmupTime,
  fetchAuthFileSupportedModels,
  getDefaultWarmupEndpoint,
  getWarmupCandidateModels,
  inferNextWarmupTime,
  loadWarmupPrompt,
  saveWarmupPrompt,
  type AccountWarmupConfig,
  type AccountWarmupMode,
  type InferredWarmupTimeResult,
  type TargetResetWarmupTimeResult,
  type WarmupExecutionResult,
} from '../model/accountWarmup';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import type { AccountWarmupRuntimeState } from '../hooks/useAccountWarmupScheduler';
import styles from './AccountWarmupModal.module.scss';

export interface AccountWarmupModalProps {
  /** 弹窗是否可见 */
  open: boolean;
  /** 目标凭据行 */
  row: AccountRow | null;
  /** 关闭弹窗 */
  onClose: () => void;
  /** 凭据的额度窗口列表 */
  quotaWindows?: AccountQuotaDisplayWindow[];
  /** 可选的 API 请求作用域 (用于多工作空间/实例隔离) */
  requestScope?: AuthFilesApiRequestScope;
  /** 父组件传入的已缓存/加载的动态模型列表 */
  modelsList?: AuthFileModelItem[];
  /** 父组件传入的官方渠道模型定义列表 */
  modelDefinitions?: AuthFileModelItem[];
  /** 全局排除规则 */
  globalExcluded?: Record<string, string[]>;
  /** 外部刷新模型列表回调 */
  onRefreshModels?: () => Promise<void> | void;
  /** 调度器控制对象 */
  scheduler: {
    getWarmupState: (row: AccountRow) => AccountWarmupRuntimeState;
    updateWarmupConfig: (row: AccountRow, nextConfig: AccountWarmupConfig) => void;
    runImmediateWarmup: (row: AccountRow, customConfig?: AccountWarmupConfig) => Promise<WarmupExecutionResult>;
    refreshAndReinfer: (row: AccountRow, delaySeconds?: number) => Promise<InferredWarmupTimeResult>;
  };
}

/**
 * 格式化相对倒计时文本
 */
function formatCountdownText(targetMs: number): string {
  const diffSeconds = Math.round((targetMs - Date.now()) / 1000);
  if (diffSeconds < -60) return '已过期，请刷新额度';
  if (diffSeconds <= 0) return '即将执行';
  if (diffSeconds < 60) return `${diffSeconds} 秒后`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} 分钟后`;
  const diffHours = (diffSeconds / 3600).toFixed(1);
  return `${diffHours} 小时后`;
}

/**
 * 格式化时间戳为本地易读时间字符串
 */
function formatTimestamp(timestampMs: number | null): string {
  if (!timestampMs || timestampMs <= 0) return '-';
  try {
    const d = new Date(timestampMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(timestampMs);
  }
}

export function AccountWarmupModal({
  open,
  row,
  onClose,
  quotaWindows,
  requestScope,
  modelsList,
  modelDefinitions,
  globalExcluded = {},
  onRefreshModels,
  scheduler,
}: AccountWarmupModalProps) {
  const { t } = useTranslation();

  // 动态模型列表 (复用系统已有模型支持列表方法获取)
  const [dynamicModels, setDynamicModels] = useState<Array<{ id: string; name?: string; display_name?: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // 本地正在执行立即预热标识
  const [isWarmingUp, setIsWarmingUp] = useState(false);
  // 本地正在刷新额度并推断标识
  const [isRefreshingInference, setIsRefreshingInference] = useState(false);
  // 最近一次预热执行结果（本地即时展示）
  const [localLastResult, setLocalLastResult] = useState<WarmupExecutionResult | null>(null);
  // 刷新额度后重新推断的即时结果
  const [refreshedInferredResult, setRefreshedInferredResult] = useState<InferredWarmupTimeResult | null>(null);

  // 表单状态
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_WARMUP_PROMPT);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_WARMUP_MAX_TOKENS);
  const [mode, setMode] = useState<AccountWarmupMode>('inferred');
  const [inferredDelaySeconds, setInferredDelaySeconds] = useState(DEFAULT_INFERRED_DELAY_SECONDS);
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_INTERVAL_MINUTES);
  const [targetResetTime, setTargetResetTime] = useState(DEFAULT_TARGET_RESET_TIME);
  const [targetLeadHours, setTargetLeadHours] = useState(DEFAULT_TARGET_LEAD_HOURS);
  const [enabled, setEnabled] = useState(false);

  // 动态拉取该认证文件支持的真实可用模型列表 (复用系统已有模型支持列表方法)
  const loadDynamicModels = useCallback(async () => {
    if (!row) return [];
    setModelsLoading(true);
    try {
      const items = await fetchAuthFileSupportedModels(row, requestScope, globalExcluded, {
        modelsList,
        modelDefinitions,
      });
      setDynamicModels(items);
      return items;
    } catch {
      setDynamicModels([]);
      return [];
    } finally {
      setModelsLoading(false);
    }
  }, [row, requestScope, globalExcluded, modelsList, modelDefinitions]);

  // 主动刷新凭证模型列表并即时联动更新当前选中模型
  const handleRefreshModels = useCallback(async () => {
    if (!row) return;
    setModelsLoading(true);
    try {
      if (onRefreshModels) {
        await onRefreshModels();
      }
      const items = await loadDynamicModels();
      if (items && items.length > 0) {
        const candidates = getWarmupCandidateModels(row.provider, items, { row });
        if (candidates.length > 0) {
          setModel(candidates[0]);
        }
      }
    } finally {
      setModelsLoading(false);
    }
  }, [loadDynamicModels, onRefreshModels, row]);

  // 当外部异步拉取的 modelsList 到达时，联动重新拉取可用模型
  useEffect(() => {
    if (!open || !row) return;
    if (modelsList && modelsList.length > 0) {
      void loadDynamicModels();
    }
  }, [modelsList, open, row, loadDynamicModels]);

  // 初始化与同步状态
  useEffect(() => {
    if (!open || !row) return;

    // 获取该凭据已有预热状态
    const state = scheduler.getWarmupState(row);
    setModel(state.config.model);
    setPrompt(state.config.prompt || loadWarmupPrompt());
    setMaxTokens(state.config.maxTokens || DEFAULT_WARMUP_MAX_TOKENS);
    setMode(state.config.mode || 'inferred');
    setInferredDelaySeconds(state.config.inferredDelaySeconds ?? DEFAULT_INFERRED_DELAY_SECONDS);
    setIntervalMinutes(state.config.intervalMinutes || DEFAULT_INTERVAL_MINUTES);
    setTargetResetTime(state.config.targetResetTime || DEFAULT_TARGET_RESET_TIME);
    setTargetLeadHours(state.config.targetLeadHours ?? DEFAULT_TARGET_LEAD_HOURS);
    setEnabled(Boolean(state.config.enabled));
    setLocalLastResult(null);
    setRefreshedInferredResult(null);

    // 动态拉取真实模型，并智能联动默认选中模型
    let isCancelled = false;
    void loadDynamicModels().then((items) => {
      if (isCancelled || !items || items.length === 0) return;
      const candidates = getWarmupCandidateModels(row.provider, items, { row });
      // 若当前未指定模型，或之前保存的模型不在当前可用候选列表中，自动选中真实首选模型
      if (candidates.length > 0 && (!state.config.model || !candidates.includes(state.config.model))) {
        setModel(candidates[0]);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [open, row, scheduler, loadDynamicModels]);

  // 计算候选模型（结合凭据 prefix 与 excluded-models 过滤后的真实可用模型）
  const candidateModels = useMemo(() => {
    if (!row) return [];
    return getWarmupCandidateModels(row.provider, dynamicModels, { row });
  }, [row, dynamicModels]);

  // 基础推断下次时间计算
  const defaultInferred = useMemo(() => {
    if (!row) {
      return { nextWarmupAtMs: null, resetAtMs: null, sourceWindowLabel: null, isFuture: false };
    }
    return inferNextWarmupTime(row, inferredDelaySeconds, quotaWindows);
  }, [row, inferredDelaySeconds, quotaWindows]);

  // 目标重置时间模式下的预热时间计算
  const targetResetInfo = useMemo<TargetResetWarmupTimeResult>(() => {
    return calculateTargetResetWarmupTime(targetResetTime, targetLeadHours);
  }, [targetResetTime, targetLeadHours]);

  // 优先采用最新主动刷新推断得出的结果
  const inferredTimeInfo = refreshedInferredResult ?? defaultInferred;

  // 恢复 Prompt 默认值按钮处理函数
  const handleRestoreDefaultPrompt = useCallback(() => {
    setPrompt(DEFAULT_WARMUP_PROMPT);
    saveWarmupPrompt(DEFAULT_WARMUP_PROMPT);
  }, []);

  // Prompt 输入变更处理函数
  const handlePromptChange = useCallback((value: string) => {
    setPrompt(value);
    saveWarmupPrompt(value);
  }, []);

  // 当前激活配置对象
  const activeConfig = useMemo<AccountWarmupConfig>(() => {
    return {
      model: model || (candidateModels[0] ?? 'gpt-4o-mini'),
      prompt: prompt || DEFAULT_WARMUP_PROMPT,
      maxTokens: maxTokens > 0 ? maxTokens : DEFAULT_WARMUP_MAX_TOKENS,
      mode,
      inferredDelaySeconds: inferredDelaySeconds >= 0 ? inferredDelaySeconds : DEFAULT_INFERRED_DELAY_SECONDS,
      intervalMinutes: intervalMinutes > 0 ? intervalMinutes : DEFAULT_INTERVAL_MINUTES,
      enabled,
      targetResetTime,
      targetLeadHours: targetLeadHours >= 0 ? targetLeadHours : DEFAULT_TARGET_LEAD_HOURS,
    };
  }, [
    candidateModels,
    enabled,
    inferredDelaySeconds,
    intervalMinutes,
    maxTokens,
    mode,
    model,
    prompt,
    targetResetTime,
    targetLeadHours,
  ]);

  // 立即预热点击事件
  const handleRunImmediateWarmup = useCallback(async () => {
    if (!row || isWarmingUp) return;
    setIsWarmingUp(true);
    try {
      const res = await scheduler.runImmediateWarmup(row, activeConfig);
      setLocalLastResult(res);
    } finally {
      setIsWarmingUp(false);
    }
  }, [row, isWarmingUp, scheduler, activeConfig]);

  // 刷新额度并重新推断点击事件
  const handleRefreshAndReinfer = useCallback(async () => {
    if (!row || isRefreshingInference) return;
    setIsRefreshingInference(true);
    try {
      const res = await scheduler.refreshAndReinfer(row, inferredDelaySeconds);
      setRefreshedInferredResult(res);
    } finally {
      setIsRefreshingInference(false);
    }
  }, [row, isRefreshingInference, scheduler, inferredDelaySeconds]);

  // 保存调度配置
  const handleSaveConfig = useCallback(() => {
    if (!row) return;
    scheduler.updateWarmupConfig(row, activeConfig);
    onClose();
  }, [row, scheduler, activeConfig, onClose]);

  if (!row) return null;

  const currentRuntimeState = scheduler.getWarmupState(row);
  const displayLastRecord = localLastResult
    ? {
        timestamp: Date.now(),
        statusCode: localLastResult.statusCode,
        durationMs: localLastResult.durationMs,
        responseSnippet: localLastResult.responseSnippet,
        success: localLastResult.success,
        errorMessage: localLastResult.errorMessage,
        model: activeConfig.model,
        triggerSource: 'manual' as const,
      }
    : currentRuntimeState.lastRecord;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconFlame size={18} style={{ color: 'var(--data-amber-base, #f59e0b)' }} />
          <span>{t('accounts.warmup_title', { name: row.accountLabel || row.fileName })}</span>
        </div>
      }
      width={640}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRunImmediateWarmup()}
              loading={isWarmingUp}
              disabled={row.runtimeOnly}
            >
              <IconFlame size={14} />
              {t('accounts.warmup_now_button')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSaveConfig}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.warmupContainer}>
        {/* 凭据概要信息行 */}
        <div className={styles.headerInfo}>
          <span className={styles.providerBadge}>{row.provider}</span>
          <span className={styles.accountName}>{row.accountLabel || row.fileName}</span>
          {row.authIndex ? (
            <span className={styles.authIndexTag}>Index: {row.authIndex}</span>
          ) : null}
          {row.disabled ? (
            <span style={{ fontSize: 12, color: 'var(--data-red-base, #ef4444)' }}>
              ({t('accounts.disabled')})
            </span>
          ) : null}
        </div>

        {/* Section 1: 模型与内容配置 */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>{t('accounts.warmup_config_section')}</span>
          </div>

          <div className={styles.formGrid}>
            {/* 指定模型 (凭据真实动态可用列表 + 前缀与排除规则过滤 + 刷新按钮) */}
            <div className={styles.fieldGroup}>
              <div className={styles.fieldLabelRow}>
                <label className={styles.fieldLabel} htmlFor="warmup-model-input">
                  {t('accounts.warmup_model_label')}
                </label>
                <button
                  type="button"
                  className={styles.restoreButton}
                  onClick={() => void handleRefreshModels()}
                  disabled={modelsLoading}
                  title={t('accounts.warmup_model_refresh')}
                >
                  <IconRefreshCw
                    size={11}
                    className={modelsLoading ? styles.spinIcon : undefined}
                    style={{ marginRight: 3, verticalAlign: -1 }}
                  />
                  {modelsLoading ? t('common.loading') : t('accounts.warmup_model_refresh')}
                </button>
              </div>
              <AutocompleteInput
                id="warmup-model-input"
                value={model}
                onChange={setModel}
                options={candidateModels}
                placeholder={
                  modelsLoading
                    ? t('common.loading')
                    : t('accounts.warmup_model_placeholder')
                }
              />
            </div>

            {/* 最大 Token 数 */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="warmup-max-tokens">
                {t('accounts.warmup_max_tokens_label')}
              </label>
              <input
                id="warmup-max-tokens"
                type="number"
                min={1}
                max={4096}
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value, 10) || 16)}
                className={styles.promptTextarea}
                style={{ minHeight: 36, height: 36 }}
              />
            </div>
          </div>

          {/* 预热端点与协议规范提示 */}
          <div className={styles.endpointHint}>
            <span>{t('accounts.warmup_endpoint_label', { defaultValue: '预热端点' })}:</span>
            <code>{getDefaultWarmupEndpoint(row)}</code>
            <span className={styles.protocolBadge}>
              {row.provider?.toLowerCase() === 'codex'
                ? 'Codex /responses 专属协议'
                : row.provider?.toLowerCase() === 'claude'
                  ? 'Claude /messages 协议'
                  : 'OpenAI 兼容协议'}
            </span>
          </div>

          {/* 发送内容 (Prompt) 文本框，配置默认值 'ping' 与 恢复默认值 按钮 */}
          <div className={styles.fieldGroup}>
            <div className={styles.fieldLabelRow}>
              <label className={styles.fieldLabel} htmlFor="warmup-prompt-textarea">
                {t('accounts.warmup_prompt_label')}
              </label>
              <button
                type="button"
                className={styles.restoreButton}
                onClick={handleRestoreDefaultPrompt}
                title={t('accounts.warmup_prompt_restore_default')}
              >
                <IconRotateCcw size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                {t('accounts.warmup_prompt_restore_default')}
              </button>
            </div>
            <textarea
              id="warmup-prompt-textarea"
              className={styles.promptTextarea}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              placeholder={DEFAULT_WARMUP_PROMPT}
            />
          </div>
        </div>

        {/* Section 2: 立即预热与执行结果 */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>{t('accounts.warmup_immediate_section')}</span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleRunImmediateWarmup()}
              loading={isWarmingUp}
              disabled={row.runtimeOnly}
            >
              <IconFlame size={14} />
              {t('accounts.warmup_now_button')}
            </Button>
          </div>

          {displayLastRecord ? (
            <div
              className={`${styles.resultPanel} ${
                displayLastRecord.success ? styles.resultSuccess : styles.resultError
              }`}
            >
              <div className={styles.resultMetaRow}>
                <span
                  className={`${styles.statusBadge} ${
                    displayLastRecord.success
                      ? styles.statusBadgeSuccess
                      : styles.statusBadgeError
                  }`}
                >
                  {displayLastRecord.success ? <IconCheck size={13} /> : <IconX size={13} />}
                  {displayLastRecord.statusCode > 0
                    ? `HTTP ${displayLastRecord.statusCode}`
                    : t('accounts.warmup_failed')}
                </span>
                <span className={styles.durationBadge}>
                  {t('accounts.warmup_result_duration')}: {displayLastRecord.durationMs} ms
                </span>
                <span className={styles.quotaRefreshedTag}>
                  <IconCheck size={12} />
                  {t('accounts.warmup_quota_refreshed')}
                </span>
              </div>

              <div className={styles.responseContentBox}>
                <span className={styles.responseContentLabel}>
                  {t('accounts.warmup_result_response')}:
                </span>
                <pre className={styles.responseSnippetPre}>
                  {displayLastRecord.responseSnippet || t('accounts.warmup_result_empty')}
                </pre>
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
              {t('accounts.warmup_history_empty')}
            </div>
          )}
        </div>

        {/* Section 3: 定时预热与时间推断 */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconClock size={16} />
              <span>{t('accounts.warmup_schedule_section')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {enabled
                  ? t('accounts.warmup_schedule_enabled')
                  : t('accounts.warmup_schedule_disabled')}
              </span>
              <ToggleSwitch
                checked={enabled}
                onChange={setEnabled}
                ariaLabel={t('accounts.warmup_schedule_enable')}
              />
            </div>
          </div>

          {enabled ? (
            <div className={styles.scheduleCard}>
              {/* 模式选择 */}
              <SegmentedTabs
                activeTab={mode}
                onChange={(tab) => setMode(tab as AccountWarmupMode)}
                ariaLabel={t('accounts.warmup_mode_label')}
                items={[
                  {
                    id: 'inferred',
                    label: t('accounts.warmup_mode_inferred'),
                  },
                  {
                    id: 'target_reset',
                    label: t('accounts.warmup_mode_target_reset'),
                  },
                  {
                    id: 'interval',
                    label: t('accounts.warmup_mode_interval'),
                  },
                ]}
              />

              {/* 目标重置时间模式 (如期望 09:20 重置，提前 5H 在 04:20 预热) */}
              {mode === 'target_reset' ? (
                <div className={styles.inferredCard}>
                  <div className={styles.inferredItem}>
                    <span className={styles.inferredItemLabel}>
                      {t('accounts.warmup_target_reset_time_label')}:
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="time"
                        value={targetResetTime}
                        onChange={(e) =>
                          setTargetResetTime(e.target.value || DEFAULT_TARGET_RESET_TIME)
                        }
                        className={styles.promptTextarea}
                        style={{ minHeight: 28, height: 28, width: 110, textAlign: 'center' }}
                      />
                    </div>
                  </div>

                  {/* 快捷常用时间预设 */}
                  <div className={styles.intervalPresets}>
                    {['08:00', '09:00', '09:20', '10:00', '14:00'].map((timePreset) => (
                      <button
                        key={timePreset}
                        type="button"
                        className={`${styles.presetButton} ${
                          targetResetTime === timePreset ? styles.presetButtonActive : ''
                        }`}
                        onClick={() => setTargetResetTime(timePreset)}
                      >
                        {timePreset}
                      </button>
                    ))}
                  </div>

                  {/* 提前预热时长输入 */}
                  <div className={styles.inferredItem}>
                    <span className={styles.inferredItemLabel}>
                      {t('accounts.warmup_target_lead_hours_label')}:
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        min={0}
                        max={24}
                        step={0.5}
                        value={targetLeadHours}
                        onChange={(e) =>
                          setTargetLeadHours(Math.max(0, parseFloat(e.target.value) || 0))
                        }
                        className={styles.promptTextarea}
                        style={{ minHeight: 28, height: 28, width: 80, textAlign: 'right' }}
                      />
                      <span>{t('accounts.warmup_target_lead_hours_unit')}</span>
                    </div>
                  </div>

                  {/* 每日预热时刻与下次执行高亮展示 */}
                  <div className={styles.nextWarmupHighlight}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div>
                        <span>{t('accounts.warmup_target_daily_warmup_at')}: </span>
                        <strong>
                          {targetResetInfo.warmupTimeStr} ({t('accounts.warmup_target_lead_note', { hours: targetResetInfo.leadHours })})
                        </strong>
                      </div>
                      <div>
                        <span>{t('accounts.warmup_inferred_next_at')}: </span>
                        <strong>{formatTimestamp(targetResetInfo.nextWarmupAtMs)}</strong>
                      </div>
                    </div>
                    <span className={styles.nextWarmupTimeText}>
                      {formatCountdownText(targetResetInfo.nextWarmupAtMs)}
                    </span>
                  </div>
                </div>
              ) : null}

              {/* 推断额度重置时间模式 */}
              {mode === 'inferred' ? (
                <div className={styles.inferredCard}>
                  <div className={styles.inferredItem}>
                    <span className={styles.inferredItemLabel}>
                      {t('accounts.warmup_inferred_window')}:
                    </span>
                    <span className={styles.inferredItemValue}>
                      {inferredTimeInfo.sourceWindowLabel || '-'}
                    </span>
                  </div>

                  <div className={styles.inferredItem}>
                    <span className={styles.inferredItemLabel}>
                      {t('accounts.warmup_inferred_reset_at')}:
                    </span>
                    <span className={styles.inferredItemValue}>
                      {inferredTimeInfo.resetAtMs
                        ? formatQuotaResetTime(new Date(inferredTimeInfo.resetAtMs).toISOString())
                        : t('accounts.warmup_inferred_no_reset')}
                    </span>
                  </div>

                  <div className={styles.inferredItem}>
                    <span className={styles.inferredItemLabel}>
                      {t('accounts.warmup_inferred_delay')}:
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        value={inferredDelaySeconds}
                        onChange={(e) =>
                          setInferredDelaySeconds(Math.max(0, parseInt(e.target.value, 10) || 0))
                        }
                        className={styles.promptTextarea}
                        style={{ minHeight: 28, height: 28, width: 80, textAlign: 'right' }}
                      />
                      <span>{t('accounts.warmup_inferred_delay_seconds')}</span>
                    </div>
                  </div>

                  {inferredTimeInfo.nextWarmupAtMs && inferredTimeInfo.isFuture ? (
                    <div className={styles.nextWarmupHighlight}>
                      <div>
                        <span>{t('accounts.warmup_inferred_next_at')}: </span>
                        <strong>{formatTimestamp(inferredTimeInfo.nextWarmupAtMs)}</strong>
                      </div>
                      <span className={styles.nextWarmupTimeText}>
                        {formatCountdownText(inferredTimeInfo.nextWarmupAtMs)}
                      </span>
                    </div>
                  ) : (
                    <div className={styles.warningBox}>
                      <IconTriangleAlert size={14} />
                      <span>
                        {inferredTimeInfo.resetAtMs
                          ? t('accounts.warmup_inferred_expired_warning')
                          : t('accounts.warmup_inferred_no_reset')}
                      </span>
                    </div>
                  )}

                  <div className={styles.inferredActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleRefreshAndReinfer()}
                      loading={isRefreshingInference}
                    >
                      <IconRefreshCw size={13} />
                      {t('accounts.warmup_inferred_refresh_recalculate')}
                    </Button>
                  </div>
                </div>
              ) : (
                /* 固定间隔模式 */
                <div className={styles.intervalCard}>
                  <div className={styles.inferredItem}>
                    <span className={styles.inferredItemLabel}>
                      {t('accounts.warmup_interval_label')}:
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={intervalMinutes}
                        onChange={(e) =>
                          setIntervalMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))
                        }
                        className={styles.promptTextarea}
                        style={{ minHeight: 28, height: 28, width: 90, textAlign: 'right' }}
                      />
                      <span>{t('accounts.warmup_interval_minutes')}</span>
                    </div>
                  </div>

                  <div className={styles.intervalPresets}>
                    {[15, 30, 60, 120, 240, 300].map((mins) => (
                      <button
                        key={mins}
                        type="button"
                        className={`${styles.presetButton} ${
                          intervalMinutes === mins ? styles.presetButtonActive : ''
                        }`}
                        onClick={() => setIntervalMinutes(mins)}
                      >
                        {mins >= 60 ? `${mins / 60}h` : `${mins}m`}
                      </button>
                    ))}
                  </div>

                  <div className={styles.nextWarmupHighlight}>
                    <div>
                      <span>{t('accounts.warmup_inferred_next_at')}: </span>
                      <strong>
                        {formatTimestamp(Date.now() + intervalMinutes * 60 * 1000)}
                      </strong>
                    </div>
                    <span className={styles.nextWarmupTimeText}>
                      {formatCountdownText(Date.now() + intervalMinutes * 60 * 1000)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
