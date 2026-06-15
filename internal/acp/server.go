package acp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// Server is the ACP TCP server.
type Server struct {
	config  ServerConfig
	sessions map[string]*Session
	mu      sync.RWMutex
	listener net.Listener
}

// NewServer creates a new ACP server with the given config.
func NewServer(config ServerConfig) *Server {
	if config.Port == 0 {
		config.Port = 9876
	}
	if config.Host == "" {
		config.Host = "127.0.0.1"
	}
	return &Server{
		config:   config,
		sessions: make(map[string]*Session),
	}
}

// Listen starts the TCP listener and begins accepting connections.
func (s *Server) Listen() error {
	addr := fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	s.listener = listener
	log.Printf("[acp-server] listening on %s", addr)

	for {
		conn, err := listener.Accept()
		if err != nil {
			return fmt.Errorf("accept: %w", err)
		}
		go s.handleConnection(conn)
	}
}

// Close stops the server and cleans up all sessions.
func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, sess := range s.sessions {
		sess.Close()
		delete(s.sessions, id)
	}
	if s.listener != nil {
		return s.listener.Close()
	}
	return nil
}

// handleConnection handles one TCP connection.
func (s *Server) handleConnection(conn net.Conn) {
	defer conn.Close()

	// Default backend name
	defaultBackend := s.config.Default
	if defaultBackend == "" {
		for name := range s.config.Backends {
			defaultBackend = name
			break
		}
	}

	scanner := bufio.NewScanner(conn)
	enc := json.NewEncoder(conn)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var msg JsonRpcMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			sendError(enc, msg.ID, -32700, "Parse error: "+err.Error())
			continue
		}

		response := s.handleMessage(msg, conn, enc, defaultBackend)
		if response != nil {
			enc.Encode(response)
		}
	}
}

func (s *Server) handleMessage(msg JsonRpcMessage, conn net.Conn, enc *json.Encoder, defaultBackend string) *JsonRpcResponse {
	switch msg.Method {
	case "initialize":
		return s.handleInitialize(msg)
	case "session/new":
		return s.handleNewSession(msg, defaultBackend)
	case "session/prompt":
		return s.handlePrompt(msg, conn, enc)
	case "session/cancel":
		return s.handleCancel(msg)
	case "session/close":
		return s.handleCloseSession(msg)
	default:
		return errorResponse(msg.ID, -32601, "Method not found: "+msg.Method)
	}
}

// ── ACP method handlers ─────────────────────────────────────────────────────

func (s *Server) handleInitialize(msg JsonRpcMessage) *JsonRpcResponse {
	var req InitializeRequest
	if err := json.Unmarshal(msg.Params, &req); err != nil {
		return errorResponse(msg.ID, -32602, "Invalid initialize params")
	}
	_ = req

	return resultResponse(msg.ID, InitializeResponse{
		ProtocolVersion: 1,
		AgentCapabilities: AgentCapabilities{
			Auth: &AuthCapabilities{Type: "none"},
		},
		AgentInfo: Implementation{
			Name:    "sikong-acp-server",
			Version: "0.1.0",
		},
	})
}

func (s *Server) handleNewSession(msg JsonRpcMessage, defaultBackend string) *JsonRpcResponse {
	var req NewSessionRequest
	if err := json.Unmarshal(msg.Params, &req); err != nil {
		return errorResponse(msg.ID, -32602, "Invalid session/new params")
	}
	_ = req

	id := fmt.Sprintf("sess_%d", time.Now().UnixNano())
	session := &Session{
		ID:      id,
		Backend: defaultBackend,
		WorkLog: []WorkLogEntry{},
	}

	s.mu.Lock()
	s.sessions[id] = session
	s.mu.Unlock()

	return resultResponse(msg.ID, NewSessionResponse{SessionID: id})
}

func (s *Server) handlePrompt(msg JsonRpcMessage, conn net.Conn, enc *json.Encoder) *JsonRpcResponse {
	var req PromptRequest
	if err := json.Unmarshal(msg.Params, &req); err != nil {
		return errorResponse(msg.ID, -32602, "Invalid session/prompt params")
	}

	s.mu.RLock()
	session, ok := s.sessions[req.SessionID]
	s.mu.RUnlock()
	if !ok {
		return errorResponse(msg.ID, -32000, "Session not found: "+req.SessionID)
	}

	// Extract text from prompt
	text := ""
	for _, block := range req.Prompt {
		if block.Type == "text" {
			text += block.Text
		}
	}

	// Handle slash commands
	if parsed := parseCommand(text); parsed != nil {
		return s.handleCommand(parsed, session, msg.ID)
	}

	// Get backend config
	backendCfg, ok := s.config.Backends[session.Backend]
	if !ok {
		return errorResponse(msg.ID, -32000, "Backend not found: "+session.Backend)
	}

	// Start worker and send prompt
	if err := session.StartWorker(backendCfg); err != nil {
		return errorResponse(msg.ID, -32000, "Worker error: "+err.Error())
	}

	session.AppendWorkLog("user", text)
	session.running = true

	if err := session.SendPrompt(text, backendCfg); err != nil {
		session.StopWorker()
		return errorResponse(msg.ID, -32000, "Send prompt error: "+err.Error())
	}

	// Stream events from worker to ACP client
	go func() {
		defer session.StopWorker()
		assistantText := ""

		for evt := range session.worker.Events {
			switch evt.Type {
			case "text":
				var data struct {
					Text string `json:"text"`
				}
				json.Unmarshal(evt.Data, &data)
				assistantText += data.Text

				enc.Encode(sessionUpdateMsg(req.SessionID, AgentMessageChunk{
					SessionUpdate: "agent_message_chunk",
					MessageID:     fmt.Sprintf("msg_%d", time.Now().UnixNano()),
					Content:       ContentBlock{Type: "text", Text: data.Text},
				}))

			case "usage":
				var data struct {
					TotalTokens int `json:"totalTokens"`
					ContextWindow int `json:"contextWindow"`
				}
				json.Unmarshal(evt.Data, &data)
				enc.Encode(sessionUpdateMsg(req.SessionID, UsageUpdate{
					SessionUpdate: "usage_update",
					Used:          data.TotalTokens,
					Size:          data.ContextWindow,
				}))
			}
		}

		session.AppendWorkLog("assistant", assistantText)
		session.running = false

		// Send prompt response
		enc.Encode(JsonRpcResponse{
			ID:   msg.ID,
			Result: mustMarshal(PromptResponse{StopReason: "end_turn"}),
		})
	}()

	// Return nil — the response will be sent asynchronously
	return nil
}

func (s *Server) handleCancel(msg JsonRpcMessage) *JsonRpcResponse {
	var req CancelNotification
	if err := json.Unmarshal(msg.Params, &req); err != nil {
		return errorResponse(msg.ID, -32602, "Invalid session/cancel params")
	}

	s.mu.RLock()
	session, ok := s.sessions[req.SessionID]
	s.mu.RUnlock()
	if !ok {
		return errorResponse(msg.ID, -32000, "Session not found")
	}

	session.StopWorker()
	return resultResponse(msg.ID, map[string]string{"cancelled": "true"})
}

func (s *Server) handleCloseSession(msg JsonRpcMessage) *JsonRpcResponse {
	var req CloseSessionRequest
	if err := json.Unmarshal(msg.Params, &req); err != nil {
		return errorResponse(msg.ID, -32602, "Invalid session/close params")
	}

	s.mu.Lock()
	session, ok := s.sessions[req.SessionID]
	if ok {
		session.Close()
		delete(s.sessions, req.SessionID)
	}
	s.mu.Unlock()

	return resultResponse(msg.ID, map[string]string{"closed": "true"})
}

// ── Command handling ────────────────────────────────────────────────────────

type Command struct {
	Kind string // "backend" | "model" | "status" | "help"
	Args string
}

func parseCommand(text string) *Command {
	if len(text) == 0 || text[0] != '/' {
		return nil
	}

	parts := split2(text[1:], " ")
	if parts == nil {
		return nil
	}

	cmd := parts[0]
	args := parts[1]

	switch cmd {
	case "backend":
		return &Command{Kind: "backend", Args: args}
	case "model":
		return &Command{Kind: "model", Args: args}
	case "status":
		return &Command{Kind: "status"}
	case "help":
		return &Command{Kind: "help"}
	default:
		return nil
	}
}

func split2(s, sep string) []string {
	for i := 0; i < len(s); i++ {
		if s[i:i+1] == sep {
			return []string{s[:i], s[i+1:]}
		}
	}
	return []string{s, ""}
}

func (s *Server) handleCommand(cmd *Command, session *Session, id json.RawMessage) *JsonRpcResponse {
	switch cmd.Kind {
	case "backend":
		if _, ok := s.config.Backends[cmd.Args]; !ok {
			names := make([]string, 0, len(s.config.Backends))
			for n := range s.config.Backends {
				names = append(names, n)
			}
			return resultResponse(id, map[string]string{
				"text": fmt.Sprintf("Unknown backend %q. Available: %v", cmd.Args, names),
			})
		}
		session.Backend = cmd.Args
		return resultResponse(id, map[string]string{
			"text": fmt.Sprintf("Switched to backend %q.", cmd.Args),
		})

	case "model":
		return resultResponse(id, map[string]string{
			"text": fmt.Sprintf("Model set to %q.", cmd.Args),
		})

	case "status":
		return resultResponse(id, map[string]string{
			"text": fmt.Sprintf("Backend: %s\nRunning: %v", session.Backend, session.running),
		})

	case "help":
		names := make([]string, 0, len(s.config.Backends))
		for n := range s.config.Backends {
			names = append(names, n)
		}
		return resultResponse(id, map[string]string{
			"text": fmt.Sprintf(
				"Available commands:\n"+
					"  /backend <name>  %v\n"+
					"  /model <id>\n"+
					"  /status\n"+
					"  /help", names),
		})

	default:
		return errorResponse(id, -32601, "Unknown command")
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type JsonRpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *JsonRpcError   `json:"error,omitempty"`
}

func resultResponse(id json.RawMessage, result interface{}) *JsonRpcResponse {
	return &JsonRpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  mustMarshal(result),
	}
}

func errorResponse(id json.RawMessage, code int, message string) *JsonRpcResponse {
	return &JsonRpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &JsonRpcError{Code: code, Message: message},
	}
}

func sendError(enc *json.Encoder, id json.RawMessage, code int, message string) {
	enc.Encode(errorResponse(id, code, message))
}

func sessionUpdateMsg(sessionID string, update interface{}) JsonRpcResponse {
	return JsonRpcResponse{
		Result: mustMarshal(map[string]interface{}{
			"sessionId": sessionID,
			"update":    update,
		}),
	}
}

func mustMarshal(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
