package warmup_test

import (
	"context"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestWarmupRepository_Lifecycle(t *testing.T) {
	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	repo := st.Warmup

	now := time.Now().UnixMilli()
	sched := &model.AccountWarmupSchedule{
		SelectionKey:         "codex-test-key-1",
		AccountKey:           "test@example.com",
		Provider:             "codex",
		Prefix:               "p390",
		Model:                "p390/gpt-5.5",
		Prompt:               "ping",
		MaxTokens:            16,
		Mode:                 model.WarmupModeTargetReset,
		TargetResetTime:      "10:00",
		LeadHours:            5,
		IntervalMinutes:      60,
		InferredDelaySeconds: 10,
		Enabled:              true,
		NextRunAtMS:          now - 1000, // 过去时间，应该为已到期
	}

	// 1. 插入调度
	if err := repo.UpsertSchedule(ctx, sched); err != nil {
		t.Fatalf("upsert schedule: %v", err)
	}

	// 2. 读取验证
	fetched, err := repo.GetSchedule(ctx, sched.SelectionKey)
	if err != nil {
		t.Fatalf("get schedule: %v", err)
	}
	if fetched == nil {
		t.Fatalf("expected schedule to exist")
	}
	if fetched.SelectionKey != sched.SelectionKey || fetched.Prefix != "p390" || !fetched.Enabled {
		t.Fatalf("unexpected fetched schedule: %#v", fetched)
	}

	// 3. 检索已到期任务
	dueList, err := repo.FindDueSchedules(ctx, now)
	if err != nil {
		t.Fatalf("find due schedules: %v", err)
	}
	if len(dueList) != 1 || dueList[0].SelectionKey != sched.SelectionKey {
		t.Fatalf("expected 1 due schedule, got %d", len(dueList))
	}

	// 4. 更新执行结果
	res := model.WarmupExecutionResult{
		Success:         true,
		StatusCode:      200,
		LatencyMS:       1200,
		ResponseSnippet: "pong",
	}
	nextMS := now + 86400000
	if err := repo.UpdateExecutionResult(ctx, fetched.ID, res, nextMS); err != nil {
		t.Fatalf("update execution result: %v", err)
	}

	updated, err := repo.GetSchedule(ctx, sched.SelectionKey)
	if err != nil || updated == nil {
		t.Fatalf("get updated schedule: %v", err)
	}
	if updated.LastStatus == nil || *updated.LastStatus != "success" {
		t.Fatalf("expected last status success, got %v", updated.LastStatus)
	}
	if updated.NextRunAtMS != nextMS {
		t.Fatalf("expected next run %d, got %d", nextMS, updated.NextRunAtMS)
	}

	// 5. 写入与读取执行日志
	logEntry := &model.AccountWarmupLog{
		ScheduleID:      &fetched.ID,
		SelectionKey:    sched.SelectionKey,
		AccountKey:      sched.AccountKey,
		Provider:        sched.Provider,
		Model:           sched.Model,
		TriggerSource:   "scheduled",
		Status:          "success",
		StatusCode:      200,
		LatencyMS:       1200,
		ResponseSnippet: "pong",
	}
	if err := repo.InsertLog(ctx, logEntry); err != nil {
		t.Fatalf("insert log: %v", err)
	}

	logs, err := repo.ListLogs(ctx, sched.SelectionKey, 10)
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if len(logs) != 1 || logs[0].ResponseSnippet != "pong" {
		t.Fatalf("expected 1 log with pong, got %#v", logs)
	}

	// 6. 删除调度
	if err := repo.DeleteSchedule(ctx, sched.SelectionKey); err != nil {
		t.Fatalf("delete schedule: %v", err)
	}
	deleted, err := repo.GetSchedule(ctx, sched.SelectionKey)
	if err != nil || deleted != nil {
		t.Fatalf("expected deleted schedule to be nil, got %v, err: %v", deleted, err)
	}
}
