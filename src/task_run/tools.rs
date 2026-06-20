use schemars::JsonSchema;
use serde::Deserialize;

use crate::{
    AgentToolSpec, FailureClass, NodeTemplate, PlanGroup, PlanGroupMode, VerificationVerdict,
};

use super::NodeOperationOutput;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct EngineTools;

#[siko_macros::toolset(enum_name = "EngineTool", output = "crate::NodeOperationOutput")]
impl EngineTools {
    #[tool(description = "Submit the normalized specification for this node.")]
    pub(crate) fn submit_specification(&self, _args: EmptyToolArgs) -> NodeOperationOutput {
        NodeOperationOutput::Specified
    }

    #[tool(description = "Submit acquired information and supporting evidence.")]
    pub(crate) fn submit_evidence(&self, args: SubmitEvidenceArgs) -> NodeOperationOutput {
        NodeOperationOutput::Acquired {
            need: args.need,
            evidence: args.evidence,
            next_plan: args.next_plan,
        }
    }

    #[tool(description = "Submit a stage or parallel plan group for recursive execution.")]
    pub(crate) fn submit_plan_group(&self, args: SubmitPlanGroupArgs) -> NodeOperationOutput {
        NodeOperationOutput::Planned {
            group: PlanGroup {
                mode: args.mode,
                items: args.items,
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

    #[tool(description = "Submit the final commit/report signal for the accepted node.")]
    pub(crate) fn submit_commit(&self, _args: EmptyToolArgs) -> NodeOperationOutput {
        NodeOperationOutput::Committed
    }
}

pub(crate) fn read_operation_context_spec() -> AgentToolSpec {
    AgentToolSpec {
        name: "read_operation_context".to_string(),
        description: "Read the current operation context packet.".to_string(),
        input_schema: crate::agent_run::schema_for::<EmptyToolArgs>(),
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct EmptyToolArgs {}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitEvidenceArgs {
    pub need: String,
    pub evidence: String,
    pub next_plan: crate::NodePlan,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitPlanGroupArgs {
    pub mode: PlanGroupMode,
    pub items: Vec<NodeTemplate>,
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
    pub failure_class: Option<crate::FailureClass>,
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
                failure_class: self.failure_class.unwrap_or(FailureClass::BadOutput),
                reason: self.reason,
            },
            VerdictDecision::NeedInformation => VerificationVerdict::Uncertain {
                missing_info: self.missing_info.unwrap_or_default(),
                reason: self.reason,
            },
        }
    }
}
