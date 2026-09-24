# Initial architecture decision

Pi is the agent runtime and orchestration layer. OmniRoute is the model gateway. Reusable analysis procedures belong in Pi skills. Actual filesystem, shell, and parsing operations should use Pi built-in tools or focused extensions.

Deferred until needed: database connectors, Splunk connectors, persistent cross-project memory, vector search, and multi-agent orchestration.
