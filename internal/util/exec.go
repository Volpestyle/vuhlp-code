package util

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"
)

type CmdResult struct {
	Cmd      string `json:"cmd"`
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Duration string `json:"duration"`
}

type ExecOptions struct {
	Dir     string
	Env     []string
	Timeout time.Duration
}

// RunCommand executes a shell command using /bin/bash -lc, capturing stdout/stderr.
func RunCommand(ctx context.Context, cmd string, opts ExecOptions) (CmdResult, error) {
	if cmd == "" {
		return CmdResult{}, errors.New("cmd is empty")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 10 * time.Minute
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	c := exec.CommandContext(ctx, "/bin/bash", "-lc", cmd)
	if opts.Dir != "" {
		c.Dir = opts.Dir
	}
	if len(opts.Env) > 0 {
		c.Env = append(c.Env, opts.Env...)
	}

	var stdout, stderr bytes.Buffer
	c.Stdout = &stdout
	c.Stderr = &stderr
	err := c.Run()

	exitCode := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			exitCode = 124
		} else {
			exitCode = 1
		}
	}

	res := CmdResult{
		Cmd:      cmd,
		ExitCode: exitCode,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		Duration: time.Since(start).String(),
	}
	return res, err
}
