package worker_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	warmupsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/warmup"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/worker"
)

func TestWarmupWorker_StartupCatchupAndExecution(t *testing.T) {
	var callCount int32

	// 模拟 CPA 网关服务端
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v0/management/api-keys" {
			_ = json.NewEncoder(w).Encode([]string{"test-key"})
			return
		}
		if r.URL.Path == "/v1/chat/completions" {
			atomic.AddInt32(&callCount, 1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"}}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)

	_ = st.SaveSetup(ctx, model.Setup{
		CPAUpstreamURL: mockServer.URL,
	})

	repo := st.Warmup
	svc := warmupsvc.New(repo, st)

	now := time.Now().UnixMilli()
	// 插入一个已到期的任务
	sched := &model.AccountWarmupSchedule{
		SelectionKey:         "codex-worker-test",
		AccountKey:           "worker@example.com",
		Provider:             "codex",
		Prefix:               "p390",
		Model:                "p390/gpt-5.5",
		Prompt:               "ping",
		MaxTokens:            16,
		Mode:                 model.WarmupModeTargetReset,
		TargetResetTime:      "10:00",
		LeadHours:            5,
		Enabled:              true,
		NextRunAtMS:          now - 5000, // 过去时间
	}
	if err := repo.UpsertSchedule(ctx, sched); err != nil {
		t.Fatalf("upsert schedule: %v", err)
	}

	w := worker.NewWarmupWorker(svc, repo)
	// 启动 worker，启动时会自动触发一次 tick 补偿执行
	w.Start(ctx)

	// 等待执行完成
	var success bool
	for i := 0; i < 40; i++ {
		time.Sleep(50 * time.Millisecond)
		if atomic.LoadInt32(&callCount) > 0 {
			success = true
			break
		}
	}
	w.Stop()

	if !success {
		t.Fatalf("expected warmup worker to trigger scheduled task on startup")
	}

	// 检查数据库中已排期到未来
	updated, err := repo.GetSchedule(ctx, sched.SelectionKey)
	if err != nil || updated == nil {
		t.Fatalf("get schedule err: %v", err)
	}
	if updated.NextRunAtMS <= now {
		t.Fatalf("expected next run to be rescheduled to the future, got %d", updated.NextRunAtMS)
	}
	if updated.LastStatus == nil || *updated.LastStatus != "success" {
		t.Fatalf("expected last status success, got %v", updated.LastStatus)
	}
}
