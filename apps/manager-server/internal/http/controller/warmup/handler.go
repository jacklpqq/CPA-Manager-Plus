package warmup

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

// Handler 凭据预热 RESTful API 控制器
type Handler struct {
	App *app.Context
}

// Handle 路由调度入口
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	// 面板鉴权校验
	if !middleware.AuthorizePanel(w, r, h.App.AdminAuthService) {
		return
	}

	path := strings.TrimRight(r.URL.Path, "/")
	switch {
	// 预热调度配置管理接口
	case path == "/v0/management/warmup/schedules":
		switch r.Method {
		case http.MethodGet:
			selectionKey := r.URL.Query().Get("selectionKey")
			if selectionKey != "" {
				item, err := h.App.WarmupService.GetSchedule(r.Context(), selectionKey)
				if err != nil {
					response.Error(w, http.StatusInternalServerError, err)
					return
				}
				if item == nil {
					response.JSON(w, http.StatusOK, map[string]any{"item": nil})
					return
				}
				response.JSON(w, http.StatusOK, map[string]any{"item": item})
				return
			}
			list, err := h.App.WarmupService.ListSchedules(r.Context())
			if err != nil {
				response.Error(w, http.StatusInternalServerError, err)
				return
			}
			response.JSON(w, http.StatusOK, map[string]any{"items": list})
			return

		case http.MethodPut, http.MethodPost:
			var sched model.AccountWarmupSchedule
			if err := json.NewDecoder(r.Body).Decode(&sched); err != nil {
				response.Error(w, http.StatusBadRequest, err)
				return
			}
			if strings.TrimSpace(sched.SelectionKey) == "" {
				response.Error(w, http.StatusBadRequest, errors.New("selectionKey is required"))
				return
			}
			if err := h.App.WarmupService.SaveSchedule(r.Context(), &sched); err != nil {
				response.Error(w, http.StatusInternalServerError, err)
				return
			}
			response.JSON(w, http.StatusOK, sched)
			return

		case http.MethodDelete:
			selectionKey := r.URL.Query().Get("selectionKey")
			if selectionKey == "" {
				var req struct {
					SelectionKey string `json:"selectionKey"`
				}
				_ = json.NewDecoder(r.Body).Decode(&req)
				selectionKey = req.SelectionKey
			}
			if strings.TrimSpace(selectionKey) == "" {
				response.Error(w, http.StatusBadRequest, errors.New("selectionKey is required"))
				return
			}
			if err := h.App.WarmupService.DeleteSchedule(r.Context(), selectionKey); err != nil {
				response.Error(w, http.StatusInternalServerError, err)
				return
			}
			response.JSON(w, http.StatusOK, map[string]any{"ok": true})
			return

		default:
			response.MethodNotAllowed(w)
			return
		}

	// 立即手动触发预热测试接口
	case path == "/v0/management/warmup/run":
		if r.Method != http.MethodPost {
			response.MethodNotAllowed(w)
			return
		}
		var req struct {
			SelectionKey string                      `json:"selectionKey"`
			CustomConfig *model.AccountWarmupSchedule `json:"customConfig,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			response.Error(w, http.StatusBadRequest, err)
			return
		}
		if strings.TrimSpace(req.SelectionKey) == "" {
			response.Error(w, http.StatusBadRequest, errors.New("selectionKey is required"))
			return
		}

		var targetSched *model.AccountWarmupSchedule
		if req.CustomConfig != nil && req.CustomConfig.Model != "" {
			targetSched = req.CustomConfig
			targetSched.SelectionKey = req.SelectionKey
		} else {
			existing, err := h.App.WarmupService.GetSchedule(r.Context(), req.SelectionKey)
			if err != nil || existing == nil {
				response.Error(w, http.StatusNotFound, errors.New("schedule not found for selectionKey"))
				return
			}
			targetSched = existing
		}

		res, err := h.App.WarmupService.ExecuteWarmup(r.Context(), targetSched, "manual")
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err)
			return
		}
		response.JSON(w, http.StatusOK, res)
		return

	// 预热历史执行明细日志接口
	case path == "/v0/management/warmup/logs":
		if r.Method != http.MethodGet {
			response.MethodNotAllowed(w)
			return
		}
		selectionKey := r.URL.Query().Get("selectionKey")
		if strings.TrimSpace(selectionKey) == "" {
			response.Error(w, http.StatusBadRequest, errors.New("selectionKey is required"))
			return
		}
		limit := 20
		if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
			if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
				limit = l
			}
		}
		logs, err := h.App.WarmupService.ListLogs(r.Context(), selectionKey, limit)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err)
			return
		}
		response.JSON(w, http.StatusOK, map[string]any{"items": logs})
		return

	default:
		http.NotFound(w, r)
	}
}
