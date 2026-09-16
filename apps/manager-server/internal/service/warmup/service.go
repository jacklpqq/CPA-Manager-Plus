package warmup

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	warmuprepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/warmup"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

// Service 凭据预热核心业务服务
type Service struct {
	repo       warmuprepo.Repository
	store      *store.Store
	httpClient *http.Client
}

// New 创建预热核心业务服务实例
func New(repo warmuprepo.Repository, st *store.Store) *Service {
	return &Service{
		repo:  repo,
		store: st,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ListSchedules 查询所有凭据预热调度配置
func (s *Service) ListSchedules(ctx context.Context) ([]model.AccountWarmupSchedule, error) {
	return s.repo.ListSchedules(ctx)
}

// GetSchedule 查询单个凭据预热调度配置
func (s *Service) GetSchedule(ctx context.Context, selectionKey string) (*model.AccountWarmupSchedule, error) {
	return s.repo.GetSchedule(ctx, selectionKey)
}

// SaveSchedule 保存或更新凭据预热调度配置（自动计算并排期下次执行时间）
func (s *Service) SaveSchedule(ctx context.Context, sched *model.AccountWarmupSchedule) error {
	now := time.Now()
	// 若未指定下次执行时间或已过去，重新按配置算法精确推算
	if sched.NextRunAtMS <= now.UnixMilli() {
		sched.NextRunAtMS = sched.CalculateNextRunAtMS(now)
	}
	return s.repo.UpsertSchedule(ctx, sched)
}

// DeleteSchedule 删除指定凭据预热调度
func (s *Service) DeleteSchedule(ctx context.Context, selectionKey string) error {
	return s.repo.DeleteSchedule(ctx, selectionKey)
}

// ListLogs 查询特定凭据的历史预热日志明细
func (s *Service) ListLogs(ctx context.Context, selectionKey string, limit int) ([]model.AccountWarmupLog, error) {
	return s.repo.ListLogs(ctx, selectionKey, limit)
}

// ExecuteWarmup 执行单次凭据预热推理（完全复用 CPA 网关标准模型调用方式）
// 参数 source 标识触发来源：scheduled (定时常驻协程) / manual (前端手动触发) / startup_catchup (开机补偿)
func (s *Service) ExecuteWarmup(ctx context.Context, sched *model.AccountWarmupSchedule, source string) (*model.WarmupExecutionResult, error) {
	startTime := time.Now()

	// 1. 读取 CPA 网关上游连接配置（优先从 Setup 读取，兜底从 ManagerConfig 读取）
	cpaBase := ""
	mgmtKey := ""
	if setup, ok, err := s.store.LoadSetup(ctx); err == nil && ok && strings.TrimSpace(setup.CPAUpstreamURL) != "" {
		cpaBase = strings.TrimRight(strings.TrimSpace(setup.CPAUpstreamURL), "/")
		mgmtKey = setup.ManagementKey
	} else if cfg, cfgOk, cfgErr := s.store.LoadManagerConfig(ctx); cfgErr == nil && cfgOk && strings.TrimSpace(cfg.CPAConnection.CPABaseURL) != "" {
		cpaBase = strings.TrimRight(strings.TrimSpace(cfg.CPAConnection.CPABaseURL), "/")
		mgmtKey = cfg.CPAConnection.ManagementKey
	}

	if cpaBase == "" {
		return nil, fmt.Errorf("cpa upstream url not configured in setup or manager config")
	}

	apiKey := s.resolveCPAKey(ctx, cpaBase, mgmtKey)

	// 2. 路由前缀校验与模型名规范化 (如 p390 + gpt-5.5 -> p390/gpt-5.5)
	targetModel := strings.TrimSpace(sched.Model)
	if targetModel == "" {
		targetModel = "gpt-4o-mini"
	}
	cleanPrefix := strings.Trim(strings.TrimSpace(sched.Prefix), "/")
	if cleanPrefix != "" && !strings.HasPrefix(targetModel, cleanPrefix+"/") {
		targetModel = cleanPrefix + "/" + targetModel
	}

	// 3. 构造 1-token 标准 Chat Completions 探测请求体
	prompt := strings.TrimSpace(sched.Prompt)
	if prompt == "" {
		prompt = "ping"
	}
	maxTokens := sched.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 16
	}

	payload := map[string]any{
		"model": targetModel,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"max_tokens": maxTokens,
		"stream":     false,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal warmup payload: %w", err)
	}

	// 4. 生成隔离的单次无状态 Session ID，杜绝上下文与会话串扰
	randBytes := make([]byte, 8)
	_, _ = rand.Read(randBytes)
	sessionID := fmt.Sprintf("warmup-srv-%s", hex.EncodeToString(randBytes))

	targetURL := fmt.Sprintf("%s/v1/chat/completions", cpaBase)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create warmup http request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Session-ID", sessionID)
	req.Header.Set("X-Session-Affinity", sessionID)
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	// 5. 向 CPA 网关发起推理探测
	resp, reqErr := s.httpClient.Do(req)
	latencyMS := time.Since(startTime).Milliseconds()

	res := &model.WarmupExecutionResult{
		LatencyMS: latencyMS,
	}

	if reqErr != nil {
		res.Success = false
		res.StatusCode = 0
		res.ErrorMessage = reqErr.Error()
	} else {
		defer resp.Body.Close()
		res.StatusCode = resp.StatusCode
		respBody, _ := io.ReadAll(resp.Body)

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			res.Success = true
			res.ResponseSnippet = extractSnippet(respBody)
		} else {
			res.Success = false
			res.ErrorMessage = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(respBody))
		}
	}

	// 6. 持久化记录执行明细日志
	statusStr := "success"
	if !res.Success {
		statusStr = "failed"
	}
	_ = s.repo.InsertLog(ctx, &model.AccountWarmupLog{
		ScheduleID:      &sched.ID,
		SelectionKey:    sched.SelectionKey,
		AccountKey:      sched.AccountKey,
		Provider:        sched.Provider,
		Model:           targetModel,
		TriggerSource:   source,
		Status:          statusStr,
		StatusCode:      res.StatusCode,
		LatencyMS:       res.LatencyMS,
		ResponseSnippet: res.ResponseSnippet,
		ErrorMessage:    res.ErrorMessage,
		CreatedAtMS:     time.Now().UnixMilli(),
	})

	// 7. 计算并更新下一次预热执行时间
	nextRunAtMS := sched.CalculateNextRunAtMS(time.Now())
	_ = s.repo.UpdateExecutionResult(ctx, sched.ID, *res, nextRunAtMS)

	return res, nil
}

// resolveCPAKey 尝试通过管理接口动态获取 CPA 的可用 API Key
func (s *Service) resolveCPAKey(ctx context.Context, cpaBase, mgmtKey string) string {
	reqURL := cpaBase + "/v0/management/api-keys"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return ""
	}
	if mgmtKey != "" {
		req.Header.Set("Authorization", "Bearer "+mgmtKey)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return ""
	}
	defer resp.Body.Close()

	var keys []string
	if err := json.NewDecoder(resp.Body).Decode(&keys); err == nil && len(keys) > 0 {
		for _, k := range keys {
			if strings.TrimSpace(k) != "" {
				return strings.TrimSpace(k)
			}
		}
	}
	return ""
}

// extractSnippet 从 Chat Completions 返回的 JSON 报文中提取模型文本内容
func extractSnippet(body []byte) string {
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil && len(parsed.Choices) > 0 {
		content := strings.TrimSpace(parsed.Choices[0].Message.Content)
		if content != "" {
			return content
		}
	}
	return "(OK)"
}
