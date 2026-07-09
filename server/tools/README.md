# EA Tools

EA tools are split by runtime purpose:

- `platform_tools`: platform control tools exposed back to the agent runtime, such as scheduling, notifications, channel lookup, and external Agent task submission.
- `business_tools`: business capability MCP implementations or adapters used directly by the agent runtime to answer user questions.

Business tool server IDs should stay domain-oriented, for example `customer_context_tool`, `risk_assessment_tool`, or `document_review_tool`.
Platform control tools use the shared server ID `platform_tools`.
