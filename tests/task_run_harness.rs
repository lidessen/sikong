use serde_json::Value;
use siko::*;

mod support;
use support::RecordingAgentRunScheduler;

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
    assert!(prompt_contains(&execute.prompt, "atomic execution pass"));
    assert!(prompt_contains(&execute.prompt, "submit_work"));
    assert_eq!(execute.terminal_tool_set, vec!["submit_work"]);
    assert_eq!(
        execute
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["read_operation_context", "submit_work"]
    );

    let packet = parse_context_packet(execute);
    assert_eq!(packet["kind"], "engine_operation");
    assert_eq!(packet["operation"], "Execute");
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
async fn engine_harness_includes_candidate_child_and_workspace_surface_context() {
    let worker = RecordingAgentRunScheduler::default();
    let recorder = worker.clone();
    let mut engine = Engine::new(Workspaces::default(), worker);
    let child_a = scoped_git_leaf("a", "patch a", "packages/client/src/api.ts");
    let child_b = scoped_git_leaf("b", "patch b", "packages/client/src/api.ts");
    let root = engine.insert_root(NodeTemplate {
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
            "Normalize node",
            "size",
        ),
        (
            NodeOperation::Acquire,
            "submit_evidence",
            "Evidence Standard",
            "missing information",
            "evidence",
        ),
        (
            NodeOperation::Plan,
            "submit_plan_group",
            "Planning Lens",
            "main contradiction",
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
        let expected_tools = vec!["read_operation_context", terminal_tool];
        let harness = OperationHarness::new(context);
        let request = harness.build_agent_run();

        assert_eq!(request.protocol_version, 1);
        assert_eq!(request.objective, format!("{operation:?} node 1"));
        assert!(request.prompt.len() >= 5);
        assert!(prompt_section_exists(&request.prompt, "Role"));
        assert!(prompt_section_exists(&request.prompt, "Context Access"));
        assert!(prompt_section_exists(&request.prompt, expected_section));
        assert!(prompt_section_exists(&request.prompt, "Completion"));
        assert!(prompt_contains(&request.prompt, prompt_fragment));
        assert!(prompt_contains(&request.prompt, "read_operation_context"));
        assert!(prompt_contains(&request.prompt, terminal_tool));
        if operation == NodeOperation::Acquire {
            assert!(prompt_contains(
                &request.prompt,
                "engine can re-run Specify"
            ));
            assert!(!prompt_contains(&request.prompt, "next_plan.kind"));
        }
        if operation == NodeOperation::Specify {
            assert!(prompt_contains(
                &request.prompt,
                "smallest safe size by cognitive load"
            ));
            assert!(prompt_contains(&request.prompt, "tiny feels like"));
            assert!(prompt_contains(&request.prompt, "xlarge"));
            assert!(prompt_contains(&request.prompt, "Scope Examples"));
            assert!(prompt_contains(&request.prompt, "Use these as analogies"));
            assert!(prompt_contains(
                &request.prompt,
                "Ask for missing information only"
            ));
            assert!(prompt_contains(
                &request.prompt,
                "submit missing_info as null"
            ));
        }
        if operation == NodeOperation::Plan {
            assert!(prompt_contains(
                &request.prompt,
                "size, shape, reference_match, and scope_signals"
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
            assert!(schema_has_property(&terminal_spec.input_schema, "size"));
            assert!(schema_has_property(
                &terminal_spec.input_schema,
                "reference_match"
            ));
            assert!(schema_has_property(
                &terminal_spec.input_schema,
                "scope_signals"
            ));
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
                    "size": "medium",
                    "shape": "phased",
                    "reference_match": "One coherent feature spanning several related files.",
                    "scope_signals": ["one main acceptance target", "focused tests"],
                    "missing_info": null
                }),
            }),
            usage: None,
        })
        .expect("specification size scope_assessment should decode");

    let NodeOperationOutput::Specified {
        scope_assessment,
        missing_info,
    } = result.output
    else {
        panic!("expected specified output");
    };
    assert_eq!(missing_info, None);
    assert_eq!(scope_assessment.size, WorkSize::Medium);
    assert_eq!(scope_assessment.shape, WorkShape::Phased);
    assert_eq!(
        scope_assessment.reference_match,
        "One coherent feature spanning several related files."
    );
    assert_eq!(
        scope_assessment.scope_signals,
        vec!["one main acceptance target", "focused tests"]
    );
}

#[test]
fn engine_harness_treats_string_null_missing_info_as_absent() {
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
                    "size": "tiny",
                    "shape": "atomic",
                    "reference_match": "Single self-contained artifact.",
                    "scope_signals": ["no external fact required"],
                    "missing_info": "null"
                }),
            }),
            usage: None,
        })
        .expect("string null should not become a missing-info plan");

    let NodeOperationOutput::Specified { missing_info, .. } = result.output else {
        panic!("expected specified output");
    };
    assert_eq!(missing_info, None);
}

#[tokio::test]
async fn engine_harness_decodes_agent_friendly_plan_items() {
    let context = AgentOperationContext {
        node: problem_node(NodePlan::Split),
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
                            "size": "medium",
                            "shape": "research/specify",
                            "reference_match": "One coherent child slice with focused tests.",
                            "scope_signals": "one child item"
                        }
                    ]
                }),
            }),
            usage: None,
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
    assert_eq!(group.items[0].size, WorkSize::Medium);
    assert_eq!(
        group.items[0]
            .scope_assessment
            .as_ref()
            .unwrap()
            .reference_match,
        "One coherent child slice with focused tests."
    );
    assert_eq!(
        group.items[0].scope_assessment.as_ref().unwrap().shape,
        WorkShape::Unknown
    );
    assert_eq!(
        group.items[0]
            .scope_assessment
            .as_ref()
            .unwrap()
            .scope_signals,
        vec!["one child item"]
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
    assert_eq!(request.prompt.len(), 7);
    assert!(prompt_section_exists(&request.prompt, "Role"));
    assert!(prompt_section_exists(&request.prompt, "Operating Model"));
    assert!(prompt_section_exists(&request.prompt, "Context"));
    assert!(prompt_section_exists(&request.prompt, "Task Board"));
    assert!(prompt_section_exists(
        &request.prompt,
        "Recent Conversation"
    ));
    assert!(prompt_section_exists(&request.prompt, "Latest Message"));
    assert!(prompt_section_exists(&request.prompt, "Completion"));
    assert!(prompt_contains(&request.prompt, "assistant-level operator"));
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
        "Recent Conversation"
    ));

    let packet = parse_context_packet(&request);
    assert_eq!(packet["kind"], "assistant_turn");
    assert!(packet.get("task_board").is_none());
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
    schema
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| properties.contains_key(property))
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
        NodeOperation::Acquire => NodePlan::NeedsInfo {
            need: "missing input".to_string(),
            then: Box::new(NodePlan::Execute),
        },
        NodeOperation::Plan | NodeOperation::Combine => NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![NodeTemplate::memory_leaf("child", "child output")],
        }),
    }
}

fn scoped_git_leaf(key: &str, output: &str, path: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey(key.to_string()),
        intent: output.to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git([path]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    }
}

fn problem_node(plan: NodePlan) -> ProblemNode {
    ProblemNode {
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
        acquired: Vec::new(),
        candidate: None,
        accepted_artifact: None,
        execution_attempts: 0,
        verification_attempts: 0,
    }
}
