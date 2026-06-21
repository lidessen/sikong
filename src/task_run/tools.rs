use schemars::JsonSchema;
use serde::Deserialize;

use super::{
    Budget, CapabilityProfile, FailureClass, NodeOperationOutput, NodePlan, NodeTemplate,
    PlanGroup, PlanGroupMode, ProblemKey, ScopeAssessment, VerificationVerdict, WorkSize,
};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct EngineTools;

#[siko_macros::toolset(
    enum_name = "EngineTool",
    output = "crate::task_run::NodeOperationOutput"
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
                reason: "plan group must contain at least one item".to_string(),
            };
        }
        if args.mode == PlanGroupMode::Parallel
            && args.items.iter().any(|item| item.requires_prior_results)
        {
            return NodeOperationOutput::InvalidPlan {
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
    pub size: Option<WorkSize>,
    pub reason: Option<String>,
    pub requires_prior_results: bool,
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

        NodeTemplate {
            key: ProblemKey(key),
            intent,
            size,
            scope_assessment,
            workspace: crate::workspace::WorkspaceRequirement::memory(),
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
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub(crate) enum VerdictDecision {
    Accept,
    Reject,
    NeedInformation,
}

impl SubmitVerdictArgs {
    fn into_verdict(self) -> VerificationVerdict {
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
