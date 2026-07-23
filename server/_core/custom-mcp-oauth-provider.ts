import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CustomMcpOAuthData } from "../db/custom-mcp-connections";

type ProviderOptions = {
  data: CustomMcpOAuthData;
  state?: string;
  clientMetadata?: Record<string, unknown>;
  onRedirect?: (url: URL) => void;
  onDataChanged?: (data: CustomMcpOAuthData) => void | Promise<void>;
};

export class CustomMcpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue = "";

  constructor(private readonly options: ProviderOptions) {}

  get redirectUrl(): string {
    return this.options.data.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...(this.options.clientMetadata || {}),
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Employee Agent",
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.options.state || "runtime-reauthorization-required";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.options.data.clientInformation as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.options.data.clientInformation = clientInformation as unknown as Record<string, unknown>;
    await this.changed();
  }

  tokens(): OAuthTokens | undefined {
    return this.options.data.tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.options.data.tokens = tokens as unknown as Record<string, unknown>;
    await this.changed();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.options.onRedirect) throw new Error("MCP 授权已失效，请重新授权");
    this.options.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error("OAuth PKCE verifier is missing");
    return this.codeVerifierValue;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.options.data.discoveryState = state as unknown as Record<string, unknown>;
    await this.changed();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.options.data.discoveryState as unknown as OAuthDiscoveryState | undefined;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.options.data.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.options.data.tokens;
    if (scope === "all" || scope === "discovery") delete this.options.data.discoveryState;
    if (scope === "all" || scope === "verifier") this.codeVerifierValue = "";
    await this.changed();
  }

  private async changed(): Promise<void> {
    await this.options.onDataChanged?.(this.options.data);
  }
}
