package ai

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode"

	"github.com/PatchMon/PatchMon/server-source-code/internal/models"
)

// CLIProviderID is the settings.ai_provider value that routes the assistant
// through a locally installed CLI agent instead of a hosted API provider.
const CLIProviderID = "cli"

const (
	cliPromptPlaceholder = "{{prompt}}"
	defaultCLIPresetID   = "codex"

	// cliTimeout bounds a single CLI invocation. Agentic CLIs can take a while,
	// but the request must never hang forever.
	cliTimeout = 120 * time.Second

	cliMaxOutputBytes = 256 * 1024
	cliMaxErrorBytes  = 8 * 1024
)

// CLIPreset is a ready-made invocation for a known local CLI agent.
type CLIPreset struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	Hint    string `json:"hint,omitempty"`
}

// cliPresets is exposed to the settings UI. Each command either contains the
// cliPromptPlaceholder (the prompt is passed as an argument) or omits it (the
// prompt is written to the process's stdin).
var cliPresets = []CLIPreset{
	{
		ID:      "codex",
		Name:    "OpenAI Codex CLI",
		Command: "codex exec --skip-git-repo-check -",
		Hint:    "Runs `codex exec` headlessly with the prompt on stdin. Add --sandbox, --model or other flags if your Codex version needs them.",
	},
	{
		ID:      "agy",
		Name:    "Google Antigravity CLI (agy)",
		Command: "agy -p " + cliPromptPlaceholder,
		Hint:    "Runs `agy -p` in headless mode. Sign in to agy on the PatchMon server host before enabling this.",
	},
	{
		ID:      "custom",
		Name:    "Custom command",
		Command: "",
		Hint:    "Full command to run. Include " + cliPromptPlaceholder + " where the question goes, or omit it to pipe the prompt on stdin.",
	},
}

// GetCLIPresets returns the built-in local CLI invocations.
func GetCLIPresets() []CLIPreset {
	out := make([]CLIPreset, len(cliPresets))
	copy(out, cliPresets)
	return out
}

func cliPresetByID(id string) (CLIPreset, bool) {
	for _, p := range cliPresets {
		if p.ID == id {
			return p, true
		}
	}
	return CLIPreset{}, false
}

// IsCLIProvider reports whether provider routes through a local CLI.
func IsCLIProvider(provider string) bool {
	return EffectiveProvider(provider) == CLIProviderID
}

// EffectiveProvider resolves an empty provider to the historical default.
func EffectiveProvider(provider string) string {
	if strings.TrimSpace(provider) == "" {
		return "openrouter"
	}
	return provider
}

// ResolveCLICommand returns the command template to run, falling back to the
// selected preset's default when no explicit command has been saved.
func ResolveCLICommand(settings *models.Settings) string {
	if settings == nil {
		return ""
	}
	if settings.AiCLICommand != nil {
		if cmd := strings.TrimSpace(*settings.AiCLICommand); cmd != "" {
			return cmd
		}
	}
	preset := strings.TrimSpace(settings.AiCLIPreset)
	if preset == "" {
		preset = defaultCLIPresetID
	}
	if p, ok := cliPresetByID(preset); ok {
		return p.Command
	}
	return ""
}

// CLIConfigured reports whether a local CLI command is resolvable.
func CLIConfigured(settings *models.Settings) bool {
	return ResolveCLICommand(settings) != ""
}

// buildCLIPrompt flattens the system prompt, terminal context, conversation
// history and the current question into a single prompt, because CLI agents do
// not have a separate system role.
func buildCLIPrompt(systemPrompt, question, termContext string, history []Message) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(systemPrompt))
	if termContext != "" {
		b.WriteString("\n\nRecent terminal output:\n```\n")
		b.WriteString(termContext)
		b.WriteString("\n```")
	}
	if len(history) > 0 {
		b.WriteString("\n\nConversation so far:\n")
		for _, m := range history {
			role := "User"
			if m.Role == "assistant" {
				role = "Assistant"
			}
			b.WriteString(role)
			b.WriteString(": ")
			b.WriteString(m.Content)
			b.WriteString("\n")
		}
	}
	b.WriteString("\nUser: ")
	b.WriteString(question)
	return b.String()
}

// splitCommandWords splits a command template into arguments, honouring single
// quotes, double quotes and backslash escapes. It deliberately does not run a
// shell, so metacharacters cannot escape the configured command.
func splitCommandWords(s string) ([]string, error) {
	var args []string
	var b strings.Builder
	inWord := false
	var quote rune
	escaped := false

	for _, r := range s {
		switch {
		case escaped:
			b.WriteRune(r)
			escaped = false
			inWord = true
		case r == '\\' && quote != '\'':
			escaped = true
			inWord = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				b.WriteRune(r)
			}
			inWord = true
		case r == '\'' || r == '"':
			quote = r
			inWord = true
		case unicode.IsSpace(r):
			if inWord {
				args = append(args, b.String())
				b.Reset()
				inWord = false
			}
		default:
			b.WriteRune(r)
			inWord = true
		}
	}
	if escaped {
		b.WriteRune('\\')
	}
	if quote != 0 {
		return nil, errors.New("unterminated quote in local CLI command")
	}
	if inWord {
		args = append(args, b.String())
	}
	return args, nil
}

// parseCLICommand expands a command template into argv. When the placeholder is
// present the prompt is substituted in place; otherwise the caller should write
// the prompt to stdin (useStdin is true).
func parseCLICommand(template, prompt string) ([]string, bool, error) {
	args, err := splitCommandWords(template)
	if err != nil {
		return nil, false, err
	}
	if len(args) == 0 || strings.TrimSpace(args[0]) == "" {
		return nil, false, errors.New("local CLI command is empty")
	}
	useStdin := true
	for i, arg := range args {
		if strings.Contains(arg, cliPromptPlaceholder) {
			args[i] = strings.ReplaceAll(arg, cliPromptPlaceholder, prompt)
			useStdin = false
		}
	}
	return args, useStdin, nil
}

// cappedBuffer keeps at most max bytes, discarding the rest, so a runaway CLI
// cannot exhaust server memory.
type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	remaining := c.max - c.buf.Len()
	if remaining > 0 {
		if len(p) > remaining {
			_, _ = c.buf.Write(p[:remaining])
		} else {
			_, _ = c.buf.Write(p)
		}
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string {
	return c.buf.String()
}

func cliStderrSuffix(b []byte) string {
	s := strings.TrimSpace(string(b))
	if s == "" {
		return ""
	}
	if len(s) > 500 {
		s = s[len(s)-500:]
	}
	return ": " + s
}

// callCLI runs the configured local CLI with the assembled prompt.
func (s *Service) callCLI(ctx context.Context, settings *models.Settings, systemPrompt, question, termContext string, history []Message) (string, error) {
	command := ResolveCLICommand(settings)
	if command == "" {
		return "", fmt.Errorf("local CLI command not configured")
	}
	prompt := buildCLIPrompt(systemPrompt, question, termContext, history)
	argv, useStdin, err := parseCLICommand(command, prompt)
	if err != nil {
		return "", err
	}

	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, argv[0], argv[1:]...)
	if useStdin {
		cmd.Stdin = strings.NewReader(prompt)
	}
	stdout := &cappedBuffer{max: cliMaxOutputBytes}
	stderr := &cappedBuffer{max: cliMaxErrorBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	runErr := cmd.Run()
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("local CLI timed out after %s", cliTimeout)
	}
	if runErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", fmt.Errorf("local CLI cancelled: %w", ctxErr)
		}
		if errors.Is(runErr, exec.ErrNotFound) {
			return "", fmt.Errorf("local CLI executable not found: %s", argv[0])
		}
		return "", fmt.Errorf("local CLI failed: %w%s", runErr, cliStderrSuffix(stderr.buf.Bytes()))
	}

	out := strings.TrimSpace(stdout.String())
	if out == "" {
		return "", fmt.Errorf("local CLI returned no output")
	}
	return out, nil
}
