package acp

import "encoding/json"

// ── ACP JSON-RPC types ──────────────────────────────────────────────────────

type JsonRpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *JsonRpcError   `json:"error,omitempty"`
}

type JsonRpcError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// ── ACP Initialize ──────────────────────────────────────────────────────────

type InitializeRequest struct {
	ProtocolVersion    int                    `json:"protocolVersion"`
	ClientInfo         Implementation         `json:"clientInfo"`
	ClientCapabilities map[string]interface{} `json:"clientCapabilities,omitempty"`
}

type Implementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type InitializeResponse struct {
	ProtocolVersion   int                `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities  `json:"agentCapabilities"`
	AgentInfo         Implementation     `json:"agentInfo"`
}

type AgentCapabilities struct {
	Auth *AuthCapabilities `json:"auth,omitempty"`
}

type AuthCapabilities struct {
	Type string `json:"type"`
}

// ── ACP Session ─────────────────────────────────────────────────────────────

type NewSessionRequest struct {
	Cwd                  string    `json:"cwd"`
	AdditionalDirectories []string `json:"additionalDirectories,omitempty"`
	McpServers           []McpServer `json:"mcpServers,omitempty"`
}

type McpServer struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type NewSessionResponse struct {
	SessionID string `json:"sessionId"`
}

// ── ACP Prompt ──────────────────────────────────────────────────────────────

type PromptRequest struct {
	SessionID string         `json:"sessionId"`
	Prompt    []ContentBlock `json:"prompt"`
}

type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type PromptResponse struct {
	StopReason string `json:"stopReason"`
}

// ── ACP Cancel / Close ──────────────────────────────────────────────────────

type CancelNotification struct {
	SessionID string `json:"sessionId"`
}

type CloseSessionRequest struct {
	SessionID string `json:"sessionId"`
}

// ── ACP Session Update notifications ────────────────────────────────────────

type AgentMessageChunk struct {
	SessionUpdate string        `json:"sessionUpdate"` // "agent_message_chunk"
	MessageID     string        `json:"messageId"`
	Content       ContentBlock  `json:"content"`
}

type ToolCallUpdate struct {
	SessionUpdate string        `json:"sessionUpdate"`
	ToolCallID    string        `json:"toolCallId"`
	Status        string        `json:"status"`
	Content       interface{}   `json:"content,omitempty"`
}

type UsageUpdate struct {
	SessionUpdate string `json:"sessionUpdate"` // "usage_update"
	Used          int    `json:"used"`
	Size          int    `json:"size"`
	Cost          *Cost  `json:"cost,omitempty"`
}

type Cost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// ── Work log entry ──────────────────────────────────────────────────────────

type WorkLogEntry struct {
	Role    string `json:"role"`    // "user" | "assistant"
	Text    string `json:"text"`
	Summary string `json:"summary,omitempty"`
}

// ── Backend configuration (loaded from YAML) ────────────────────────────────

type BackendConfig struct {
	Runtime  string                 `yaml:"runtime"`
	Provider string                 `yaml:"provider,omitempty"`
	Model    string                 `yaml:"model,omitempty"`
	APIKey   string                 `yaml:"apiKey,omitempty"`
	Extra    map[string]interface{} `yaml:"extra,omitempty"`
}

type ServerConfig struct {
	Backends map[string]BackendConfig `yaml:"backends"`
	Default  string                  `yaml:"default,omitempty"`
	Port     int                     `yaml:"port,omitempty"`
	Host     string                  `yaml:"host,omitempty"`
}
