package ai

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/PatchMon/PatchMon/server-source-code/internal/models"
)

// TestCLIHelperProcess is not a real test: it is re-executed as the "local CLI"
// so the CLI runner can be exercised end-to-end without depending on an
// installed agent like codex or agy.
func TestCLIHelperProcess(t *testing.T) {
	if os.Getenv("PATCHMON_AI_CLI_HELPER") != "1" {
		t.Skip("helper process for local CLI tests")
	}
	prompt := ""
	args := os.Args
	for i, a := range args {
		if a == "--" && i+1 < len(args) {
			prompt = args[i+1]
		}
	}
	if prompt == "" {
		data, _ := io.ReadAll(os.Stdin)
		prompt = string(data)
	}
	_, _ = fmt.Fprintf(os.Stdout, "CLI_HELPER: %s", strings.TrimSpace(prompt))
	os.Exit(0)
}

func TestResolveCLICommand(t *testing.T) {
	custom := "my-agent {{prompt}}"
	cases := []struct {
		name     string
		settings *models.Settings
		want     string
	}{
		{"explicit command wins", &models.Settings{AiCLIPreset: "codex", AiCLICommand: &custom}, custom},
		{"default preset when unset", &models.Settings{}, "codex exec --skip-git-repo-check -"},
		{"named preset", &models.Settings{AiCLIPreset: "agy"}, "agy -p {{prompt}}"},
		{"custom preset with no command", &models.Settings{AiCLIPreset: "custom"}, ""},
		{"unknown preset", &models.Settings{AiCLIPreset: "nope"}, ""},
		{"nil settings", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveCLICommand(tc.settings); got != tc.want {
				t.Fatalf("ResolveCLICommand = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIsCLIProvider(t *testing.T) {
	for provider, want := range map[string]bool{
		"cli":        true,
		"":           false,
		"openrouter": false,
		"anthropic":  false,
	} {
		if got := IsCLIProvider(provider); got != want {
			t.Errorf("IsCLIProvider(%q) = %v, want %v", provider, got, want)
		}
	}
}

func TestSplitCommandWords(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`codex exec --skip-git-repo-check -`, []string{"codex", "exec", "--skip-git-repo-check", "-"}},
		{`agy -p "hello world"`, []string{"agy", "-p", "hello world"}},
		{`sh -c 'echo hi'`, []string{"sh", "-c", "echo hi"}},
		{`prog --flag=value`, []string{"prog", "--flag=value"}},
		{`  spaced   out  `, []string{"spaced", "out"}},
	}
	for _, tc := range cases {
		got, err := splitCommandWords(tc.in)
		if err != nil {
			t.Fatalf("splitCommandWords(%q) error: %v", tc.in, err)
		}
		if strings.Join(got, "\x00") != strings.Join(tc.want, "\x00") {
			t.Errorf("splitCommandWords(%q) = %#v, want %#v", tc.in, got, tc.want)
		}
	}

	if _, err := splitCommandWords(`prog "unterminated`); err == nil {
		t.Error("expected an error for an unterminated quote")
	}
}

func TestParseCLICommand(t *testing.T) {
	t.Run("placeholder becomes one argument", func(t *testing.T) {
		argv, useStdin, err := parseCLICommand("agy -p {{prompt}}", "why did apt fail?")
		if err != nil {
			t.Fatal(err)
		}
		if useStdin {
			t.Fatal("expected prompt to be passed as an argument")
		}
		want := []string{"agy", "-p", "why did apt fail?"}
		if strings.Join(argv, "\x00") != strings.Join(want, "\x00") {
			t.Fatalf("argv = %#v, want %#v", argv, want)
		}
	})

	t.Run("no placeholder uses stdin", func(t *testing.T) {
		argv, useStdin, err := parseCLICommand("codex exec --skip-git-repo-check -", "prompt")
		if err != nil {
			t.Fatal(err)
		}
		if !useStdin {
			t.Fatal("expected prompt to be piped on stdin")
		}
		if argv[len(argv)-1] != "-" {
			t.Fatalf("argv = %#v, want trailing '-'", argv)
		}
	})

	t.Run("empty command is rejected", func(t *testing.T) {
		if _, _, err := parseCLICommand("   ", "prompt"); err == nil {
			t.Fatal("expected an error for an empty command")
		}
	})
}

func TestBuildCLIPromptIncludesEverything(t *testing.T) {
	got := buildCLIPrompt("SYS", "how do I restart nginx?", "nginx: failed", []Message{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "hello"},
	})
	for _, want := range []string{"SYS", "nginx: failed", "User: hi", "Assistant: hello", "how do I restart nginx?"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q:\n%s", want, got)
		}
	}
}

func TestGetCompletionSkipsCLIProvider(t *testing.T) {
	svc := NewService(nil)
	settings := &models.Settings{AiProvider: CLIProviderID}
	got, err := svc.GetCompletion(settings, "systemctl rest", "context")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "" {
		t.Fatalf("completion = %q, want empty for a local CLI provider", got)
	}
}

func TestCallCLIWithArgumentPrompt(t *testing.T) {
	exe := helperExecutable(t)
	command := fmt.Sprintf("%q -test.run=TestCLIHelperProcess -- {{prompt}}", exe)
	settings := &models.Settings{AiProvider: CLIProviderID, AiCLIPreset: "custom", AiCLICommand: &command}

	out, err := NewService(nil).GetAssistance(context.Background(), settings, "why did apt fail?", "", nil)
	if err != nil {
		t.Fatalf("GetAssistance error: %v", err)
	}
	if !strings.Contains(out, "CLI_HELPER:") || !strings.Contains(out, "why did apt fail?") {
		t.Fatalf("unexpected CLI output: %q", out)
	}
}

func TestCallCLIWithStdinPrompt(t *testing.T) {
	exe := helperExecutable(t)
	command := fmt.Sprintf("%q -test.run=TestCLIHelperProcess --", exe)
	settings := &models.Settings{AiProvider: CLIProviderID, AiCLIPreset: "custom", AiCLICommand: &command}

	out, err := NewService(nil).GetAssistance(context.Background(), settings, "explain this stack trace", "panic: boom", nil)
	if err != nil {
		t.Fatalf("GetAssistance error: %v", err)
	}
	if !strings.Contains(out, "CLI_HELPER:") || !strings.Contains(out, "explain this stack trace") {
		t.Fatalf("unexpected CLI output: %q", out)
	}
	if !strings.Contains(out, "panic: boom") {
		t.Fatalf("stdin prompt missing terminal context: %q", out)
	}
}

func TestCallCLIMissingExecutable(t *testing.T) {
	command := "patchmon-definitely-not-a-real-binary-xyz {{prompt}}"
	settings := &models.Settings{AiProvider: CLIProviderID, AiCLIPreset: "custom", AiCLICommand: &command}

	_, err := NewService(nil).GetAssistance(context.Background(), settings, "hello", "", nil)
	if err == nil {
		t.Fatal("expected an error for a missing executable")
	}
}

// helperExecutable returns the path to the currently running test binary and
// arranges for the re-executed helper to recognise itself.
func helperExecutable(t *testing.T) string {
	t.Helper()
	t.Setenv("PATCHMON_AI_CLI_HELPER", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}
