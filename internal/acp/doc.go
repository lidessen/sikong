// Package acp implements an Agent Client Protocol v1 server for sikong.
//
// The ACP server listens on TCP and exposes agent-loop backends as ACP agents.
// It follows the JSON-RPC 2.0 specification from https://agentclientprotocol.com
//
// Architecture:
//
//	Go ACP Server (TCP listener + ACP JSON-RPC handler)
//	  └── session/prompt → Bun worker subprocess (stdin/stdout JSON-RPC)
//	                        └── AgentLoop.run() → stream events
package acp
