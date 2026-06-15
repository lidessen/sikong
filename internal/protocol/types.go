// Package protocol defines the JSON-RPC protocol between the Go daemon and
// the Bun worker subprocess, matching packages/sikong/src/worker-protocol.ts.
package protocol

// ── Worker Runtime Configuration ───────────────────────────────────────────

type WorkerProviderConfig struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey,omitempty"`
	BaseURL string `json:"baseURL,omitempty"`
}

type WakeWorkerConfig struct {
	Runtime        string               `json:"runtime"`
	Provider       WorkerProviderConfig `json:"provider"`
	PermissionMode string               `json:"permissionMode,omitempty"`
	Cwd            string               `json:"cwd,omitempty"`
	Env            map[string]string    `json:"env,omitempty"`
}

type WakeTaskContext struct {
	TaskID        string                     `json:"taskId"`
	WorkflowID    string                     `json:"workflowId"`
	WorkflowVer   string                     `json:"workflowVersion"`
	StageID       string                     `json:"stageId"`
	SystemPrompt  string                     `json:"systemPrompt"`
	UserPrompt    string                     `json:"userPrompt"`
	Tools         map[string]ToolDef         `json:"tools,omitempty"`
	MCPServers    map[string]MCPServerConfig `json:"mcpServers,omitempty"`
	MaxSteps      int                        `json:"maxSteps,omitempty"`
	Effort        string                     `json:"effort,omitempty"`
	ContextWindow int                        `json:"contextWindow,omitempty"`
}

type ToolDef struct {
	Description string      `json:"description,omitempty"`
	InputSchema interface{} `json:"inputSchema,omitempty"`
}

type MCPServerConfig struct {
	Type    string            `json:"type,omitempty"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	URL     string            `json:"url,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// ── JSON-RPC Messages ──────────────────────────────────────────────────────

type JsonRpcMessage struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Method  string      `json:"method,omitempty"`
	Params  interface{} `json:"params,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RpcError   `json:"error,omitempty"`
}

type RpcError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// ── Initialize ─────────────────────────────────────────────────────────────

type InitializeParams struct {
	ProtocolVersion string     `json:"protocolVersion"`
	ClientInfo      ClientInfo `json:"clientInfo"`
}

type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type InitializeResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Capabilities    WorkerCapabilities `json:"capabilities"`
}

type WorkerCapabilities struct {
	Steer  bool `json:"steer"`
	Cancel bool `json:"cancel"`
	Usage  bool `json:"usage"`
}

// ── runWake ────────────────────────────────────────────────────────────────

type RunWakeParams struct {
	Worker WakeWorkerConfig `json:"worker"`
	Task   WakeTaskContext  `json:"task"`
}

type RunWakeResult struct {
	Usage      TokenUsage    `json:"usage"`
	DurationMs int64         `json:"durationMs"`
	Status     string        `json:"status"`
	Text       string        `json:"text"`
	Commands   []WakeCommand `json:"commands,omitempty"`
	Error      string        `json:"error,omitempty"`
}

type WakeCommand struct {
	Kind   string      `json:"kind"`
	Field  string      `json:"field,omitempty"`
	Value  interface{} `json:"value,omitempty"`
	Reason string      `json:"reason,omitempty"`
	Text   string      `json:"text,omitempty"`
}

type TokenUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	TotalTokens  int `json:"totalTokens"`
}

// ── Wake Event Notifications ───────────────────────────────────────────────

type WakeTextNotification struct {
	Delta string `json:"delta"`
}

type WakeThinkingNotification struct {
	Delta string `json:"delta"`
}

type WakeToolCallStartNotification struct {
	Name   string                 `json:"name"`
	CallID string                 `json:"callId,omitempty"`
	Args   map[string]interface{} `json:"args"`
}

type WakeToolCallEndNotification struct {
	Name       string      `json:"name"`
	CallID     string      `json:"callId,omitempty"`
	Result     interface{} `json:"result,omitempty"`
	Error      string      `json:"error,omitempty"`
	DurationMs int64       `json:"durationMs,omitempty"`
}

type WakeUsageNotification struct {
	InputTokens   int     `json:"inputTokens"`
	OutputTokens  int     `json:"outputTokens"`
	TotalTokens   int     `json:"totalTokens"`
	Source        string  `json:"source"`
	ContextWindow int     `json:"contextWindow,omitempty"`
	UsedRatio     float64 `json:"usedRatio,omitempty"`
}
