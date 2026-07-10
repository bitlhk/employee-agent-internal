# External Agents

External Agents are long-running or specialized Agent runtimes called by EA through an adapter protocol such as A2A.

They are business capabilities, but they are not MCP business tools. Keep their registration and deployment templates here, separate from `server/tools/business_tools`.

Deployment-specific Agent manifests should live outside the public repository
or be injected through database/configuration during deployment. Keep examples
generic and avoid committing customer, industry, endpoint, or credential details.
