use serde_json::Value;
use siko::*;

mod support;
use support::{RecordingAgentRunScheduler, scoped_git_leaf};

#[tokio::test]
async fn engine_harness_sends_structured_context_packet_to_agent_loop() {
    let worker = RecordingAgentRunScheduler::default();
    let recorder = worker.clone();
    let mut engine = Engine::new(MemoryWorkspace::default(), worker);
    let root = engine.insert_root(NodeTemplate::memory_leaf("polish", "polished text"));

    engine.run(root).await.unwrap();

    let requests = recorder.requests();
    let execute = requests
        .iter()
        .find(|request| request.terminal_tool_set == vec!["submit_work"])
        .expect("execute request");
    assert_eq!(execute.protocol_version, 1);
    assert_eq!(execute.runtime_profile, AgentRuntimeProfile::General);
    assert!(prompt_contains(&execute.prompt, "atomic execution pass"));
    assert!(prompt_contains(&execute.prompt, "submit_work"));
    assert_eq!(execute.terminal_tool_set, vec!["submit_work"]);
    assert_eq!(
        execute
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["submit_work"]
    );

    let packet = parse_context_packet(execute);
    assert_eq!(packet["kind"], "engine_operation");
    assert_eq!(packet["operation"], "Execute");
    assert_eq!(packet["governance"]["layer"], "Execute");
    assert_eq!(packet["governance"]["hard_gates"][0]["id"], "G-ARCH-ESCAPE");
    assert!(
        packet["governance"]["hard_gates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|gate| gate["id"] == "G-SCOPE-WIDEN")
    );
    assert_eq!(packet["node"]["intent"], "polished text");
    assert_eq!(packet["node"]["workspace"]["provider"], "Memory");
    assert_eq!(packet["node"]["allow_write"], false);
    assert!(packet["candidate"].is_null());
    assert_eq!(
        packet["workspace_surface"]["conflicts"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(packet["child_artifacts"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn specify_uses_general_profile_even_for_git_workspace() {
    let worker = RecordingAgentRunScheduler::default();
    let recorder = worker.clone();
    let mut engine = Engine::new(Workspaces::default(), worker);
    let root = engine.insert_root(NodeTemplate {

        policy: NodePolicy::Explore,
        key: ProblemKey("git-specify".to_string()),
        intent: "Audit the repository for stale design surfaces.".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git(["design/**/*.md"]),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let _ = engine.run(root).await;

    let requests = recorder.requests();
    let specify = requests
        .iter()
        .find(|request| request.terminal_tool_set == vec!["submit_specification"])
        .expect("specify request");
    assert_eq!(specify.runtime_profile, AgentRuntimeProfile::General);

    let packet = parse_context_packet(specify);
    assert_eq!(packet["node"]["workspace"]["provider"], "GitFileSystem");
    assert!(
        packet["node"]["workspace"]["git"]
            .get("repo_root")
            .is_none()
    );
    assert!(
        packet["node"]["workspace"]["git"]
            .get("worktree_root")
            .is_none()
    );
}

#[test]
fn verify_with_file_workspace_surface_uses_code_profile() {
    let context = AgentOperationContext {
        node: ProblemNode {

            policy: NodePolicy::Explore,
            workspace: WorkspaceRequirement::read_only_files(),
            ..problem_node(NodePlan::Execute)
        },
        operation: NodeOperation::Verify,
        candidate: Some(Artifact {
            id: 1,
            node_id: 1,
            content_kind: ArtifactContentKind::Text,
            text: "candidate".to_string(),
            workspace_change: None,
            children: Vec::new(),
        }),
        child_artifacts: Vec::new(),
        workspace_surface: Some(WorkspaceSurface {
            snapshot_id: 1,
            provider: WorkspaceProvider::FileSystem,
            resources: Vec::new(),
            changed_paths: Vec::new(),
            conflicts: Vec::new(),
            git: None,
        }),
    };

    let request = OperationHarness::new(context).build_agent_run();

    assert_eq!(request.runtime_profile, AgentRuntimeProfile::Code);
}

#[tokio::test]
async fn engine_harness_includes_candidate_child_and_workspace_surface_context() {
    let worker = RecordingAgentRunScheduler::default();
    let recorder = worker.clone();
    let mut engine = Engine::new(Workspaces::default(), worker);
    let child_a = scoped_git_leaf("a", "patch a", "packages/client/src/api.ts");
    let child_b = scoped_git_leaf("b", "patch b", "packages/client/src/api.ts");
    let root = engine.insert_root(NodeTemplate {

        policy: NodePolicy::Explore,
        key: ProblemKey("combine".to_string()),
        intent: "combined patch".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![child_a, child_b],
        }),
    });

    engine.run(root).await.unwrap();

    let requests = recorder.requests();
    let combine = requests
        .iter()
        .find(|request| request.terminal_tool_set == vec!["submit_combination"])
        .expect("combine request");
    assert_eq!(combine.runtime_profile, AgentRuntimeProfile::Code);
    let packet = parse_context_packet(combine);
    assert_eq!(packet["operation"], "Combine");
    let child_artifacts = packet["child_artifacts"].as_array().unwrap();
    assert_eq!(child_artifacts.len(), 2);
    for artifact in child_artifacts {
        assert!(artifact.get("changed_paths").is_none());
        assert!(artifact.get("side_effects").is_none());
    }
    assert!(packet["workspace_surface"].get("changed_paths").is_none());
    assert!(
        packet["workspace_surface"]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn engine_harness_hides_workspace_change_facts_except_conflicts() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![NodeTemplate::memory_leaf("child", "child output")],
        })),
        operation: NodeOperation::Combine,
        candidate: None,
        child_artifacts: vec![Artifact {
            id: 7,
            node_id: 2,
            content_kind: ArtifactContentKind::Text,
            text: "child artifact".to_string(),
            workspace_change: Some(WorkspaceChange {
                provider: WorkspaceProvider::GitFileSystem,
                resources: Vec::new(),
                resource_ids: Vec::new(),
                changed_paths: vec!["src/secret.rs".to_string()],
                side_effects: vec!["git_commit:abc123".to_string()],
                conflicts: Vec::new(),
                git: None,
            }),
            children: Vec::new(),
        }],
        workspace_surface: Some(WorkspaceSurface {
            snapshot_id: 1,
            provider: WorkspaceProvider::GitFileSystem,
            resources: Vec::new(),
            changed_paths: vec!["src/secret.rs".to_string()],
            conflicts: vec!["src/conflict.rs".to_string()],
            git: None,
        }),
    };

    let request = OperationHarness::new(context).build_agent_run();
    let packet = parse_context_packet(&request);
    let artifact = &packet["child_artifacts"][0];

    assert_eq!(artifact["content_kind"], "Text");
    assert_eq!(artifact["text"], "child artifact");
    assert!(artifact.get("changed_paths").is_none());
    assert!(artifact.get("side_effects").is_none());
    assert!(packet["workspace_surface"].get("changed_paths").is_none());
    assert_eq!(
        packet["workspace_surface"]["conflicts"],
        serde_json::json!(["src/conflict.rs"])
    );
}

#[test]
fn engine_harness_builds_operation_specific_prompt_tools_and_config() {
    let cases = [
        (
            NodeOperation::Specify,
            "submit_specification",
            "Node To Specify",
            "repository audit across several top-level subsystems",
            "next",
        ),
        (
            NodeOperation::Plan,
            "submit_plan_group",
            "Leverage Parent Context",
            "parent Operation Context already names independent evidence surfaces",
            "items",
        ),
        (
            NodeOperation::Execute,
            "submit_work",
            "Workspace Rules",
            "Solve node",
            "output",
        ),
        (
            NodeOperation::Combine,
            "submit_combination",
            "Workspace Integration",
            "conflicts are present",
            "output",
        ),
        (
            NodeOperation::Verify,
            "submit_verdict",
            "Verdict Standard",
            "same node can repair it",
            "verdict",
        ),
    ];

    for (operation, terminal_tool, expected_section, prompt_fragment, schema_field) in cases {
        let context = AgentOperationContext {
            node: problem_node(plan_for_operation(operation)),
            operation,
            candidate: None,
            child_artifacts: Vec::new(),
            workspace_surface: None,
        };
        let expected_tools = vec![terminal_tool];
        let harness = OperationHarness::new(context);
        let request = harness.build_agent_run();

        assert_eq!(request.protocol_version, 1);
        assert_eq!(request.objective, format!("{operation:?} node 1"));
        assert!(request.prompt.len() >= 5);
        assert!(prompt_section_exists(&request.prompt, "Role"));
        assert!(prompt_section_exists(&request.prompt, "Operation Context"));
        assert!(prompt_section_exists(
            &request.prompt,
            "Governance Boundary"
        ));
        assert!(prompt_section_exists(&request.prompt, expected_section));
        assert!(prompt_section_exists(&request.prompt, "Completion"));
        assert!(prompt_contains(&request.prompt, prompt_fragment));
        assert!(prompt_contains(&request.prompt, "authority boundary"));
        assert!(prompt_contains(
            &request.prompt,
            "\"kind\": \"engine_operation\""
        ));
        assert!(!prompt_contains(&request.prompt, "read_operation_context"));
        assert!(prompt_contains(&request.prompt, terminal_tool));
        if operation == NodeOperation::Specify {
            assert!(prompt_contains(
                &request.prompt,
                "smallest safe size by coordination cost"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "without dropping stated responsibilities"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "intent-preserving rewrite"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "Do not make the task more specific than the raw intent"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "Size controls execution shape"
            ));
            assert!(prompt_contains(&request.prompt, "coherent change package"));
            assert!(prompt_contains(
                &request.prompt,
                "Do not count surfaces mechanically"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "independent evidence surfaces"
            ));
            assert!(prompt_contains(&request.prompt, "cross-surface comparison"));
            assert!(prompt_contains(&request.prompt, "one verification loop"));
            assert!(prompt_contains(&request.prompt, "missing user choice"));
            assert!(prompt_contains(
                &request.prompt,
                "tiny, small, medium, large, x_large"
            ));
            assert!(prompt_contains(&request.prompt, "tiny is a direct answer"));
            assert!(prompt_contains(&request.prompt, "x_large"));
            assert!(prompt_contains(
                &request.prompt,
                "information gathering is just another possible next work"
            ));
            assert!(!prompt_contains(&request.prompt, "missing_info"));
        }
        if operation == NodeOperation::Plan {
            assert!(prompt_contains(&request.prompt, "G-PARALLEL-DEPENDENCY"));
            assert!(prompt_contains(
                &request.prompt,
                "size and reason when useful"
            ));
            assert!(prompt_contains(&request.prompt, "ordered phases are stage"));
            assert!(prompt_contains(
                &request.prompt,
                "mutually independent peer surfaces are parallel"
            ));
            assert!(prompt_contains(&request.prompt, "Submit at least one item"));
            assert!(prompt_contains(&request.prompt, "requires_prior_results"));
            assert!(prompt_contains(
                &request.prompt,
                "parent Combine pass performs that integration"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "natural next-level subproblem"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "Keep child intents concise and outcome-level"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "Recursive planning is allowed"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "That second split should be decided by the child Specify/Plan pass"
            ));
        }
        if operation == NodeOperation::Execute {
            assert!(prompt_contains(&request.prompt, "no readable surface"));
            assert!(prompt_contains(&request.prompt, "read_scope controls"));
            assert!(prompt_contains(
                &request.prompt,
                "allow_write controls mutation only"
            ));
            assert!(prompt_section_exists(&request.prompt, "External Evidence"));
            assert!(prompt_contains(
                &request.prompt,
                "external URLs, repositories, docs"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "instead of reconstructing details from model memory"
            ));
            assert!(prompt_contains(&request.prompt, "Self Contained Work"));
            assert!(prompt_contains(
                &request.prompt,
                "Empty read_scope is not a blocker"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "Keep unknown details at the appropriate abstraction level"
            ));
        }
        if operation == NodeOperation::Combine {
            assert!(prompt_contains(&request.prompt, "G-UNSUPPORTED-FACT"));
            assert!(prompt_contains(
                &request.prompt,
                "parent execution pass resuming"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "not as a new independent role"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "do not introduce new factual claims"
            ));
            assert!(prompt_contains(&request.prompt, "complete available input"));
            assert!(prompt_contains(
                &request.prompt,
                "do not defer by saying you will inspect files"
            ));
            assert!(prompt_contains(&request.prompt, "names the conflict path"));
        }
        if operation == NodeOperation::Verify {
            assert!(prompt_contains(
                &request.prompt,
                "G-PASS-WITH-HARD-VIOLATION"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "exactly one of: accept, reject, need_information"
            ));
            assert!(prompt_contains(&request.prompt, "return verdict=accept"));
            assert!(prompt_contains(
                &request.prompt,
                "Empty read_scope is not missing information"
            ));
            assert!(prompt_section_exists(
                &request.prompt,
                "External Evidence Gate"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "only reconstructed from training knowledge"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "Verify against the node intent and available context"
            ));
        }
        assert_eq!(request.terminal_tool_set, vec![terminal_tool]);
        assert_eq!(harness.terminal_tool_names(), vec![terminal_tool]);
        if operation == NodeOperation::Plan {
            assert_eq!(serde_json::to_value(&request).unwrap()["effort"], "max");
        } else {
            assert!(serde_json::to_value(&request).unwrap()["effort"].is_null());
        }
        assert_eq!(
            request
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            expected_tools
        );

        let terminal_spec = request
            .tools
            .iter()
            .find(|tool| tool.name == terminal_tool)
            .expect("terminal tool spec");
        if schema_field.is_empty() {
            assert!(
                schema_properties_are_empty(&terminal_spec.input_schema),
                "expected {operation:?} schema to be empty: {}",
                terminal_spec.input_schema
            );
        } else {
            assert!(
                schema_has_property(&terminal_spec.input_schema, schema_field),
                "expected {operation:?} schema to contain {schema_field}: {}",
                terminal_spec.input_schema
            );
        }
        if operation == NodeOperation::Specify {
            assert!(schema_has_property(&terminal_spec.input_schema, "next"));
            assert!(schema_has_property(&terminal_spec.input_schema, "size"));
            assert!(schema_has_property(&terminal_spec.input_schema, "reason"));
            assert!(!schema_has_property(
                &terminal_spec.input_schema,
                "missing_info"
            ));
            assert!(!schema_has_property(&terminal_spec.input_schema, "route"));
        }
        if operation == NodeOperation::Plan {
            assert_eq!(
                schema_property(&terminal_spec.input_schema, "items")
                    .and_then(|items| items.get("minItems")),
                Some(&Value::from(1))
            );
            assert!(
                terminal_spec
                    .input_schema
                    .to_string()
                    .contains("requires_prior_results")
            );
            assert!(
                terminal_spec
                    .input_schema
                    .to_string()
                    .contains("read_scope")
            );
            assert!(
                terminal_spec
                    .input_schema
                    .to_string()
                    .contains("write_scope")
            );
        }
    }
}

#[test]
#[should_panic(expected = "Commit is an engine-only event")]
fn engine_harness_does_not_build_agent_run_for_commit_event() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Commit,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };

    let _ = OperationHarness::new(context).build_agent_run();
}

#[test]
fn engine_harness_decodes_specification_scope_assessment() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Specify,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let result = OperationHarness::new(context)
        .decode_result(AgentRunResponse {
            report: "specified".to_string(),
            tool_calls: Vec::new(),
            terminal_call: Some(AgentToolCall {
                name: "submit_specification".to_string(),
                arguments: serde_json::json!({
                    "next": "Implement the repo-local task board status formatter.",
                    "size": "medium",
                    "reason": "One coherent feature spanning several related files."
                }),
            }),
            usage: None,
            events: Vec::new(),
        })
        .expect("specification size scope_assessment should decode");

    let NodeOperationOutput::Specified { scope_assessment } = result.output else {
        panic!("expected specified output");
    };
    assert_eq!(
        scope_assessment.next,
        "Implement the repo-local task board status formatter."
    );
    assert_eq!(scope_assessment.size, WorkSize::Medium);
    assert_eq!(
        scope_assessment.reason,
        "One coherent feature spanning several related files."
    );
}

#[test]
fn engine_harness_decodes_information_gathering_as_next_work() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Specify,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let result = OperationHarness::new(context)
        .decode_result(AgentRunResponse {
            report: "specified".to_string(),
            tool_calls: Vec::new(),
            terminal_call: Some(AgentToolCall {
                name: "submit_specification".to_string(),
                arguments: serde_json::json!({
                    "next": "Identify which provider and model are selected in the current runtime config.",
                    "size": "tiny",
                    "reason": "The evidence-gathering work is tiny even though the broader setup depends on it."
                }),
            }),
            usage: None,
            events: Vec::new(),
        })
        .expect("information gathering should decode as normal next work");

    let NodeOperationOutput::Specified { scope_assessment } = result.output else {
        panic!("expected specified output");
    };
    assert_eq!(
        scope_assessment.next,
        "Identify which provider and model are selected in the current runtime config."
    );
    assert_eq!(scope_assessment.size, WorkSize::Tiny);
}

#[tokio::test]
async fn engine_harness_decodes_agent_friendly_plan_items() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::NeedsPlanning),
        operation: NodeOperation::Plan,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let harness = OperationHarness::new(context);

    let result = harness
        .decode_result(AgentRunResponse {
            report: "planned".to_string(),
            tool_calls: Vec::new(),
            terminal_call: Some(AgentToolCall {
                name: "submit_plan_group".to_string(),
                arguments: serde_json::json!({
                    "mode": "stage",
                    "items": [
                        {
                            "title": "Lock developer preview scope",
                            "description": "Write the smallest useful acceptance checklist.",
                            "verification": "Checklist has concrete pass/fail commands.",
                            "read_scope": ["design/**/*.md"],
                            "size": "medium",
                            "reason": "One coherent child slice with focused tests.",
                            "requires_prior_results": false
                        }
                    ]
                }),
            }),
            usage: None,
            events: Vec::new(),
        })
        .expect("agent-friendly plan item should decode");

    let NodeOperationOutput::Planned { group } = result.output else {
        panic!("expected planned output");
    };
    assert_eq!(group.mode, PlanGroupMode::Stage);
    assert_eq!(group.items.len(), 1);
    assert_eq!(
        group.items[0].key,
        ProblemKey("lock-developer-preview-scope".to_string())
    );
    assert!(
        group.items[0]
            .intent
            .contains("Write the smallest useful acceptance checklist.")
    );
    assert!(
        group.items[0]
            .intent
            .contains("Checklist has concrete pass/fail commands.")
    );
    assert_eq!(group.items[0].plan, NodePlan::Execute);
    assert_eq!(group.items[0].workspace.read_scope, vec!["design/**/*.md"]);
    assert!(group.items[0].workspace.write_scope.is_empty());
    assert_eq!(group.items[0].size, WorkSize::Medium);
    assert_eq!(
        group.items[0].scope_assessment.as_ref().unwrap().next,
        group.items[0].intent
    );
    assert_eq!(
        group.items[0].scope_assessment.as_ref().unwrap().reason,
        "One coherent child slice with focused tests."
    );
}

#[tokio::test]
async fn engine_harness_rejects_dependent_parallel_plan_items() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::NeedsPlanning),
        operation: NodeOperation::Plan,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let harness = OperationHarness::new(context);

    let result = harness
        .decode_result(AgentRunResponse {
            report: "planned".to_string(),
            tool_calls: Vec::new(),
            terminal_call: Some(AgentToolCall {
                name: "submit_plan_group".to_string(),
                arguments: serde_json::json!({
                    "mode": "parallel",
                    "items": [
                        {
                            "key": "synthesis",
                            "intent": "Synthesize sibling findings into the final report.",
                            "requires_prior_results": true
                        }
                    ]
                }),
            }),
            usage: None,
            events: Vec::new(),
        })
        .expect("dependent parallel plan should decode as invalid plan");

    let NodeOperationOutput::InvalidPlan { gate, reason } = result.output else {
        panic!("expected invalid plan output");
    };
    assert_eq!(gate, Some(GovernanceGate::ParallelDependency));
    assert!(reason.contains("parallel plan items must be mutually independent"));
}

#[test]
fn node_operations_report_governance_layer_and_active_gates() {
    assert_eq!(
        NodeOperation::Specify.governance_layer(),
        Some(GovernanceLayer::Plan)
    );
    assert_eq!(
        NodeOperation::Plan.governance_layer(),
        Some(GovernanceLayer::Plan)
    );
    assert_eq!(
        NodeOperation::Execute.governance_layer(),
        Some(GovernanceLayer::Execute)
    );
    assert_eq!(
        NodeOperation::Combine.governance_layer(),
        Some(GovernanceLayer::Execute)
    );
    assert_eq!(
        NodeOperation::Verify.governance_layer(),
        Some(GovernanceLayer::Verify)
    );
    assert_eq!(NodeOperation::Commit.governance_layer(), None);
    assert!(
        NodeOperation::Plan
            .active_hard_gates()
            .contains(&GovernanceGate::ParallelDependency)
    );
    assert!(
        NodeOperation::Verify
            .active_hard_gates()
            .contains(&GovernanceGate::PassWithHardViolation)
    );
}

#[test]
fn submit_work_schema_does_not_accept_workspace_change_facts() {
    let harness = OperationHarness::new(AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Execute,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    });
    let request = harness.build_agent_run();
    let submit_work = request
        .tools
        .iter()
        .find(|tool| tool.name == "submit_work")
        .expect("submit_work tool spec");

    assert!(schema_has_property(&submit_work.input_schema, "output"));
    assert!(!schema_has_property(
        &submit_work.input_schema,
        "side_effects"
    ));
    assert_eq!(
        submit_work.input_schema.get("additionalProperties"),
        Some(&Value::Bool(false))
    );
}

#[test]
fn assistant_harness_builds_assistant_turn_prompt_tools_and_config() {
    let harness = AssistantHarness::new(AssistantContext {
        current_message: "status task_1".to_string(),
        conversation: vec![AssistantConversationMessage {
            role: AssistantConversationRole::User,
            content: "create task".to_string(),
            task_id: Some("task_1".to_string()),
        }],
        task_board: Some(AssistantTaskBoardContext {
            active_task: Some("task_1".to_string()),
            tasks: vec![AssistantContextTask {
                id: "task_1".to_string(),
                title: "Analyze repo".to_string(),
                status: AssistantTaskStatus::Running,
            }],
        }),
    });
    let expected_tools = vec![
        "query_messages",
        "list_tasks",
        "inspect_task",
        "create_task",
        "cancel_task",
        "finish_turn",
    ];
    let request = harness.build_agent_run();

    assert_eq!(request.protocol_version, 1);
    assert_eq!(request.objective, "Assistant turn");
    assert_eq!(request.prompt.len(), 8);
    assert!(prompt_section_exists(&request.prompt, "Role"));
    assert!(prompt_section_exists(&request.prompt, "Operating Model"));
    assert!(prompt_section_exists(&request.prompt, "Context"));
    assert!(prompt_section_exists(&request.prompt, "Task Board"));
    assert!(prompt_section_exists(
        &request.prompt,
        "Dogfood Development"
    ));
    assert!(prompt_section_exists(
        &request.prompt,
        "Recent Conversation"
    ));
    assert!(prompt_section_exists(&request.prompt, "Latest Message"));
    assert!(prompt_section_exists(&request.prompt, "Completion"));
    assert!(prompt_contains(&request.prompt, "assistant-level operator"));
    assert!(prompt_contains(
        &request.prompt,
        "Sikong's self-development loop"
    ));
    assert!(prompt_contains(&request.prompt, "query_messages"));
    assert!(prompt_contains(&request.prompt, "finish_turn"));
    assert_eq!(request.terminal_tool_set, vec!["finish_turn"]);
    assert_eq!(
        request
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        expected_tools
    );

    let terminal_spec = request
        .tools
        .iter()
        .find(|tool| tool.name == "finish_turn")
        .expect("assistant terminal tool");
    assert!(schema_has_property(&terminal_spec.input_schema, "response"));

    let packet = parse_context_packet(&request);
    assert_eq!(packet["kind"], "assistant_turn");
    assert_eq!(packet["current_message"], "status task_1");
    assert_eq!(packet["conversation"]["messages"][0]["task_id"], "task_1");
    assert_eq!(
        packet["conversation"]["messages"][0]["content"],
        "create task"
    );
    assert_eq!(packet["task_board"]["active_task"], "task_1");
    assert_eq!(packet["task_board"]["tasks"][0]["id"], "task_1");
    assert_eq!(packet["task_board"]["tasks"][0]["status"], "Running");
    assert_eq!(packet["dogfood"]["mode"], "sikong_self_development");
    assert!(
        packet["dogfood"]["task_request_shape"]
            .as_array()
            .unwrap()
            .contains(&Value::String("acceptance evidence".to_string()))
    );
}

#[test]
fn assistant_harness_omits_task_board_tools_when_disabled() {
    let harness = AssistantHarness::new(AssistantContext::message_only(
        "reply directly without creating a task",
    ));
    let request = harness.build_agent_run();
    let tool_names = request
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();

    assert_eq!(tool_names, vec!["query_messages", "finish_turn"]);
    assert!(!prompt_section_exists(&request.prompt, "Task Board"));
    assert!(!prompt_section_exists(
        &request.prompt,
        "Dogfood Development"
    ));
    assert!(!prompt_section_exists(
        &request.prompt,
        "Recent Conversation"
    ));

    let packet = parse_context_packet(&request);
    assert_eq!(packet["kind"], "assistant_turn");
    assert!(packet.get("task_board").is_none());
    assert!(packet.get("dogfood").is_none());
    assert_eq!(
        packet["conversation"]["messages"].as_array().unwrap().len(),
        0
    );
}

#[tokio::test]
async fn engine_harness_reports_run_decode_error_for_wrong_terminal_tool() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Execute,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let harness = OperationHarness::new(context);

    let result = harness.decode_result(AgentRunResponse {
        report: "done".to_string(),
        tool_calls: Vec::new(),
        terminal_call: Some(AgentToolCall {
            name: "submit_verdict".to_string(),
            arguments: serde_json::json!({}),
        }),
        usage: None,
        events: Vec::new(),
    });

    let error = result.expect_err("wrong terminal tool should fail closed");
    assert_eq!(error.terminal_tool.as_deref(), Some("submit_verdict"));
    assert!(error.message.contains("run decode failed"));
}

#[tokio::test]
async fn engine_harness_reports_run_decode_error_for_malformed_terminal_payload() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Execute,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let harness = OperationHarness::new(context);

    let result = harness.decode_result(AgentRunResponse {
        report: "done".to_string(),
        tool_calls: Vec::new(),
        terminal_call: Some(AgentToolCall {
            name: "submit_work".to_string(),
            arguments: serde_json::json!({ "output": 42 }),
        }),
        usage: None,
        events: Vec::new(),
    });

    let error = result.expect_err("malformed terminal payload should fail closed");
    assert_eq!(error.terminal_tool.as_deref(), Some("submit_work"));
    assert!(error.message.contains("payload is invalid"));
}

#[tokio::test]
async fn engine_harness_rejects_agent_reported_workspace_facts_in_work_payload() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Execute,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let harness = OperationHarness::new(context);

    let result = harness.decode_result(AgentRunResponse {
        report: "done".to_string(),
        tool_calls: Vec::new(),
        terminal_call: Some(AgentToolCall {
            name: "submit_work".to_string(),
            arguments: serde_json::json!({
                "output": "partial",
                "side_effects": ["agent-reported-write"],
            }),
        }),
        usage: None,
        events: Vec::new(),
    });

    let error = result.expect_err("agent-reported workspace facts should fail closed");
    assert_eq!(error.terminal_tool.as_deref(), Some("submit_work"));
    assert!(error.message.contains("unknown field"));
}

#[tokio::test]
async fn engine_harness_maps_open_verifier_failure_classes() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Execute),
        operation: NodeOperation::Verify,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_surface: None,
    };
    let harness = OperationHarness::new(context);

    let result = harness
        .decode_result(AgentRunResponse {
            report: "verified".to_string(),
            tool_calls: Vec::new(),
            terminal_call: Some(AgentToolCall {
                name: "submit_verdict".to_string(),
                arguments: serde_json::json!({
                    "verdict": "reject",
                    "reason": "assessment is incomplete",
                    "failure_class": "incomplete_assessment"
                }),
            }),
            usage: None,
            events: Vec::new(),
        })
        .expect("open verifier class should decode");

    assert_eq!(
        result.output,
        NodeOperationOutput::Verified {
            verdict: VerificationVerdict::Reject {
                failure_class: FailureClass::IncompleteOutput,
                reason: "assessment is incomplete".to_string(),
            }
        }
    );
}

fn parse_context_packet(request: &AgentRunRequest) -> Value {
    request.input.clone()
}

fn prompt_contains(prompt: &[AgentPromptSection], needle: &str) -> bool {
    prompt
        .iter()
        .any(|section| section.title.contains(needle) || section.content.contains(needle))
}

fn prompt_section_exists(prompt: &[AgentPromptSection], title: &str) -> bool {
    prompt.iter().any(|section| section.title == title)
}

fn schema_has_property(schema: &Value, property: &str) -> bool {
    schema_property(schema, property).is_some()
}

fn schema_property<'a>(schema: &'a Value, property: &str) -> Option<&'a Value> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| properties.get(property))
}

fn schema_properties_are_empty(schema: &Value) -> bool {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .is_none_or(|properties| properties.is_empty())
}

fn plan_for_operation(operation: NodeOperation) -> NodePlan {
    match operation {
        NodeOperation::Specify | NodeOperation::Execute | NodeOperation::Verify => {
            NodePlan::Execute
        }
        NodeOperation::Commit => NodePlan::Execute,
        NodeOperation::Plan | NodeOperation::Combine => NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![NodeTemplate::memory_leaf("child", "child output")],
        }),
    }
}

fn problem_node(plan: NodePlan) -> ProblemNode {

    ProblemNode {

        policy: NodePolicy::Explore,
        id: 1,
        key: ProblemKey("node".to_string()),
        parent: None,
        intent: "node".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        children: Vec::new(),
        status: NodeStatus::New,
        plan,
        candidate: None,
        accepted_artifact: None,
        execution_attempts: 0,
        verification_attempts: 0,
    }
}
