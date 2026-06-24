use siko::*;

mod support;

/// A mock agent scheduler that produces a specific decomposed plan for
/// the "authentication system" evaluation scenario.
///
/// The scheduler recognizes the task by its key and produces a
/// multi-level decomposition that can be validated for quality metrics.
#[derive(Debug, Clone)]
struct AuthSystemPlanner;

#[async_trait::async_trait]
impl AgentRunScheduler for AuthSystemPlanner {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let node = input
            .input
            .get("node")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let key = node
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let terminal_tool = input.terminal_tool_set[0].clone();
        let arguments = match terminal_tool.as_str() {
            "submit_specification" => self.mock_specification(&key),
            "submit_plan_group" => self.mock_plan(&key),
            _ => serde_json::json!({}),
        };

        let call = AgentToolCall {
            name: terminal_tool.clone(),
            arguments,
        };

        AgentRunResponse {
            report: format!("auth system planner completed {}", input.objective),
            tool_calls: vec![call.clone()],
            terminal_call: Some(call),
            usage: None,
            events: Vec::new(),
        }
    }
}

impl AuthSystemPlanner {
    fn mock_specification(&self, key: &str) -> serde_json::Value {
        match key {
            "auth-system" => serde_json::json!({
                "next": "Design and implement a complete authentication system with OAuth, session management, token storage, user registration, and password management",
                "size": "x_large",
                "reason": "Auth system spans multiple independent subsystems with separate verification."
            }),
            "oauth-integration" => serde_json::json!({
                "next": "Integrate OAuth 2.0 provider support including Google, GitHub, and custom OAuth flows",
                "size": "large",
                "reason": "OAuth integration requires multiple provider implementations."
            }),
            "session-management" => serde_json::json!({
                "next": "Implement session creation, validation, refresh, and expiration",
                "size": "medium",
                "reason": "One coherent subsystem with related session operations."
            }),
            "token-storage" => serde_json::json!({
                "next": "Implement secure token storage with encrypted database storage",
                "size": "medium",
                "reason": "One coherent responsibility: store, retrieve, rotate, revoke."
            }),
            "user-registration" => serde_json::json!({
                "next": "Implement user registration with email verification and profile creation",
                "size": "medium",
                "reason": "Single registration flow end-to-end."
            }),
            "password-management" => serde_json::json!({
                "next": "Implement password hashing, reset flows, and policy enforcement",
                "size": "medium",
                "reason": "One coherent security responsibility."
            }),
            "google-oauth" => serde_json::json!({
                "next": "Implement Google OAuth 2.0 provider with authorization code flow",
                "size": "small",
                "reason": "One OAuth provider with standardized flow."
            }),
            "github-oauth" => serde_json::json!({
                "next": "Implement GitHub OAuth 2.0 provider with device authorization flow",
                "size": "small",
                "reason": "One OAuth provider with standardized flow."
            }),
            "custom-oauth" => serde_json::json!({
                "next": "Implement generic custom OAuth 2.0 provider with configurable endpoints",
                "size": "small",
                "reason": "One OAuth provider with configurable endpoints."
            }),
            _ => serde_json::json!({
                "next": key,
                "size": "small",
                "reason": "Standard sub-task size."
            }),
        }
    }

    fn mock_plan(&self, key: &str) -> serde_json::Value {
        match key {
            "auth-system" => serde_json::json!({
                "mode": "stage",
                "items": [
                    {
                        "key": "oauth-integration",
                        "intent": "Integrate OAuth 2.0 provider support including Google, GitHub, and custom OAuth flows. Verification: Test all provider flows end-to-end.",
                        "read_scope": ["src/auth/**"],
                        "write_scope": ["src/auth/oauth/**"],
                        "size": "large",
                        "reason": "OAuth is a prerequisite for session-based auth.",
                        "requires_prior_results": false
                    },
                    {
                        "key": "session-management",
                        "intent": "Implement session creation, validation, refresh, and expiration. Verification: Session lifecycle tests pass.",
                        "read_scope": ["src/auth/**"],
                        "write_scope": ["src/auth/session/**"],
                        "size": "medium",
                        "reason": "Sessions depend on OAuth tokens for initial creation.",
                        "requires_prior_results": true
                    },
                    {
                        "key": "token-storage",
                        "intent": "Implement secure encrypted token storage with rotation and revocation. Verification: Encryption and rotation tests pass.",
                        "read_scope": ["src/auth/**"],
                        "write_scope": ["src/auth/tokens/**"],
                        "size": "medium",
                        "reason": "Token storage is used by both OAuth and session subsystems.",
                        "requires_prior_results": true
                    },
                    {
                        "key": "user-registration",
                        "intent": "Implement user registration flow with email verification and profile creation. Verification: Registration end-to-end flow works.",
                        "read_scope": ["src/auth/**"],
                        "write_scope": ["src/auth/registration/**"],
                        "size": "medium",
                        "reason": "Registration can proceed in parallel with OAuth work.",
                        "requires_prior_results": false
                    },
                    {
                        "key": "password-management",
                        "intent": "Implement password hashing, reset flows, and policy enforcement. Verification: Password policy and reset tests pass.",
                        "read_scope": ["src/auth/**"],
                        "write_scope": ["src/auth/passwords/**"],
                        "size": "medium",
                        "reason": "Password management can proceed in parallel with other auth subsections.",
                        "requires_prior_results": false
                    }
                ]
            }),
            "oauth-integration" => serde_json::json!({
                "mode": "parallel",
                "items": [
                    {
                        "key": "google-oauth",
                        "intent": "Implement Google OAuth 2.0 provider with authorization code flow. Verification: Google OAuth flow works.",
                        "read_scope": ["src/auth/oauth/**"],
                        "write_scope": ["src/auth/oauth/google/**"],
                        "size": "small",
                        "reason": "Independent OAuth provider implementation.",
                        "requires_prior_results": false
                    },
                    {
                        "key": "github-oauth",
                        "intent": "Implement GitHub OAuth 2.0 provider with device authorization flow. Verification: GitHub OAuth flow works.",
                        "read_scope": ["src/auth/oauth/**"],
                        "write_scope": ["src/auth/oauth/github/**"],
                        "size": "small",
                        "reason": "Independent OAuth provider implementation.",
                        "requires_prior_results": false
                    },
                    {
                        "key": "custom-oauth",
                        "intent": "Implement generic custom OAuth 2.0 provider with configurable endpoints. Verification: Custom OAuth flow works.",
                        "read_scope": ["src/auth/oauth/**"],
                        "write_scope": ["src/auth/oauth/custom/**"],
                        "size": "small",
                        "reason": "Independent OAuth provider implementation.",
                        "requires_prior_results": false
                    }
                ]
            }),
            _ => serde_json::json!({
                "mode": "parallel",
                "items": []
            }),
        }
    }
}

#[tokio::test]
async fn eval_large_task_decomposition_plan_quality() {
    let worker = AuthSystemPlanner;
    // Use stop_after_route_depth(1) so the root plans, creates children,
    // then each child gets specified/planned at depth 1 before stopping.
    // This lets us observe multi-level plan output without full execution.
    let mut engine = Engine::new(Workspaces::default(), worker).with_stop_after_route_depth(1);

    // Create a root node for the massive authentication system task
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("auth-system".to_string()),
        intent: "Design and implement a complete authentication system with OAuth, session management, token storage, user registration, and password management".to_string(),
        size: WorkSize::XLarge,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git(["src/auth/**"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget { max_attempts: 1 },
        policy: NodePolicy::Explore,
        task_type: TaskType::Explore,
        plan: NodePlan::NeedsPlanning,
    });

    // Run with plan-only at depth 1 — root Specify→Plan→children Specify→Plan→stop
    let report = engine
        .run(root)
        .await
        .expect("plan-only run should succeed");

    // ═══════════════════════════════════════════════════════════════════
    //  Metrics Collection
    // ═══════════════════════════════════════════════════════════════════

    // ── Metric 1: Root plan group ─────────────────────────────────────

    let root_node = engine.node(root).expect("root node should exist");
    let plan_group = engine
        .node_plan_group(root)
        .expect("plan group method should work")
        .expect("root should have a Group plan");

    let child_ids = root_node.children.clone();
    let child_count = child_ids.len();

    // ── Metric 2: Collect child node details ──────────────────────────

    let mut child_keys: Vec<String> = Vec::new();
    let mut child_scopes: Vec<Vec<String>> = Vec::new();
    let mut child_sizes: Vec<WorkSize> = Vec::new();

    for child_id in &child_ids {
        let child = engine.node(*child_id).expect("child should exist");
        child_keys.push(child.key.0.clone());
        child_scopes.push(child.workspace.write_scope.clone());
        child_sizes.push(child.size);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Quality Metric 1: Child node count is reasonable
    // ═══════════════════════════════════════════════════════════════════
    // For an XLarge "authentication system", expect 4-7 top-level children.
    // Too flat (≤2) = under-split; too many (≥10) = over-split.
    assert!(
        (3..=8).contains(&child_count),
        "QUALITY FAIL: child count {child_count} outside [3, 8] for auth system"
    );
    println!("✅ METRIC 1: Child count = {child_count} (expected 3-8)");

    // ═══════════════════════════════════════════════════════════════════
    //  Quality Metric 2: Scope boundaries are clear and non-overlapping
    // ═══════════════════════════════════════════════════════════════════
    let scope_pairs: Vec<(String, Vec<String>)> = child_keys
        .iter()
        .cloned()
        .zip(child_scopes.iter().cloned())
        .collect();

    let mut overlap_count = 0;
    for i in 0..scope_pairs.len() {
        for j in (i + 1)..scope_pairs.len() {
            let (key_a, scopes_a) = &scope_pairs[i];
            let (key_b, scopes_b) = &scope_pairs[j];
            for sa in scopes_a {
                for sb in scopes_b {
                    if sa == sb {
                        overlap_count += 1;
                        println!("  scope overlap: {key_a} and {key_b} both write to {sa}");
                    }
                }
            }
        }
    }
    assert_eq!(
        overlap_count, 0,
        "QUALITY FAIL: {overlap_count} overlapping write scopes"
    );
    println!("✅ METRIC 2: No overlapping write scopes");

    // ═══════════════════════════════════════════════════════════════════
    //  Quality Metric 3: Grouping mode is correct for task structure
    // ═══════════════════════════════════════════════════════════════════
    // Root should be Stage because OAuth must precede session management
    assert_eq!(
        plan_group.mode,
        PlanGroupMode::Stage,
        "QUALITY FAIL: root should be Stage, got {:?}",
        plan_group.mode
    );
    println!(
        "✅ METRIC 3: Root group mode = {:?} (expected Stage)",
        plan_group.mode
    );

    // ═══════════════════════════════════════════════════════════════════
    //  Metric 4: Sub-plan validation (OAuth integration)
    // ═══════════════════════════════════════════════════════════════════
    // OAuth should have a sub-plan (it's size=large → NeedsPlanning)
    let oauth_child_id = child_ids
        .iter()
        .find_map(|id| {
            let node = engine.node(*id).ok()?;
            if node.key.0 == "oauth-integration" {
                Some(*id)
            } else {
                None
            }
        })
        .expect("oauth-integration child should exist");

    let oauth_node = engine.node(oauth_child_id).expect("oauth child");
    let oauth_group = engine
        .node_plan_group(oauth_child_id)
        .expect("oauth child")
        .expect("oauth-integration should have a Group plan");

    // OAuth providers are independent → should be Parallel
    assert_eq!(
        oauth_group.mode,
        PlanGroupMode::Parallel,
        "QUALITY FAIL: OAuth should be Parallel, got {:?}",
        oauth_group.mode
    );
    println!(
        "✅ METRIC 4: OAuth sub-group mode = {:?} (expected Parallel)",
        oauth_group.mode
    );

    // OAuth should have 3 provider children
    assert_eq!(
        oauth_node.children.len(),
        3,
        "QUALITY FAIL: OAuth should have 3 providers, got {}",
        oauth_node.children.len()
    );
    println!(
        "✅ METRIC 4b: OAuth has {} provider children (expected 3)",
        oauth_node.children.len()
    );

    // ═══════════════════════════════════════════════════════════════════
    //  Metric 5: Event log evidence of planning
    // ═══════════════════════════════════════════════════════════════════
    let plan_events: Vec<_> = engine
        .events()
        .iter()
        .filter(|e| e.operation == NodeOperation::Plan)
        .collect();
    assert!(!plan_events.is_empty(), "QUALITY FAIL: No Plan events");
    println!("✅ METRIC 5: {} Plan event(s) recorded", plan_events.len());

    // ═══════════════════════════════════════════════════════════════════
    //  Metric 6: Confirmation that plan-only mode worked
    // ═══════════════════════════════════════════════════════════════════
    // Since stop_after_route_depth(1) stops after child Plan at depth 1,
    // no grandchildren (e.g., google-oauth) are resolved, and no
    // Execute operations occur.
    let execute_events: Vec<_> = engine
        .events()
        .iter()
        .filter(|e| e.operation == NodeOperation::Execute)
        .collect();
    assert!(
        execute_events.is_empty(),
        "QUALITY FAIL: plan-only mode should have 0 Execute events, got {}",
        execute_events.len()
    );
    println!("✅ METRIC 6: No Execute events — plan-only confirmed");

    // The root is "Pruned" because the first child stopped early
    // (by design of the plan-only mode). This confirms no full resolution.
    println!("   Root status: {:?}", report.status);
    println!("   OAuth child status: {:?}", oauth_node.status);

    // ═══════════════════════════════════════════════════════════════════
    //  Summary
    // ═══════════════════════════════════════════════════════════════════
    println!("\n=== Large Task Decomposition Plan Quality Report ===");
    println!("Root key: auth-system");
    println!("Root status: {:?}", report.status);
    println!("Group mode: {:?}", plan_group.mode);
    println!("Child count: {}", child_count);
    println!("Child keys: {:?}", child_keys);
    println!("Child sizes: {:?}", child_sizes);
    println!("OAuth sub-group mode: {:?}", oauth_group.mode);
    println!("OAuth child count: {}", oauth_node.children.len());
    println!("Plan events: {}", plan_events.len());
    println!("All quality metrics: PASS ✅");
}
