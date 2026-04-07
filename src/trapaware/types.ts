// src/trapaware/types.ts

export type Severity = "info" | "low" | "medium" | "high";

export type ReadScanner =
  | "hidden_role_marker"       // Tier 1 match inside hidden content
  | "hidden_known_signature";  // Tier 2 match inside hidden content

export type EgressScanner =
  | "secret_ssh_private_key"          // covers RSA, DSA, EC, OPENSSH
  | "secret_pgp_private_key"
  | "secret_aws_access_key"
  | "secret_aws_secret_key"           // context-gated: requires co-occurring AKIA...
  | "secret_github_classic_pat"       // ghp_
  | "secret_github_oauth_token"       // gho_
  | "secret_github_user_to_server"    // ghu_
  | "secret_github_server_to_server"  // ghs_ (includes Actions GITHUB_TOKEN)
  | "secret_github_refresh_token"     // ghr_
  | "secret_github_fine_grained_pat"  // github_pat_
  | "secret_openai_key"
  | "secret_anthropic_key"
  | "secret_slack_token"
  | "secret_npm_token"
  | "secret_tailscale_auth_key"
  | "pii_email"
  | "pii_phone"
  | "pii_ssn"
  | "pii_credit_card";

export type HiddenBy =
  | "inline_style_display_none"
  | "inline_style_visibility_hidden"
  | "inline_style_opacity_zero"
  | "inline_style_font_size_zero"
  | "inline_style_offscreen"
  | "hidden_attribute"
  | "aria_hidden"
  | "html_comment";

export type ParamLocation =
  | "url_query"
  | "body_json"
  | "body_form"
  | "body_multipart"
  | "body_raw";

export interface ReadFinding {
  source: "read";
  scanner: ReadScanner;
  severity: Severity;
  hiddenBy: HiddenBy;
  location: { offset: number; length: number; surroundingTag: string | null };
  /** Redacted excerpt from the trap payload, max 80 chars. */
  excerpt: string;
  rationale: string;
}

export interface EgressFinding {
  source: "egress";
  scanner: EgressScanner;
  severity: Severity;
  domain: string;
  requestPath: string;
  paramLocation: ParamLocation;
  /** Structural path to the match (e.g., "body.user.ssh_key"), NEVER the value. */
  paramPath: string;
  /** Integer length of matched bytes, for sanity without leaking content. */
  matchLength: number;
  action: "annotate" | "block" | "pass";
  rationale: string;
}

export type Finding = ReadFinding | EgressFinding;

/** Resolved egress check state after the precedence chain runs. */
export interface EgressCheckState {
  enabled: boolean;
  action: "annotate" | "block";
}

/** Shape of the global config file. */
export interface TrapAwareConfig {
  egressCheckAll: boolean;
  egressCheckAction: "annotate" | "block";
}
