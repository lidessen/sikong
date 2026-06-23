use schemars::JsonSchema;
use serde::Deserialize;

use super::{
    Budget, CapabilityProfile, FailureClass, NodeOperationOutput, NodePlan, NodePolicy,
    NodeTemplate, PlanGroup, PlanGroupMode, ProblemKey, ScopeAssessment, TaskType,
    VerificationVerdict, WorkSize,
};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct EngineTools;

#[siko_macros::toolset(
    enum_name = "EngineTool",
    output = "crate::core::task_run::NodeOperationOutput"
)]
impl EngineTools {
    #[tool(
        description = "Submit the normalized scope assessment for this node. The engine decides the next plan."
    )]
    pub(crate) fn submit_specification(
        &self,
        args: SubmitSpecificationArgs,
    ) -> NodeOperationOutput {
        let SubmitSpecificationArgs { next, size, reason } = args;
        NodeOperationOutput::Specified {
            scope_assessment: ScopeAssessment { next, size, reason },
        }
    }

    #[tool(description = "Submit a stage or parallel plan group for recursive execution.")]
    pub(crate) fn submit_plan_group(&self, args: SubmitPlanGroupArgs) -> NodeOperationOutput {
        if args.items.is_empty() {
            return NodeOperationOutput::InvalidPlan {
                code: "protocol".into(),
                reason: "plan group must contain at least one item".to_string(),
            };
        }
        if args.mode == PlanGroupMode::Parallel
            && args.items.iter().any(|item| item.requires_prior_results)
        {
            return NodeOperationOutput::InvalidPlan {
                code: "parallel_dependency".into(),
                reason:
                    "parallel plan items must be mutually independent; dependent synthesis belongs in the parent Combine pass"
                        .to_string(),
            };
        }
        NodeOperationOutput::Planned {
            group: PlanGroup {
                mode: args.mode,
                items: args
                    .items
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| item.into_node_template(index))
                    .collect(),
            },
        }
    }

    #[tool(description = "Submit the atomic work result.")]
    pub(crate) fn submit_work(&self, args: SubmitWorkArgs) -> NodeOperationOutput {
        NodeOperationOutput::Executed {
            output: args.output,
        }
    }

    #[tool(description = "Submit the combined result after integrating child artifacts.")]
    pub(crate) fn submit_combination(&self, args: SubmitCombinationArgs) -> NodeOperationOutput {
        NodeOperationOutput::Combined {
            output: args.output,
        }
    }

    #[tool(description = "Submit the verification verdict for the candidate artifact.")]
    pub(crate) fn submit_verdict(&self, args: SubmitVerdictArgs) -> NodeOperationOutput {
        NodeOperationOutput::Verified {
            verdict: args.into_verdict(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitSpecificationArgs {
    pub next: String,
    pub size: WorkSize,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitPlanGroupArgs {
    pub mode: PlanGroupMode,
    #[schemars(length(min = 1))]
    pub items: Vec<PlanItemInput>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanItemInput {
    pub key: Option<String>,
    pub title: Option<String>,
    pub intent: Option<String>,
    pub description: Option<String>,
    pub verification: Option<String>,
    pub read_scope: Option<Vec<String>>,
    pub write_scope: Option<Vec<String>>,
    pub size: Option<WorkSize>,
    pub reason: Option<String>,
    pub requires_prior_results: bool,
    /// Node execution policy. Use `decompose` when the child should be
    /// recursively decomposed into smaller sub-tasks (up to 3 levels).
    /// Defaults to `explore` when absent.
    #[serde(default)]
    pub policy: Option<NodePolicy>,
    /// Task type for this plan item. Determines the Policy Pack used
    /// to configure planning behavior. Defaults to `explore` when absent.
    #[serde(default)]
    pub task_type: Option<TaskType>,
}

impl PlanItemInput {
    fn into_node_template(self, index: usize) -> NodeTemplate {
        let fallback_title = self
            .title
            .as_deref()
            .or(self.intent.as_deref())
            .or(self.description.as_deref())
            .unwrap_or("item");
        let key = self
            .key
            .unwrap_or_else(|| plan_item_key(fallback_title, index));
        let mut intent = self
            .intent
            .or(self.description)
            .or(self.title)
            .unwrap_or_else(|| format!("Complete plan item {}", index + 1));
        if let Some(verification) = self.verification {
            intent.push_str("\n\nAcceptance: ");
            intent.push_str(&verification);
        }

        let size = self.size.unwrap_or_default();
        let scope_assessment = self.reason.map(|reason| ScopeAssessment {
            next: intent.clone(),
            size,
            reason,
        });

        let task_type = self.task_type.unwrap_or(TaskType::Explore);
        NodeTemplate {
            policy: self.policy.unwrap_or(NodePolicy::Explore),
            task_type,
            key: ProblemKey(key),
            intent,
            size,
            scope_assessment,
            workspace: crate::common::workspace::WorkspaceRequirement {
                provider: crate::common::workspace::WorkspaceProvider::Memory,
                read_scope: self.read_scope.unwrap_or_default(),
                write_scope: self.write_scope.unwrap_or_default(),
                git: None,
            },
            capabilities: CapabilityProfile::read_only(),
            budget: Budget::default(),
            plan: NodePlan::Execute,
        }
    }
}

fn plan_item_key(input: &str, index: usize) -> String {
    let mut key = String::new();
    let mut last_dash = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            key.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !key.is_empty() {
            key.push('-');
            last_dash = true;
        }
    }
    while key.ends_with('-') {
        key.pop();
    }
    if key.is_empty() {
        format!("item-{}", index + 1)
    } else {
        key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_with_hard_violations_is_rejected() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::Accept,
            reason: "looks good but has issues".to_string(),
            failure_class: None,
            missing_info: None,
            hard_violations: Some(vec!["G-SCOPE-WIDEN".to_string()]),
        };
        let verdict = args.into_verdict();
        assert!(matches!(verdict, VerificationVerdict::Reject { .. }));
    }

    #[test]
    fn accept_without_hard_violations_is_accepted() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::Accept,
            reason: "all good".to_string(),
            failure_class: None,
            missing_info: None,
            hard_violations: None,
        };
        let verdict = args.into_verdict();
        assert_eq!(verdict, VerificationVerdict::Accept);
    }

    #[test]
    fn accept_with_empty_hard_violations_is_accepted() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::Accept,
            reason: "all good".to_string(),
            failure_class: None,
            missing_info: None,
            hard_violations: Some(Vec::new()),
        };
        let verdict = args.into_verdict();
        assert_eq!(verdict, VerificationVerdict::Accept);
    }

    #[test]
    fn plan_item_key_from_title() {
        let key = plan_item_key("Lock developer preview scope", 0);
        assert_eq!(key, "lock-developer-preview-scope");
    }

    #[test]
    fn plan_item_key_lowercases_alphanumeric() {
        let key = plan_item_key("childWork FollowUp", 0);
        assert_eq!(key, "childwork-followup");
    }

    #[test]
    fn plan_item_key_collapses_adjacent_separators() {
        let key = plan_item_key("child   work", 0);
        assert_eq!(key, "child-work");
    }

    #[test]
    fn plan_item_key_strips_leading_and_trailing_dashes() {
        let key = plan_item_key("//child-work/", 0);
        assert_eq!(key, "child-work");
    }

    #[test]
    fn plan_item_key_empty_input_falls_back_to_index() {
        let key = plan_item_key("", 0);
        assert_eq!(key, "item-1");
        let key = plan_item_key("", 4);
        assert_eq!(key, "item-5");
    }

    #[test]
    fn plan_item_key_all_special_chars_falls_back_to_index() {
        let key = plan_item_key("!!!@@@###", 2);
        assert_eq!(key, "item-3");
    }

    #[test]
    fn plan_item_key_non_ascii_stripped() {
        let key = plan_item_key("réseau config", 0);
        assert_eq!(key, "r-seau-config");
    }

    #[test]
    fn submit_plan_group_rejects_empty_items() {
        let output = EngineTools.submit_plan_group(SubmitPlanGroupArgs {
            mode: PlanGroupMode::Parallel,
            items: Vec::new(),
        });
        assert!(
            matches!(&output, NodeOperationOutput::InvalidPlan { code, .. } if code == "protocol")
        );
    }

    #[test]
    fn submit_plan_group_rejects_empty_items_in_stage_mode() {
        let output = EngineTools.submit_plan_group(SubmitPlanGroupArgs {
            mode: PlanGroupMode::Stage,
            items: Vec::new(),
        });
        assert!(
            matches!(&output, NodeOperationOutput::InvalidPlan { code, .. } if code == "protocol")
        );
    }

    #[test]
    fn submit_plan_group_rejects_parallel_dependency() {
        let output = EngineTools.submit_plan_group(SubmitPlanGroupArgs {
            mode: PlanGroupMode::Parallel,
            items: vec![
                PlanItemInput {
                    key: None,
                    title: Some("Inspect surface A".to_string()),
                    intent: None,
                    description: None,
                    verification: None,
                    read_scope: None,
                    write_scope: None,
                    size: None,
                    reason: None,
                    requires_prior_results: false,
                    policy: None,
                    task_type: None,
                },
                PlanItemInput {
                    key: None,
                    title: Some("Inspect surface B".to_string()),
                    intent: None,
                    description: None,
                    verification: None,
                    read_scope: None,
                    write_scope: None,
                    size: None,
                    reason: None,
                    requires_prior_results: true,
                    policy: None,
                    task_type: None,
                },
            ],
        });
        assert!(
            matches!(&output, NodeOperationOutput::InvalidPlan { code, .. } if code == "parallel_dependency")
        );
    }

    #[test]
    fn submit_plan_group_accepts_valid_parallel_items() {
        let output = EngineTools.submit_plan_group(SubmitPlanGroupArgs {
            mode: PlanGroupMode::Parallel,
            items: vec![
                PlanItemInput {
                    key: Some("surface-a".to_string()),
                    title: None,
                    intent: Some("Inspect surface A".to_string()),
                    description: None,
                    verification: Some("must find concrete evidence".to_string()),
                    read_scope: Some(vec!["src/surface_a/**/*.rs".to_string()]),
                    write_scope: None,
                    size: Some(WorkSize::Small),
                    reason: Some("focused scan".to_string()),
                    requires_prior_results: false,
                    policy: None,
                    task_type: None,
                },
                PlanItemInput {
                    key: Some("surface-b".to_string()),
                    title: None,
                    intent: Some("Inspect surface B".to_string()),
                    description: None,
                    verification: None,
                    read_scope: None,
                    write_scope: None,
                    size: None,
                    reason: None,
                    requires_prior_results: false,
                    policy: None,
                    task_type: None,
                },
            ],
        });
        assert!(matches!(&output, NodeOperationOutput::Planned { .. }));
        if let NodeOperationOutput::Planned { group } = &output {
            assert_eq!(group.mode, PlanGroupMode::Parallel);
            assert_eq!(group.items.len(), 2);
            assert_eq!(group.items[0].key.0, "surface-a");
            assert!(group.items[0].intent.contains("Inspect surface A"));
            assert!(group.items[0].intent.contains("Acceptance:"));
            assert!(group.items[0].intent.contains("concrete evidence"));
            assert_eq!(group.items[0].workspace.write_scope.len(), 0);
            assert_eq!(group.items[1].key.0, "surface-b");
        }
    }

    #[test]
    fn parses_current_failure_class_names() {
        assert_eq!(
            parse_failure_class("missing_info"),
            Some(FailureClass::MissingInfo)
        );
        assert_eq!(
            parse_failure_class("spec_ambiguity"),
            Some(FailureClass::SpecAmbiguity)
        );
        assert_eq!(
            parse_failure_class("incomplete_output"),
            Some(FailureClass::IncompleteOutput)
        );
        assert_eq!(
            parse_failure_class("bad_output"),
            Some(FailureClass::BadOutput)
        );
        assert_eq!(
            parse_failure_class("unsafe_side_effect"),
            Some(FailureClass::UnsafeSideEffect)
        );
        assert_eq!(
            parse_failure_class("merge_conflict"),
            Some(FailureClass::MergeConflict)
        );
        assert_eq!(
            parse_failure_class("budget_exhausted"),
            Some(FailureClass::BudgetExhausted)
        );
    }

    #[test]
    fn parses_legacy_failure_class_names() {
        assert_eq!(
            parse_failure_class("MissingInfo"),
            Some(FailureClass::MissingInfo)
        );
        assert_eq!(
            parse_failure_class("SpecAmbiguity"),
            Some(FailureClass::SpecAmbiguity)
        );
        assert_eq!(
            parse_failure_class("incomplete_assessment"),
            Some(FailureClass::IncompleteOutput)
        );
        assert_eq!(
            parse_failure_class("IncompleteOutput"),
            Some(FailureClass::IncompleteOutput)
        );
        assert_eq!(
            parse_failure_class("BadOutput"),
            Some(FailureClass::BadOutput)
        );
        assert_eq!(
            parse_failure_class("UnsafeSideEffect"),
            Some(FailureClass::UnsafeSideEffect)
        );
        assert_eq!(
            parse_failure_class("MergeConflict"),
            Some(FailureClass::MergeConflict)
        );
        assert_eq!(
            parse_failure_class("BudgetExhausted"),
            Some(FailureClass::BudgetExhausted)
        );
    }

    #[test]
    fn parses_unknown_failure_class_as_none() {
        assert_eq!(parse_failure_class("unknown"), None);
        assert_eq!(parse_failure_class(""), None);
        assert_eq!(parse_failure_class("incomplete"), None);
        assert_eq!(parse_failure_class("BudgetExceeded"), None);
    }

    #[test]
    fn reject_verdict_with_unknown_failure_class_defaults_to_bad_output() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::Reject,
            reason: "bad".to_string(),
            failure_class: Some("unknown_failure".to_string()),
            missing_info: None,
            hard_violations: None,
        };
        let verdict = args.into_verdict();
        assert!(matches!(
            verdict,
            VerificationVerdict::Reject {
                failure_class: FailureClass::BadOutput,
                ..
            }
        ));
    }

    #[test]
    fn reject_verdict_without_failure_class_defaults_to_bad_output() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::Reject,
            reason: "bad".to_string(),
            failure_class: None,
            missing_info: None,
            hard_violations: None,
        };
        let verdict = args.into_verdict();
        assert!(matches!(
            verdict,
            VerificationVerdict::Reject {
                failure_class: FailureClass::BadOutput,
                ..
            }
        ));
    }

    #[test]
    fn need_information_sets_missing_info() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::NeedInformation,
            reason: "need specifics".to_string(),
            failure_class: None,
            missing_info: Some("provider selection".to_string()),
            hard_violations: None,
        };
        let verdict = args.into_verdict();
        assert!(matches!(
            verdict,
            VerificationVerdict::Uncertain {
                missing_info,
                ..
            } if missing_info == "provider selection"
        ));
    }

    #[test]
    fn need_information_defaults_empty_missing_info() {
        let args = SubmitVerdictArgs {
            verdict: VerdictDecision::NeedInformation,
            reason: "need specifics".to_string(),
            failure_class: None,
            missing_info: None,
            hard_violations: None,
        };
        let verdict = args.into_verdict();
        assert!(matches!(
            verdict,
            VerificationVerdict::Uncertain {
                missing_info,
                ..
            } if missing_info.is_empty()
        ));
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitWorkArgs {
    pub output: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitCombinationArgs {
    pub output: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitVerdictArgs {
    pub verdict: VerdictDecision,
    pub reason: String,
    pub failure_class: Option<String>,
    pub missing_info: Option<String>,
    #[serde(default)]
    pub hard_violations: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub(crate) enum VerdictDecision {
    Accept,
    Reject,
    NeedInformation,
}

impl SubmitVerdictArgs {
    fn into_verdict(self) -> VerificationVerdict {
        // G-PASS-WITH-HARD-VIOLATION: Accept with hard violations is a reject.
        if self.verdict == VerdictDecision::Accept
            && self.hard_violations.as_ref().is_some_and(|v| !v.is_empty())
        {
            return VerificationVerdict::Reject {
                failure_class: FailureClass::BadOutput,
                reason: format!(
                    "accept verdict with hard violations violates G-PASS-WITH-HARD-VIOLATION: {}",
                    self.hard_violations.unwrap_or_default().join(", ")
                ),
            };
        }
        match self.verdict {
            VerdictDecision::Accept => VerificationVerdict::Accept,
            VerdictDecision::Reject => VerificationVerdict::Reject {
                failure_class: self
                    .failure_class
                    .as_deref()
                    .and_then(parse_failure_class)
                    .unwrap_or(FailureClass::BadOutput),
                reason: self.reason,
            },
            VerdictDecision::NeedInformation => VerificationVerdict::Uncertain {
                missing_info: self.missing_info.unwrap_or_default(),
                reason: self.reason,
            },
        }
    }
}

fn parse_failure_class(input: &str) -> Option<FailureClass> {
    match input {
        "missing_info" | "MissingInfo" => Some(FailureClass::MissingInfo),
        "spec_ambiguity" | "SpecAmbiguity" => Some(FailureClass::SpecAmbiguity),
        "incomplete_output" | "incomplete_assessment" | "IncompleteOutput" => {
            Some(FailureClass::IncompleteOutput)
        }
        "bad_output" | "BadOutput" => Some(FailureClass::BadOutput),
        "unsafe_side_effect" | "UnsafeSideEffect" => Some(FailureClass::UnsafeSideEffect),
        "merge_conflict" | "MergeConflict" => Some(FailureClass::MergeConflict),
        "budget_exhausted" | "BudgetExhausted" => Some(FailureClass::BudgetExhausted),
        _ => None,
    }
}
