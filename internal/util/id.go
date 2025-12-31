package util

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
	"time"
)

func newID(prefix string) string {
	// 80 bits random + timestamp prefix for better sorting.
	var b [10]byte
	_, _ = rand.Read(b[:])
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:])
	enc = strings.ToLower(enc)
	return prefix + time.Now().UTC().Format("20060102t150405z") + "_" + enc
}

func NewRunID() string  { return newID("run_") }
func NewStepID() string { return newID("step_") }
func NewSessionID() string {
	return newID("sess_")
}
func NewMessageID() string {
	return newID("msg_")
}
func NewTurnID() string {
	return newID("turn_")
}
func NewToolCallID() string {
	return newID("call_")
}
func NewAttachmentID() string {
	return newID("att_")
}
