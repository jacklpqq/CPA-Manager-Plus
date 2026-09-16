package warmup_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	warmupsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/warmup"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestWarmupService_ExecuteWarmup(t *testing.T) {
	var receivedPath string
	var receivedModel string
	var receivedSessionID string
	var receivedAuth string

	// 模拟 CPA 网关服务端
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedSessionID = r.Header.Get("X-Session-ID")
		receivedAuth = r.Header.Get("Authorization")

		if r.URL.Path == "/v0/management/api-keys" {
			_ = json.NewEncoder(w).Encode(map[string]any{"api-keys": []string{"test-api-key-123"}})
			return
		}

		if r.URL.Path == "/v1/chat/completions" {
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if m, ok := payload["model"].(string); ok {
				receivedModel = m
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{
				"id": "chatcmpl-test",
				"choices": [
					{
						"index": 0,
						"message": {
							"role": "assistant",
							"content": "pong"
						}
					}
				]
			}`))
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockServer.Close()

	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)

	// 配置 Setup 指向 mockServer
	_ = st.SaveSetup(ctx, model.Setup{
		CPAUpstreamURL: mockServer.URL,
		ManagementKey:  "mgmt-secret",
	})

	repo := st.Warmup
	service := warmupsvc.New(repo, st)

	sched := &model.AccountWarmupSchedule{
		SelectionKey:    "codex-test-key",
		AccountKey:      "jack@example.com",
		Provider:        "codex",
		Prefix:          "p390",
		Model:           "gpt-5.5", // 未带前缀，期望自动补齐为 p390/gpt-5.5
		Prompt:          "ping",
		MaxTokens:       16,
		Mode:            model.WarmupModeTargetReset,
		TargetResetTime: "10:00",
		LeadHours:       5,
		Enabled:         true,
	}
	if err := service.SaveSchedule(ctx, sched); err != nil {
		t.Fatalf("save schedule: %v", err)
	}

	fetched, err := service.GetSchedule(ctx, sched.SelectionKey)
	if err != nil || fetched == nil {
		t.Fatalf("get schedule: %v", err)
	}

	res, err := service.ExecuteWarmup(ctx, fetched, "test")
	if err != nil {
		t.Fatalf("execute warmup: %v", err)
	}
	if !res.Success || res.StatusCode != 200 || res.ResponseSnippet != "pong" {
		t.Fatalf("unexpected result: %#v", res)
	}

	// 验证请求特征
	if receivedPath != "/v1/chat/completions" {
		t.Fatalf("expected /v1/chat/completions, got %s", receivedPath)
	}
	if receivedModel != "p390/gpt-5.5" {
		t.Fatalf("expected p390/gpt-5.5, got %s", receivedModel)
	}
	if !strings.HasPrefix(receivedSessionID, "warmup-srv-") {
		t.Fatalf("expected warmup-srv- session id, got %s", receivedSessionID)
	}
	if receivedAuth != "Bearer test-api-key-123" {
		t.Fatalf("expected Bearer test-api-key-123, got %s", receivedAuth)
	}

	// 验证日志被持久化
	logs, err := service.ListLogs(ctx, sched.SelectionKey, 5)
	if err != nil || len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d, err: %v", len(logs), err)
	}
	if logs[0].TriggerSource != "test" || logs[0].ResponseSnippet != "pong" {
		t.Fatalf("unexpected log: %#v", logs[0])
	}
}
