package model

import (
	"strconv"
	"strings"
	"time"
)

// WarmupMode 预热模式类型
type WarmupMode string

const (
	// WarmupModeTargetReset 目标重置时间模式：指定期望重置时间（如 10:00），凭据提前 N 小时（如 5H）在指定时间自动预热
	WarmupModeTargetReset WarmupMode = "target_reset"
	// WarmupModeInferred 动态推断模式：根据额度窗口重置时间自动推断
	WarmupModeInferred WarmupMode = "inferred"
	// WarmupModeInterval 固定间隔模式：按固定分钟周期性预热
	WarmupModeInterval WarmupMode = "interval"
)

// AccountWarmupSchedule 凭据预热调度配置与持久化状态实体
type AccountWarmupSchedule struct {
	// ID 数据库自增主键
	ID int64 `json:"id"`
	// SelectionKey 凭据唯一标识，如 codex-e44070a5-jacklp390@gmail.com-team.json
	SelectionKey string `json:"selectionKey"`
	// AccountKey 凭据账号标识，如 jacklp390@gmail.com
	AccountKey string `json:"accountKey"`
	// Provider 渠道提供商，如 codex, claude, xai
	Provider string `json:"provider"`
	// Prefix 账号在 CPA 网关中的专属路由前缀，如 p390, pqq
	Prefix string `json:"prefix"`
	// Model 目标预热模型，如 p390/gpt-5.5
	Model string `json:"model"`
	// Prompt 预热探测发送的文本内容，默认为 "ping"
	Prompt string `json:"prompt"`
	// MaxTokens 最大生成 Token 限制，默认为 16
	MaxTokens int `json:"maxTokens"`
	// Mode 预热调度模式：target_reset / inferred / interval
	Mode WarmupMode `json:"mode"`
	// TargetResetTime 目标期望重置时间（HH:mm 格式，默认 "10:00"）
	TargetResetTime string `json:"targetResetTime"`
	// LeadHours 相比目标重置时间提前量小时数（默认 5 小时，即 10:00 重置需在 05:00 预热）
	LeadHours int `json:"leadHours"`
	// IntervalMinutes 固定间隔模式下的触发周期分钟数（默认 60 分钟）
	IntervalMinutes int `json:"intervalMinutes"`
	// InferredDelaySeconds 推断模式下的额外延迟秒数（默认 10 秒）
	InferredDelaySeconds int `json:"inferredDelaySeconds"`
	// Enabled 是否开启自动预热调度
	Enabled bool `json:"enabled"`
	// NextRunAtMS 下一次服务端执行预热的毫秒时间戳
	NextRunAtMS int64 `json:"nextRunAtMs"`
	// LastRunAtMS 最近一次预热执行的毫秒时间戳
	LastRunAtMS *int64 `json:"lastRunAtMs,omitempty"`
	// LastStatus 最近一次预热执行状态：success / failed
	LastStatus *string `json:"lastStatus,omitempty"`
	// LastLatencyMS 最近一次预热执行耗时（毫秒）
	LastLatencyMS *int64 `json:"lastLatencyMs,omitempty"`
	// LastResponse 最近一次预热返回的内容摘要
	LastResponse *string `json:"lastResponse,omitempty"`
	// LastError 最近一次预热执行错误信息
	LastError *string `json:"lastError,omitempty"`
	// CreatedAtMS 记录创建时间戳
	CreatedAtMS int64 `json:"createdAtMs"`
	// UpdatedAtMS 记录更新时间戳
	UpdatedAtMS int64 `json:"updatedAtMs"`
}

// AccountWarmupLog 单次预热执行历史明细实体
type AccountWarmupLog struct {
	// ID 数据库自增主键
	ID int64 `json:"id"`
	// ScheduleID 关联的调度配置 ID
	ScheduleID *int64 `json:"scheduleId,omitempty"`
	// SelectionKey 凭据唯一标识
	SelectionKey string `json:"selectionKey"`
	// AccountKey 凭据账号标识
	AccountKey string `json:"accountKey"`
	// Provider 渠道提供商
	Provider string `json:"provider"`
	// Model 预热使用的完整模型名（含前缀）
	Model string `json:"model"`
	// TriggerSource 触发来源：scheduled (定时常驻) / manual (手动立即) / startup_catchup (启动补偿)
	TriggerSource string `json:"triggerSource"`
	// Status 执行状态：success / failed
	Status string `json:"status"`
	// StatusCode HTTP 状态码（200 为成功，0 为网络失败）
	StatusCode int `json:"statusCode"`
	// LatencyMS 往返耗时（毫秒）
	LatencyMS int64 `json:"latencyMs"`
	// ResponseSnippet 模型返回文本摘要（如 "pong"）
	ResponseSnippet string `json:"responseSnippet"`
	// ErrorMessage 错误信息（若失败）
	ErrorMessage string `json:"errorMessage"`
	// CreatedAtMS 执行记录时间戳
	CreatedAtMS int64 `json:"createdAtMs"`
}

// WarmupExecutionResult 单次预热推理执行结果
type WarmupExecutionResult struct {
	// Success 是否成功
	Success bool `json:"success"`
	// StatusCode HTTP 响应状态码
	StatusCode int `json:"statusCode"`
	// LatencyMS 执行耗时（毫秒）
	LatencyMS int64 `json:"latencyMs"`
	// ResponseSnippet 响应文本摘要
	ResponseSnippet string `json:"responseSnippet"`
	// ErrorMessage 错误信息
	ErrorMessage string `json:"errorMessage"`
}

// CalculateNextRunAtMS 根据当前配置模式与时间基准计算下一次执行时间戳
func (s *AccountWarmupSchedule) CalculateNextRunAtMS(now time.Time) int64 {
	lead := s.LeadHours
	if lead <= 0 {
		lead = 5
	}

	switch s.Mode {
	case WarmupModeInterval:
		interval := s.IntervalMinutes
		if interval <= 0 {
			interval = 60
		}
		return now.Add(time.Duration(interval) * time.Minute).UnixMilli()

	case WarmupModeTargetReset, WarmupModeInferred:
		fallthrough
	default:
		timeStr := strings.TrimSpace(s.TargetResetTime)
		if timeStr == "" {
			timeStr = "10:00"
		}
		parts := strings.Split(timeStr, ":")
		hour, min := 10, 0
		if len(parts) >= 2 {
			if h, err := strconv.Atoi(parts[0]); err == nil {
				hour = h
			}
			if m, err := strconv.Atoi(parts[1]); err == nil {
				min = m
			}
		}

		// 构造当天的目标重置时间
		todayReset := time.Date(now.Year(), now.Month(), now.Day(), hour, min, 0, 0, now.Location())
		// 目标预热触发时间 = 目标重置时间 - 提前量 (例如 10:00 - 5h = 当天 05:00)
		targetWarmup := todayReset.Add(-time.Duration(lead) * time.Hour)

		// 如果计算出的预热触发时间已经过去，则自动顺延计算明天的目标时间
		if !targetWarmup.After(now) {
			targetWarmup = targetWarmup.Add(24 * time.Hour)
		}
		return targetWarmup.UnixMilli()
	}
}
