package warmup

import (
	"context"
	"database/sql"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

// Repository 凭据脱机预热调度与日志仓储接口
type Repository interface {
	// ListSchedules 列出所有预热调度配置
	ListSchedules(ctx context.Context) ([]model.AccountWarmupSchedule, error)
	// GetSchedule 根据凭据唯一键获取预热调度配置
	GetSchedule(ctx context.Context, selectionKey string) (*model.AccountWarmupSchedule, error)
	// UpsertSchedule 新增或更新预热调度配置
	UpsertSchedule(ctx context.Context, schedule *model.AccountWarmupSchedule) error
	// DeleteSchedule 删除指定凭据的预热调度配置
	DeleteSchedule(ctx context.Context, selectionKey string) error
	// FindDueSchedules 检索当前已到期需要执行预热的凭据列表 (enabled = 1 AND next_run_at_ms <= nowMS)
	FindDueSchedules(ctx context.Context, nowMS int64) ([]model.AccountWarmupSchedule, error)
	// UpdateExecutionResult 更新最近一次执行状态、耗时、返回内容以及推算出的下一次执行时间
	UpdateExecutionResult(ctx context.Context, id int64, res model.WarmupExecutionResult, nextRunAtMS int64) error
	// InsertLog 记录单次预热执行日志明细
	InsertLog(ctx context.Context, log *model.AccountWarmupLog) error
	// ListLogs 根据凭据唯一键分页查询历史执行日志
	ListLogs(ctx context.Context, selectionKey string, limit int) ([]model.AccountWarmupLog, error)
}

type repository struct {
	db *sql.DB
}

// New 创建凭据预热仓储实现
func New(db *sql.DB) Repository {
	return &repository{db: db}
}

// ListSchedules 查询全部预热配置，按更新时间倒序排序
func (r *repository) ListSchedules(ctx context.Context) ([]model.AccountWarmupSchedule, error) {
	query := `SELECT id, selection_key, account_key, provider, prefix, model, prompt, max_tokens,
		mode, target_reset_time, lead_hours, interval_minutes, inferred_delay_seconds, enabled,
		next_run_at_ms, last_run_at_ms, last_status, last_latency_ms, last_response, last_error,
		created_at_ms, updated_at_ms
		FROM account_warmup_schedules ORDER BY updated_at_ms DESC`
	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.AccountWarmupSchedule
	for rows.Next() {
		var s model.AccountWarmupSchedule
		var mode string
		var enabledInt int
		if err := rows.Scan(
			&s.ID, &s.SelectionKey, &s.AccountKey, &s.Provider, &s.Prefix, &s.Model, &s.Prompt, &s.MaxTokens,
			&mode, &s.TargetResetTime, &s.LeadHours, &s.IntervalMinutes, &s.InferredDelaySeconds, &enabledInt,
			&s.NextRunAtMS, &s.LastRunAtMS, &s.LastStatus, &s.LastLatencyMS, &s.LastResponse, &s.LastError,
			&s.CreatedAtMS, &s.UpdatedAtMS,
		); err != nil {
			return nil, err
		}
		s.Mode = model.WarmupMode(mode)
		s.Enabled = enabledInt == 1
		list = append(list, s)
	}
	return list, rows.Err()
}

// GetSchedule 获取单个凭据的预热调度配置
func (r *repository) GetSchedule(ctx context.Context, selectionKey string) (*model.AccountWarmupSchedule, error) {
	query := `SELECT id, selection_key, account_key, provider, prefix, model, prompt, max_tokens,
		mode, target_reset_time, lead_hours, interval_minutes, inferred_delay_seconds, enabled,
		next_run_at_ms, last_run_at_ms, last_status, last_latency_ms, last_response, last_error,
		created_at_ms, updated_at_ms
		FROM account_warmup_schedules WHERE selection_key = ? LIMIT 1`
	row := r.db.QueryRowContext(ctx, query, selectionKey)
	var s model.AccountWarmupSchedule
	var mode string
	var enabledInt int
	err := row.Scan(
		&s.ID, &s.SelectionKey, &s.AccountKey, &s.Provider, &s.Prefix, &s.Model, &s.Prompt, &s.MaxTokens,
		&mode, &s.TargetResetTime, &s.LeadHours, &s.IntervalMinutes, &s.InferredDelaySeconds, &enabledInt,
		&s.NextRunAtMS, &s.LastRunAtMS, &s.LastStatus, &s.LastLatencyMS, &s.LastResponse, &s.LastError,
		&s.CreatedAtMS, &s.UpdatedAtMS,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Mode = model.WarmupMode(mode)
	s.Enabled = enabledInt == 1
	return &s, nil
}

// UpsertSchedule 插入或更新凭据的预热调度配置
func (r *repository) UpsertSchedule(ctx context.Context, s *model.AccountWarmupSchedule) error {
	now := time.Now().UnixMilli()
	if s.CreatedAtMS == 0 {
		s.CreatedAtMS = now
	}
	s.UpdatedAtMS = now
	enabledInt := 0
	if s.Enabled {
		enabledInt = 1
	}

	query := `INSERT INTO account_warmup_schedules (
		selection_key, account_key, provider, prefix, model, prompt, max_tokens,
		mode, target_reset_time, lead_hours, interval_minutes, inferred_delay_seconds, enabled,
		next_run_at_ms, created_at_ms, updated_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(selection_key) DO UPDATE SET
		account_key = excluded.account_key,
		provider = excluded.provider,
		prefix = excluded.prefix,
		model = excluded.model,
		prompt = excluded.prompt,
		max_tokens = excluded.max_tokens,
		mode = excluded.mode,
		target_reset_time = excluded.target_reset_time,
		lead_hours = excluded.lead_hours,
		interval_minutes = excluded.interval_minutes,
		inferred_delay_seconds = excluded.inferred_delay_seconds,
		enabled = excluded.enabled,
		next_run_at_ms = excluded.next_run_at_ms,
		updated_at_ms = excluded.updated_at_ms`

	_, err := r.db.ExecContext(ctx, query,
		s.SelectionKey, s.AccountKey, s.Provider, s.Prefix, s.Model, s.Prompt, s.MaxTokens,
		string(s.Mode), s.TargetResetTime, s.LeadHours, s.IntervalMinutes, s.InferredDelaySeconds, enabledInt,
		s.NextRunAtMS, s.CreatedAtMS, s.UpdatedAtMS,
	)
	return err
}

// DeleteSchedule 删除指定凭据的预热调度
func (r *repository) DeleteSchedule(ctx context.Context, selectionKey string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM account_warmup_schedules WHERE selection_key = ?`, selectionKey)
	return err
}

// FindDueSchedules 检索当前时间已到期、开启状态的预热任务
func (r *repository) FindDueSchedules(ctx context.Context, nowMS int64) ([]model.AccountWarmupSchedule, error) {
	query := `SELECT id, selection_key, account_key, provider, prefix, model, prompt, max_tokens,
		mode, target_reset_time, lead_hours, interval_minutes, inferred_delay_seconds, enabled,
		next_run_at_ms, last_run_at_ms, last_status, last_latency_ms, last_response, last_error,
		created_at_ms, updated_at_ms
		FROM account_warmup_schedules 
		WHERE enabled = 1 AND next_run_at_ms <= ?
		ORDER BY next_run_at_ms ASC`

	rows, err := r.db.QueryContext(ctx, query, nowMS)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.AccountWarmupSchedule
	for rows.Next() {
		var s model.AccountWarmupSchedule
		var mode string
		var enabledInt int
		if err := rows.Scan(
			&s.ID, &s.SelectionKey, &s.AccountKey, &s.Provider, &s.Prefix, &s.Model, &s.Prompt, &s.MaxTokens,
			&mode, &s.TargetResetTime, &s.LeadHours, &s.IntervalMinutes, &s.InferredDelaySeconds, &enabledInt,
			&s.NextRunAtMS, &s.LastRunAtMS, &s.LastStatus, &s.LastLatencyMS, &s.LastResponse, &s.LastError,
			&s.CreatedAtMS, &s.UpdatedAtMS,
		); err != nil {
			return nil, err
		}
		s.Mode = model.WarmupMode(mode)
		s.Enabled = enabledInt == 1
		list = append(list, s)
	}
	return list, rows.Err()
}

// UpdateExecutionResult 更新最近一次预热执行结果并重新排期下一次执行时间
func (r *repository) UpdateExecutionResult(ctx context.Context, id int64, res model.WarmupExecutionResult, nextRunAtMS int64) error {
	now := time.Now().UnixMilli()
	status := "success"
	if !res.Success {
		status = "failed"
	}

	query := `UPDATE account_warmup_schedules SET
		last_run_at_ms = ?,
		last_status = ?,
		last_latency_ms = ?,
		last_response = ?,
		last_error = ?,
		next_run_at_ms = ?,
		updated_at_ms = ?
		WHERE id = ?`

	_, err := r.db.ExecContext(ctx, query,
		now, status, res.LatencyMS, res.ResponseSnippet, res.ErrorMessage, nextRunAtMS, now, id,
	)
	return err
}

// InsertLog 记录单次预热执行日志明细
func (r *repository) InsertLog(ctx context.Context, l *model.AccountWarmupLog) error {
	if l.CreatedAtMS == 0 {
		l.CreatedAtMS = time.Now().UnixMilli()
	}
	query := `INSERT INTO account_warmup_logs (
		schedule_id, selection_key, account_key, provider, model, trigger_source,
		status, status_code, latency_ms, response_snippet, error_message, created_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		l.ScheduleID, l.SelectionKey, l.AccountKey, l.Provider, l.Model, l.TriggerSource,
		l.Status, l.StatusCode, l.LatencyMS, l.ResponseSnippet, l.ErrorMessage, l.CreatedAtMS,
	)
	return err
}

// ListLogs 查询特定凭据的最近预热历史记录
func (r *repository) ListLogs(ctx context.Context, selectionKey string, limit int) ([]model.AccountWarmupLog, error) {
	if limit <= 0 {
		limit = 20
	}
	query := `SELECT id, schedule_id, selection_key, account_key, provider, model, trigger_source,
		status, status_code, latency_ms, response_snippet, error_message, created_at_ms
		FROM account_warmup_logs WHERE selection_key = ?
		ORDER BY created_at_ms DESC LIMIT ?`

	rows, err := r.db.QueryContext(ctx, query, selectionKey, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []model.AccountWarmupLog
	for rows.Next() {
		var l model.AccountWarmupLog
		if err := rows.Scan(
			&l.ID, &l.ScheduleID, &l.SelectionKey, &l.AccountKey, &l.Provider, &l.Model, &l.TriggerSource,
			&l.Status, &l.StatusCode, &l.LatencyMS, &l.ResponseSnippet, &l.ErrorMessage, &l.CreatedAtMS,
		); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, rows.Err()
}
