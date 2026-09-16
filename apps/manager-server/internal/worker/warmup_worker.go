package worker

import (
	"context"
	"log"
	"sync"
	"time"

	warmuprepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/warmup"
	warmupsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/warmup"
)

// WarmupWorker 服务端 7×24 小时脱机预热常驻守护协程
// 负责在后台定时检测到期任务并自主发起预热请求，彻底脱离浏览器生命周期
type WarmupWorker struct {
	service *warmupsvc.Service
	repo    warmuprepo.Repository
	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool
}

// NewWarmupWorker 实例化脱机预热常驻守护 Worker
func NewWarmupWorker(service *warmupsvc.Service, repo warmuprepo.Repository) *WarmupWorker {
	return &WarmupWorker{
		service: service,
		repo:    repo,
	}
}

// Start 启动后台定时预热守护协程
func (w *WarmupWorker) Start(ctx context.Context) {
	if w == nil || w.service == nil || w.repo == nil {
		return
	}
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return
	}
	workerCtx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	w.done = make(chan struct{})
	w.started = true
	done := w.done
	w.mu.Unlock()

	go func() {
		defer close(done)
		w.run(workerCtx)
	}()
}

// Stop 停止守护协程
func (w *WarmupWorker) Stop() {
	if w == nil {
		return
	}
	w.mu.Lock()
	if !w.started {
		w.mu.Unlock()
		return
	}
	w.started = false
	cancel := w.cancel
	done := w.done
	w.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

// run 常驻循环执行逻辑
func (w *WarmupWorker) run(ctx context.Context) {
	log.Printf("[warmup-worker] started 7x24h server-side background warmup scheduler")

	// 1. 服务启动时立即执行一次跨期补偿检查（处理停机或重启造成的历史错过任务）
	w.tick(ctx)

	// 2. 每 30 秒轮询一次数据库中是否有到期预热配置
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[warmup-worker] background warmup scheduler stopped")
			return
		case <-ticker.C:
			w.tick(ctx)
		}
	}
}

// tick 单次轮询到期任务并触发预热执行
func (w *WarmupWorker) tick(ctx context.Context) {
	nowMS := time.Now().UnixMilli()
	dueList, err := w.repo.FindDueSchedules(ctx, nowMS)
	if err != nil {
		log.Printf("[warmup-worker] query due warmup schedules error: %v", err)
		return
	}

	if len(dueList) == 0 {
		return
	}

	for _, sched := range dueList {
		if ctx.Err() != nil {
			return
		}
		item := sched
		log.Printf("[warmup-worker] triggering scheduled warmup for account: %s (selectionKey: %s, model: %s, targetReset: %s)",
			item.AccountKey, item.SelectionKey, item.Model, item.TargetResetTime)

		// 为单次探测请求分配 35 秒独立超时上下文
		execCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
		res, err := w.service.ExecuteWarmup(execCtx, &item, "scheduled")
		cancel()

		if err != nil {
			log.Printf("[warmup-worker] warmup request error for %s: %v", item.AccountKey, err)
		} else if res.Success {
			log.Printf("[warmup-worker] warmup succeeded for %s: status=%d, latency=%dms, response=%s",
				item.AccountKey, res.StatusCode, res.LatencyMS, res.ResponseSnippet)
		} else {
			log.Printf("[warmup-worker] warmup failed for %s: status=%d, latency=%dms, error=%s",
				item.AccountKey, res.StatusCode, res.LatencyMS, res.ErrorMessage)
		}
	}
}
