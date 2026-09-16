package model

import (
	"testing"
	"time"
)

func TestCalculateNextRunAtMS_TargetReset(t *testing.T) {
	loc := time.Local
	// 场景 1：当前时间是早晨 03:00，目标重置时间 10:00，提前 5 小时 -> 预热时间应为当天 05:00
	nowEarly := time.Date(2026, 9, 16, 3, 0, 0, 0, loc)
	sched := &AccountWarmupSchedule{
		Mode:            WarmupModeTargetReset,
		TargetResetTime: "10:00",
		LeadHours:       5,
	}
	nextMS := sched.CalculateNextRunAtMS(nowEarly)
	expectedTime := time.Date(2026, 9, 16, 5, 0, 0, 0, loc)
	if nextMS != expectedTime.UnixMilli() {
		t.Fatalf("expected %v (%d), got %v (%d)", expectedTime, expectedTime.UnixMilli(), time.UnixMilli(nextMS), nextMS)
	}

	// 场景 2：当前时间是早晨 09:07，目标预热时间 05:00 已过去 -> 预热时间应顺延至次日 05:00
	nowLate := time.Date(2026, 9, 16, 9, 7, 0, 0, loc)
	nextMSLate := sched.CalculateNextRunAtMS(nowLate)
	expectedTomorrow := time.Date(2026, 9, 17, 5, 0, 0, 0, loc)
	if nextMSLate != expectedTomorrow.UnixMilli() {
		t.Fatalf("expected %v (%d), got %v (%d)", expectedTomorrow, expectedTomorrow.UnixMilli(), time.UnixMilli(nextMSLate), nextMSLate)
	}

	// 场景 3：跨零点提前量（如 02:00 重置，提前 5 小时 -> 前一天 21:00）
	// 当前时间 20:00，重置时间 02:00，提前 5 小时 -> 当天 21:00
	schedCrossMidnight := &AccountWarmupSchedule{
		Mode:            WarmupModeTargetReset,
		TargetResetTime: "02:00",
		LeadHours:       5,
	}
	nowBeforeCross := time.Date(2026, 9, 16, 20, 0, 0, 0, loc)
	nextMSCross := schedCrossMidnight.CalculateNextRunAtMS(nowBeforeCross)
	expectedCross := time.Date(2026, 9, 16, 21, 0, 0, 0, loc)
	if nextMSCross != expectedCross.UnixMilli() {
		t.Fatalf("expected cross midnight %v (%d), got %v (%d)", expectedCross, expectedCross.UnixMilli(), time.UnixMilli(nextMSCross), nextMSCross)
	}
}

func TestCalculateNextRunAtMS_Interval(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, loc)
	sched := &AccountWarmupSchedule{
		Mode:            WarmupModeInterval,
		IntervalMinutes: 30,
	}
	nextMS := sched.CalculateNextRunAtMS(now)
	expectedTime := time.Date(2026, 9, 16, 12, 30, 0, 0, loc)
	if nextMS != expectedTime.UnixMilli() {
		t.Fatalf("expected %v (%d), got %v (%d)", expectedTime, expectedTime.UnixMilli(), time.UnixMilli(nextMS), nextMS)
	}
}

func TestCalculateNextRunAtMS_DefaultFallback(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 9, 16, 1, 0, 0, 0, loc)
	// 未设置参数时，默认重置时间 10:00，默认提前 5 小时 -> 05:00
	sched := &AccountWarmupSchedule{}
	nextMS := sched.CalculateNextRunAtMS(now)
	expectedTime := time.Date(2026, 9, 16, 5, 0, 0, 0, loc)
	if nextMS != expectedTime.UnixMilli() {
		t.Fatalf("expected fallback %v (%d), got %v (%d)", expectedTime, expectedTime.UnixMilli(), time.UnixMilli(nextMS), nextMS)
	}
}
