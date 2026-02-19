# ApiTap Red — Threat Model & Detection Strategies
*2026-02-16 | What's actually detectable from captured API traffic*

---

## 1. Data Inventory

Everything ApiTap Red can detect comes from two sources: **captured exchanges** (live browser traffic) and **skill files** (persisted endpoint specifications). Here's exactly what security-relevant data each contains.

### From CapturedExchange (live traffic)

| Field | Security relevance |
|-------|-------------------|
| `request.url` | Full URL with query params — exposes path structure, parameter names, values |
| `request.method` | HTTP verb — identifies state-changing operations (POST/PUT/DELETE) |
| `request.headers` | Auth tokens (Authorization, Cookie, X-API-Key), CSRF tokens, content negotiation |
| `request.postData` | Request bodies — injection points, sensitive field names, CSRF tokens embedded in forms |
| `response.status` | Auth enforcement signals (401/403 vs 200), error handling patterns |
| `response.headers` | CORS policy, rate limit headers, server version, security headers (CSP, HSTS, X-Frame-Options) |
| `response.body` | Data exposure, verbose errors, stack traces, internal IDs, PII leakage |
| `response.contentType` | API format, unexpected HTML (challenge pages) |
| `timestamp` | Timing analysis — response time variance can indicate processing differences |

### From SkillFile (persisted)

| Field | Security relevance |
|-------|-------------------|
| `endpoints[].path` | Parameterized paths reveal ID patterns (`:id` vs `:hash`) |
| `endpoints[].method` | CRUD surface map |
| `endpoints[].headers` | `[stored]` placeholder = auth required; absence = unauthenticated |
| `endpoints[].queryParams` | Parameter names and types — attack vector enumeration |
| `endpoints[].responseShape` | Object fields exposed in responses — data model exposure |
| `endpoints[].replayability.tier` | Green = trivially exploitable; red = protected |
| `endpoints[].requestBody.variables` | User-substitutable fields = injection points |
| `endpoints[].requestBody.refreshableTokens` | CSRF token locations |
| `endpoints[].pagination` | Enumeration capability — offset/cursor/page patterns |
| `auth.browserMode` | `visible` = CAPTCHA expected |
| `auth.captchaRisk` | Anti-bot protection present |
| `metadata.browserCost` | Traffic volume — high totalRequests may indicate aggressive API usage |

### What we DON'T have (and shouldn't pretend to)

- **Response bodies across different auth contexts** — We capture one user's session. Without multi-user replay, we can't prove BOLA (only flag candidates).
- **Business logic context** — We can't distinguish "checkout" from "add to cart" semantically.
- **Server-side state** — We don't know what's in the database. A sequential ID may be densely or sparsely populated.
- **Network topology** — No DNS, no port scanning, no infrastructure context.

This honesty matters. Every detection below states its confidence level and what would be needed to upgrade it.

---

## 2. OWASP API Security Top 10 — Detection Strategies

### API1: Broken Object-Level Authorization (BOLA/IDOR)

**What it is:** Users can access objects belonging to other users by manipulating IDs in requests.

**Passive signals from captured traffic:**

```
DETECT_BOLA(skillFile):
  candidates = []

  for endpoint in skillFile.endpoints:
    // Signal 1: Sequential numeric IDs in path
    if endpoint.path contains ":id" AND example URL has numeric ID:
      score = 60  // strong IDOR candidate

      // Boost: endpoint returns object (not array) — single-resource fetch
      if endpoint.responseShape.type == "object":
        score += 10

      // Boost: response contains fields like "email", "address", "name"
      if endpoint.responseShape.fields intersects PII_FIELD_NAMES:
        score += 15

      // Reduce: endpoint requires auth ([stored] header present)
      // Auth doesn't prevent BOLA but suggests the dev considered access control
      if endpoint has [stored] auth header:
        score -= 10

      candidates.push({ endpoint, score, reason: "sequential-id" })

    // Signal 2: Batch/list endpoint with limit+offset (enumeration risk)
    if endpoint.pagination exists AND endpoint.path contains ":id":
      candidates.push({ endpoint, score: 50, reason: "enumerable-resource" })

    // Signal 3: ID in query param instead of path
    for param in endpoint.queryParams:
      if param.name in ["id", "userId", "user_id", "account_id", "orderId"]:
        if param.type == "string" AND param.example is numeric:
          candidates.push({ endpoint, score: 55, reason: "id-in-query" })

  return candidates sorted by score DESC
```

**Confidence:** Medium. Sequential IDs are necessary but not sufficient for BOLA. Many APIs use sequential IDs with proper authorization.

**Active testing upgrade:** Replay the endpoint with ID ± 1. If the response changes but doesn't return 403, BOLA is confirmed. This is the single highest-value active test.

**False positive mitigation:** Exclude endpoints where `:id` segments are in non-resource positions (e.g., `/api/v2/...` where `v2` parameterizes to `:id`). Check that the ID segment follows a noun (`/users/:id`, `/orders/:id`) not a verb or version.

**Known PII field names:**
```
PII_FIELD_NAMES = [
  "email", "phone", "address", "ssn", "dob", "dateOfBirth",
  "creditCard", "cardNumber", "password", "secret", "token",
  "name", "firstName", "lastName", "fullName",
  "salary", "income", "balance", "accountNumber"
]
```

---

### API2: Broken Authentication

**What it is:** Endpoints accept requests without valid authentication, or auth mechanisms are flawed.

**Passive signals:**

```
DETECT_BROKEN_AUTH(skillFile):
  findings = []

  // Check 1: Endpoints that returned 200 with no auth header captured
  for endpoint in skillFile.endpoints:
    hasAuthHeader = any header value == "[stored]" in endpoint.headers

    if NOT hasAuthHeader AND endpoint.replayability.tier == "green":
      // This endpoint worked without auth during capture

      // Severity depends on what it returns
      if endpoint.responseShape.fields intersects PII_FIELD_NAMES:
        findings.push({ endpoint, severity: "critical",
          reason: "unauthenticated-pii-exposure" })
      elif endpoint.method != "GET":
        findings.push({ endpoint, severity: "high",
          reason: "unauthenticated-state-change" })
      elif endpoint.path matches ADMIN_PATTERNS:
        findings.push({ endpoint, severity: "critical",
          reason: "unauthenticated-admin-access" })
      else:
        findings.push({ endpoint, severity: "info",
          reason: "public-endpoint" })

  // Check 2: Auth endpoints themselves
  authEndpoints = endpoints where path matches AUTH_PATTERNS
  for ep in authEndpoints:
    if ep.method == "POST" AND ep.path contains "login":
      // Check if rate limiting headers present
      if NOT hasRateLimitHeaders(ep):
        findings.push({ ep, severity: "medium",
          reason: "login-no-rate-limit" })

  return findings

ADMIN_PATTERNS = [
  /\/admin\//i, /\/internal\//i, /\/debug\//i,
  /\/management\//i, /\/console\//i, /\/config\//i
]

AUTH_PATTERNS = [
  /\/auth\//i, /\/login/i, /\/register/i, /\/signup/i,
  /\/token/i, /\/oauth/i, /\/session/i, /\/password/i
]
```

**Confidence:** High for unauthenticated access (we literally observed it). Medium for login rate limiting (absence of headers doesn't prove absence of limits).

**Active testing upgrade:** Replay each endpoint that had auth headers — but strip the auth header. If you still get 200, authentication is broken.

---

### API3: Broken Object Property-Level Authorization

**What it is:** Users can read or write object properties they shouldn't have access to (mass assignment, excessive data exposure).

**Passive signals:**

```
DETECT_PROPERTY_AUTH(skillFile):
  findings = []

  // Check 1: Excessive data exposure — response contains more fields than needed
  for endpoint in skillFile.endpoints:
    if endpoint.responseShape.fields:
      sensitiveFields = endpoint.responseShape.fields intersect SENSITIVE_FIELDS
      if sensitiveFields.length > 0:
        findings.push({ endpoint, severity: "medium",
          reason: "sensitive-fields-in-response",
          fields: sensitiveFields })

  // Check 2: Mass assignment candidates — POST/PUT with requestBody.variables
  for endpoint in skillFile.endpoints:
    if endpoint.method in ["POST", "PUT", "PATCH"] AND endpoint.requestBody:
      vars = endpoint.requestBody.variables or []
      dangerousVars = vars intersect PRIVILEGE_FIELDS
      if dangerousVars.length > 0:
        findings.push({ endpoint, severity: "high",
          reason: "mass-assignment-candidate",
          fields: dangerousVars })

  return findings

SENSITIVE_FIELDS = [
  "password", "passwordHash", "salt", "secret", "apiKey",
  "internalId", "role", "isAdmin", "permissions", "createdBy"
]

PRIVILEGE_FIELDS = [
  "role", "isAdmin", "admin", "permissions", "group",
  "accountType", "tier", "verified", "active", "status"
]
```

**Confidence:** Low-medium. Sensitive field names in responses are suggestive but not proof of improper access. The same response might look different for admin vs. regular users — we can't tell from one session.

**Active testing upgrade:** Capture as two different users. Diff the response fields per endpoint. Fields present for one user but not another reveal the authorization boundary. Fields present for both (especially sensitive ones) are the finding.

---

### API4: Unrestricted Resource Consumption

**What it is:** No rate limiting, no pagination limits, no request size limits.

**Passive signals:**

```
DETECT_RESOURCE_LIMITS(skillFile):
  findings = []

  for endpoint in skillFile.endpoints:
    headers = endpoint.headers  // response headers from example

    // Check 1: No rate limit headers
    hasRateLimit = any key in headers matches
      /^(x-ratelimit|ratelimit|x-rate-limit)/i
    if NOT hasRateLimit:
      findings.push({ endpoint, severity: "medium",
        reason: "no-rate-limit-headers" })

    // Check 2: Pagination without limits
    if endpoint.pagination:
      limitParam = endpoint.pagination.limitParam
      if limitParam:
        limitExample = endpoint.queryParams[limitParam]?.example
        if limitExample AND parseInt(limitExample) > 1000:
          findings.push({ endpoint, severity: "medium",
            reason: "high-pagination-limit", limit: limitExample })
      else:
        // Has pagination but no limit param — server decides
        findings.push({ endpoint, severity: "low",
          reason: "no-explicit-limit-param" })

    // Check 3: Large response bodies (data exfiltration concern)
    if endpoint.responseBytes AND endpoint.responseBytes > 1_000_000:
      findings.push({ endpoint, severity: "low",
        reason: "large-response", bytes: endpoint.responseBytes })

  return findings
```

**Confidence:** Medium for rate limiting (absence of headers is a signal but servers can rate-limit without advertising it). High for pagination limits (directly observable).

**Active testing upgrade:** Send 100 rapid requests to the same endpoint. Count how many succeed. If all 100 return 200, rate limiting is absent.

---

### API5: Broken Function-Level Authorization

**What it is:** Regular users can access admin/privileged functions.

**Passive signals:**

```
DETECT_FUNCTION_AUTH(skillFile):
  findings = []

  for endpoint in skillFile.endpoints:
    // Check 1: Admin/debug/internal paths in captured traffic
    if endpoint.path matches ADMIN_PATTERNS:
      if endpoint.replayability.tier == "green":
        findings.push({ endpoint, severity: "critical",
          reason: "admin-endpoint-no-auth" })
      else:
        findings.push({ endpoint, severity: "medium",
          reason: "admin-endpoint-accessible",
          note: "Responded during regular user session" })

    // Check 2: HTTP method override — unusual methods on standard paths
    if endpoint.method in ["DELETE", "PATCH"] AND
       endpoint.path NOT matches ADMIN_PATTERNS:
      // State-changing methods on user-facing endpoints
      if NOT endpoint.headers has [stored] auth:
        findings.push({ endpoint, severity: "high",
          reason: "destructive-method-no-auth" })

    // Check 3: Debug/health endpoints that leak info
    if endpoint.path matches DEBUG_PATTERNS:
      findings.push({ endpoint, severity: "high",
        reason: "debug-endpoint-exposed" })

  return findings

DEBUG_PATTERNS = [
  /\/debug\b/i, /\/health(check)?\b/i, /\/status\b/i,
  /\/metrics\b/i, /\/info\b/i, /\/env\b/i, /\/actuator/i,
  /\/phpinfo/i, /\/_profiler/i, /\/swagger/i, /\/api-docs/i,
  /\/graphql\/?$/i  // introspection endpoint
]
```

**Confidence:** High for admin endpoints captured during regular browsing (you shouldn't see them at all). Medium for debug endpoints (some are intentionally public).

**Active testing upgrade:** None needed for this category — if an admin endpoint shows up in a regular user's capture session, that's the finding.

---

### API6: Unrestricted Access to Sensitive Business Flows

**What it is:** Attackers abuse legitimate business functionality at scale (coupon fraud, account creation spam, mass purchasing).

**Passive signals:**

```
DETECT_BUSINESS_FLOW_ABUSE(skillFile):
  findings = []

  for endpoint in skillFile.endpoints:
    // Signal: POST endpoints with no CSRF, no rate limiting, on sensitive paths
    if endpoint.method == "POST":
      isSensitivePath = endpoint.path matches BUSINESS_FLOW_PATTERNS
      hasCsrf = endpoint.requestBody?.refreshableTokens?.length > 0
      hasRateLimit = ... // check response headers

      if isSensitivePath AND NOT hasCsrf AND NOT hasRateLimit:
        findings.push({ endpoint, severity: "medium",
          reason: "abusable-business-flow",
          note: "No CSRF protection, no rate limiting on sensitive operation" })

  return findings

BUSINESS_FLOW_PATTERNS = [
  /\/checkout/i, /\/purchase/i, /\/order/i, /\/subscribe/i,
  /\/register/i, /\/signup/i, /\/invite/i, /\/coupon/i,
  /\/redeem/i, /\/transfer/i, /\/vote/i, /\/review/i
]
```

**Confidence:** Low. This is the weakest detection category because it requires business context we don't have. The patterns above are heuristic guesses.

**Active testing upgrade:** Not our domain. This requires business logic testing that varies per application.

---

### API7: Server-Side Request Forgery (SSRF)

**What it is:** Attacker-supplied URLs cause the server to make requests to internal resources.

**Passive signals:**

```
DETECT_SSRF_VECTORS(skillFile):
  findings = []

  for endpoint in skillFile.endpoints:
    // Check 1: URL parameters in query string
    for paramName, paramInfo in endpoint.queryParams:
      if paramName matches URL_PARAM_NAMES:
        findings.push({ endpoint, severity: "high",
          reason: "url-parameter-in-query",
          param: paramName, example: paramInfo.example })

    // Check 2: URL fields in request body
    if endpoint.requestBody AND endpoint.requestBody.variables:
      bodyTemplate = endpoint.requestBody.template
      for varPath in endpoint.requestBody.variables:
        value = resolveJsonPath(bodyTemplate, varPath)
        if isUrl(value) OR varPath matches URL_PARAM_NAMES:
          findings.push({ endpoint, severity: "high",
            reason: "url-in-request-body",
            field: varPath, example: value })

  return findings

URL_PARAM_NAMES = [
  /^url$/i, /^uri$/i, /^link$/i, /^href$/i, /^src$/i,
  /^redirect/i, /^callback/i, /^next$/i, /^return/i,
  /^dest/i, /^target/i, /^webhook/i, /^fetch/i, /^proxy/i,
  /^image_?url/i, /^file_?url/i, /^avatar_?url/i
]
```

**Confidence:** Medium-high. URL parameters are strong SSRF candidates, but the server may validate them.

**Active testing upgrade:** Supply `http://169.254.169.254/latest/meta-data/` (AWS metadata) or a Burp Collaborator/webhook.site URL. If the server fetches it, SSRF is confirmed.

**Irony note:** ApiTap itself hardened against SSRF in `skill/ssrf.ts` with private IP blocking and DNS rebinding protection. We know what SSRF looks like because we defended against it.

---

### API8: Security Misconfiguration

**What it is:** Missing security headers, overly permissive CORS, verbose errors, default credentials.

**Passive signals:**

```
DETECT_MISCONFIG(skillFile, capturedExchanges):
  findings = []

  // Aggregate response headers across all endpoints
  allResponseHeaders = merge(ep.headers for ep in endpoints)
  // Also check the raw exchanges for full header sets

  // Check 1: CORS misconfiguration
  cors = allResponseHeaders["access-control-allow-origin"]
  if cors == "*":
    creds = allResponseHeaders["access-control-allow-credentials"]
    if creds == "true":
      findings.push({ severity: "critical",
        reason: "cors-wildcard-with-credentials" })
    else:
      findings.push({ severity: "medium",
        reason: "cors-wildcard" })

  // Check 2: Missing security headers
  REQUIRED_HEADERS = {
    "strict-transport-security": "high",    // HSTS
    "x-content-type-options": "medium",     // nosniff
    "x-frame-options": "low",               // clickjacking
    "content-security-policy": "low",       // CSP (may not apply to APIs)
  }
  for header, severity in REQUIRED_HEADERS:
    if header NOT in allResponseHeaders:
      findings.push({ severity, reason: "missing-" + header })

  // Check 3: Server version disclosure
  server = allResponseHeaders["server"]
  xPoweredBy = allResponseHeaders["x-powered-by"]
  if server AND server contains version number:
    findings.push({ severity: "low",
      reason: "server-version-disclosed", value: server })
  if xPoweredBy:
    findings.push({ severity: "low",
      reason: "x-powered-by-disclosed", value: xPoweredBy })

  // Check 4: Verbose error information in response bodies
  for exchange in capturedExchanges:
    body = exchange.response.body
    if body matches STACK_TRACE_PATTERNS:
      findings.push({ severity: "medium",
        reason: "stack-trace-in-response",
        endpoint: exchange.request.url })

  return findings

STACK_TRACE_PATTERNS = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/,      // Node.js stack trace
  /File ".*", line \d+/,              // Python traceback
  /\.java:\d+\)/,                     // Java stack trace
  /#\d+\s+.*\.php\(\d+\)/,           // PHP stack trace
  /Traceback \(most recent call/,     // Python
  /"stack":\s*"Error/,                // JSON-wrapped stack trace
]
```

**Confidence:** High. These are directly observable in captured traffic.

**Active testing upgrade:** Not needed — passive detection covers this well.

---

### API9: Improper Inventory Management

**What it is:** Old API versions, deprecated endpoints, shadow APIs still accessible.

**Passive signals:**

```
DETECT_INVENTORY_ISSUES(skillFile):
  findings = []

  // Check 1: Multiple API versions present
  versionPaths = {}  // e.g., { "users": ["v1", "v2"] }
  for endpoint in skillFile.endpoints:
    versionMatch = endpoint.path match /\/(v\d+)\//
    if versionMatch:
      resource = endpoint.path after version segment
      versionPaths[resource] = versionPaths[resource] or []
      versionPaths[resource].push(versionMatch[1])

  for resource, versions in versionPaths:
    if versions.length > 1:
      oldest = min(versions)
      findings.push({ severity: "medium",
        reason: "multiple-api-versions",
        resource, versions,
        note: oldest + " may be deprecated but still accessible" })

  // Check 2: Deprecated headers/indicators
  for endpoint in skillFile.endpoints:
    headers = endpoint.headers
    if headers["deprecation"] OR headers["sunset"]:
      findings.push({ endpoint, severity: "medium",
        reason: "deprecated-endpoint-active" })

  // Check 3: Undocumented endpoints (present in capture but not in OpenAPI spec)
  // Requires comparison with discovered specs
  if skillFile has associated discoveredSpecs:
    specEndpoints = parse specs into Set of "METHOD /path"
    capturedEndpoints = Set of "METHOD /path" from skillFile
    undocumented = capturedEndpoints - specEndpoints
    for ep in undocumented:
      findings.push({ severity: "low",
        reason: "undocumented-endpoint", endpoint: ep })

  return findings
```

**Confidence:** High for version detection (directly observable). Medium for undocumented endpoints (depends on spec completeness).

**Active testing upgrade:** Probe for `/api/v0/`, `/api/v1/` variants of every discovered endpoint. Old versions often have weaker security.

---

### API10: Unsafe Consumption of APIs

**What it is:** The target API blindly trusts data from third-party APIs it consumes.

**Passive signals:**

```
DETECT_UNSAFE_CONSUMPTION(skillFile, capturedExchanges):
  findings = []

  // We can detect third-party API calls in the traffic
  // (domains that differ from the main target)
  targetDomain = skillFile.domain

  thirdPartyDomains = Set()
  for exchange in capturedExchanges:
    domain = extractDomain(exchange.request.url)
    if domain != targetDomain AND NOT isBlocklisted(domain):
      thirdPartyDomains.add(domain)

  if thirdPartyDomains.size > 0:
    findings.push({ severity: "info",
      reason: "third-party-api-consumption",
      domains: thirdPartyDomains,
      note: "Target consumes these APIs. If any are compromised, target is affected." })

  return findings
```

**Confidence:** Low. We can observe third-party calls but can't determine if the target validates them.

**Active testing upgrade:** Not practical from our position. This is a code review finding, not a traffic analysis finding.

---

## 3. Auth & Token Analysis

This deserves dedicated treatment beyond API2 because authentication is the most exploitable surface area in API security.

### 3a. JWT Analysis

ApiTap already parses JWTs via `entropy.ts:parseJwtClaims()`. Red extends this:

```
ANALYZE_JWT(token):
  // Parse header (first segment, not just payload)
  header = base64Decode(token.split(".")[0])
  payload = parseJwtClaims(token)

  findings = []

  // Check 1: Algorithm
  if header.alg == "none":
    findings.push({ severity: "critical", reason: "jwt-alg-none" })
  elif header.alg in ["HS256", "HS384", "HS512"]:
    findings.push({ severity: "medium",
      reason: "jwt-symmetric-algorithm",
      note: "HMAC algorithms vulnerable to key brute-force if secret is weak" })
  elif header.alg in ["RS256", "RS384", "RS512"]:
    // Check for algorithm confusion: RS* with symmetric key
    findings.push({ severity: "info", reason: "jwt-asymmetric-ok" })

  // Check 2: Expiry
  if NOT payload.exp:
    findings.push({ severity: "high", reason: "jwt-no-expiry" })
  elif payload.exp - payload.iat > 86400:  // > 24 hours
    findings.push({ severity: "medium", reason: "jwt-long-lived",
      ttl: payload.exp - payload.iat })

  // Check 3: Claims analysis
  if payload.scope AND payload.scope contains "admin":
    findings.push({ severity: "info", reason: "jwt-admin-scope" })

  if NOT payload.iss:
    findings.push({ severity: "low", reason: "jwt-no-issuer" })

  if NOT payload.aud:
    findings.push({ severity: "low", reason: "jwt-no-audience",
      note: "Token may be accepted by unintended services" })

  // Check 4: Sensitive data in payload
  allClaims = fullPayloadDecode(token)
  sensitiveKeys = allClaims.keys intersect
    ["email", "phone", "ssn", "address", "password"]
  if sensitiveKeys.length > 0:
    findings.push({ severity: "medium", reason: "jwt-pii-in-claims",
      fields: sensitiveKeys })

  return findings
```

### 3b. Token Entropy Analysis

Uses ApiTap's existing `shannonEntropy()` function:

```
ANALYZE_TOKEN_STRENGTH(skillFile):
  findings = []

  for endpoint in skillFile.endpoints:
    for headerName, headerValue in endpoint.examples.request.headers:
      classification = isLikelyToken(headerName, headerValue)

      if classification.isToken AND classification.format == "opaque":
        entropy = shannonEntropy(headerValue)

        // Weak tokens: low entropy suggests predictable generation
        if entropy < 3.5:
          findings.push({ severity: "high",
            reason: "weak-token-entropy",
            header: headerName, entropy,
            note: "Token may be predictable or brute-forceable" })
        elif entropy < 4.0:
          findings.push({ severity: "medium",
            reason: "moderate-token-entropy",
            header: headerName, entropy })

        // Short tokens
        if headerValue.length < 32:
          findings.push({ severity: "medium",
            reason: "short-token",
            header: headerName, length: headerValue.length })

  return findings
```

### 3c. Auth Scheme Analysis

```
ANALYZE_AUTH_SCHEME(skillFile):
  findings = []

  // Collect all auth patterns across endpoints
  authPatterns = {
    bearer: [],    // Authorization: Bearer ...
    apiKey: [],    // X-API-Key, Authorization: ApiKey ...
    cookie: [],    // Cookie-based sessions
    basic: [],     // Authorization: Basic ...
    custom: [],    // Non-standard auth headers
  }

  for endpoint in skillFile.endpoints:
    for header, value in endpoint.headers:
      if header.lower() == "authorization":
        if value starts with "Bearer " OR value == "[stored]":
          authPatterns.bearer.push(endpoint)
        elif value starts with "Basic ":
          authPatterns.basic.push(endpoint)
          findings.push({ endpoint, severity: "medium",
            reason: "basic-auth-in-use",
            note: "Credentials sent base64-encoded (not encrypted) per request" })
      elif header.lower() == "cookie":
        authPatterns.cookie.push(endpoint)

  // Mixed auth schemes = potential confusion
  activeSchemes = [k for k, v in authPatterns if v.length > 0]
  if activeSchemes.length > 1:
    findings.push({ severity: "low",
      reason: "mixed-auth-schemes", schemes: activeSchemes })

  // Cookie auth without CSRF
  if authPatterns.cookie.length > 0:
    for endpoint in authPatterns.cookie:
      if endpoint.method != "GET" AND NOT hasCsrfProtection(endpoint):
        findings.push({ endpoint, severity: "high",
          reason: "cookie-auth-no-csrf",
          note: "POST endpoint uses cookie auth without CSRF token — CSRF attack vector" })

  // No auth at all on the entire domain
  if all endpoints have no [stored] headers:
    findings.push({ severity: "info",
      reason: "no-auth-detected",
      note: "Entire API appears to be unauthenticated" })

  return findings

hasCsrfProtection(endpoint):
  // Check for CSRF tokens in request body
  if endpoint.requestBody?.refreshableTokens?.length > 0:
    return true
  // Check for CSRF headers
  return any header key matches /csrf|xsrf/i in endpoint.headers
```

### 3d. Session Management

```
ANALYZE_SESSIONS(capturedExchanges):
  findings = []

  // Collect all cookies across exchanges
  cookies = {}
  for exchange in capturedExchanges:
    setCookie = exchange.response.headers["set-cookie"]
    if setCookie:
      parsed = parseCookie(setCookie)
      cookies[parsed.name] = parsed

  for name, cookie in cookies:
    // Check 1: Missing Secure flag
    if NOT cookie.secure:
      findings.push({ severity: "medium",
        reason: "cookie-missing-secure", cookie: name })

    // Check 2: Missing HttpOnly flag (for session cookies)
    if isSessionCookie(name) AND NOT cookie.httpOnly:
      findings.push({ severity: "high",
        reason: "session-cookie-missing-httponly", cookie: name,
        note: "Session cookie accessible via JavaScript — XSS can steal sessions" })

    // Check 3: SameSite attribute
    if NOT cookie.sameSite OR cookie.sameSite == "None":
      findings.push({ severity: "medium",
        reason: "cookie-samesite-none", cookie: name,
        note: "Cookie sent on cross-origin requests — CSRF risk" })

    // Check 4: Overly long expiry
    if cookie.expires:
      ttl = cookie.expires - now()
      if ttl > 365 * 24 * 3600:  // > 1 year
        findings.push({ severity: "low",
          reason: "cookie-long-expiry", cookie: name, ttl })

  return findings

isSessionCookie(name):
  return name matches /^(session|sess|sid|connect\.sid|PHPSESSID|JSESSIONID|ASP\.NET_SessionId)/i
```

---

## 4. Beyond OWASP — Additional Detection Patterns

### 4a. CORS Misconfiguration (detailed)

```
ANALYZE_CORS(capturedExchanges):
  findings = []

  for exchange in capturedExchanges:
    origin = exchange.request.headers["origin"]
    acao = exchange.response.headers["access-control-allow-origin"]
    acac = exchange.response.headers["access-control-allow-credentials"]
    acam = exchange.response.headers["access-control-allow-methods"]

    if acao:
      // Pattern 1: Origin reflection (reflects any origin back)
      if acao == origin AND origin != null:
        findings.push({ severity: "high",
          reason: "cors-origin-reflection",
          note: "Server may reflect any Origin header — test with evil.com" })

      // Pattern 2: Null origin allowed
      if acao == "null":
        findings.push({ severity: "high",
          reason: "cors-null-origin",
          note: "Null origin exploitable via sandboxed iframes" })

      // Pattern 3: Wildcard with credentials
      if acao == "*" AND acac == "true":
        findings.push({ severity: "critical",
          reason: "cors-wildcard-credentials" })

      // Pattern 4: Overly permissive methods
      if acam AND acam contains "DELETE" OR acam contains "PUT":
        findings.push({ severity: "low",
          reason: "cors-dangerous-methods", methods: acam })

  return findings
```

### 4b. Information Disclosure

```
DETECT_INFO_DISCLOSURE(skillFile, capturedExchanges):
  findings = []

  // Check 1: PII in URL query strings
  for endpoint in skillFile.endpoints:
    for paramName, paramInfo in endpoint.queryParams:
      if paramName matches PII_PARAM_NAMES:
        findings.push({ endpoint, severity: "high",
          reason: "pii-in-query-string",
          param: paramName,
          note: "PII in URLs appears in server logs, browser history, referrer headers" })

  // Check 2: Verbose error responses
  for exchange in capturedExchanges:
    if exchange.response.status >= 400:
      body = exchange.response.body
      if body contains SQL syntax:
        findings.push({ severity: "critical",
          reason: "sql-error-in-response",
          url: exchange.request.url })
      if body contains file paths (/home/, C:\, /var/):
        findings.push({ severity: "medium",
          reason: "internal-path-disclosed",
          url: exchange.request.url })

  // Check 3: Internal IDs/references leaked
  for endpoint in skillFile.endpoints:
    if endpoint.responseShape.fields:
      internalFields = fields intersect INTERNAL_FIELD_NAMES
      if internalFields.length > 0:
        findings.push({ endpoint, severity: "low",
          reason: "internal-fields-exposed", fields: internalFields })

  return findings

PII_PARAM_NAMES = [/email/i, /phone/i, /ssn/i, /password/i, /token/i, /key/i, /secret/i]

INTERNAL_FIELD_NAMES = [
  "_id", "__v", "createdBy", "updatedBy", "deletedAt",
  "internalId", "dbId", "objectId", "mongoId"
]
```

### 4c. GraphQL-Specific

```
DETECT_GRAPHQL_ISSUES(skillFile):
  findings = []

  graphqlEndpoints = endpoints where path matches /graphql/i

  for endpoint in graphqlEndpoints:
    // Check 1: Introspection enabled
    if endpoint.path ends with "/graphql" AND endpoint.method == "POST":
      // Introspection may have been captured during discovery
      findings.push({ endpoint, severity: "medium",
        reason: "graphql-introspection-possible",
        note: "Test with: { __schema { types { name } } }" })

    // Check 2: No query depth/complexity limiting
    // (Inferred from lack of errors on complex queries)
    findings.push({ endpoint, severity: "info",
      reason: "graphql-check-depth-limiting",
      note: "Active test needed: send deeply nested query" })

  return findings
```

---

## 5. Composite Risk Scoring

Individual findings compose into a domain-level risk assessment:

```
SCORE_DOMAIN(findings):
  weights = {
    critical: 25,
    high: 10,
    medium: 3,
    low: 1,
    info: 0
  }

  rawScore = sum(weights[f.severity] for f in findings)

  // Normalize to 0-100 scale
  // Empirically: 5 critical findings = extremely vulnerable
  score = min(100, rawScore)

  tier =
    score >= 75 ? "critical"  :  // Multiple critical vulns
    score >= 40 ? "high"      :  // Several high-severity issues
    score >= 15 ? "medium"    :  // Mix of medium issues
    score >= 5  ? "low"       :  // Minor issues only
    "minimal"                    // Clean or info-only

  return { score, tier, findingCount: findings.length,
           bySeverity: groupBy(findings, "severity") }
```

---

## 6. Nuclei Template Bridge

Findings that are actively testable map to auto-generated Nuclei YAML templates:

| Finding | Nuclei template strategy |
|---------|------------------------|
| BOLA candidate (API1) | GET endpoint with ID ± 1, check for 200 vs 403 |
| Unauthenticated endpoint (API2) | Request without auth header, check for 200 |
| Missing rate limit (API4) | 50 rapid requests, count successes |
| Admin endpoint exposed (API5) | Request to admin path, check for non-403 |
| SSRF vector (API7) | Supply callback URL in identified parameter |
| CORS reflection (API8) | Request with `Origin: https://evil.com`, check reflected |
| Old API version (API9) | Request to `/api/v1/` variant, check for 200 |

```
GENERATE_NUCLEI_TEMPLATE(finding):
  template = {
    id: "apitap-" + finding.reason,
    info: {
      name: finding.reason,
      severity: finding.severity,
      tags: ["apitap", "api", finding.owaspCategory],
    },
    http: [{
      method: finding.endpoint.method,
      path: [finding.endpoint.path],
      headers: buildTestHeaders(finding),
      matchers: buildMatchers(finding),
    }]
  }
  return yamlSerialize(template)
```

Nuclei runs the templates. We don't build a scanner — we build the intelligence that tells a scanner what to test.

---

## 7. What This Document Doesn't Cover

- **Repo structure, CLI commands, MCP tools** — See the existing vision doc.
- **Active exploitation tooling** — Beyond noting what active tests would prove, the exploit tools themselves are out of scope for this threat model.
- **Post-exploitation** — Network/OS level, not our domain.
- **Business logic testing** — Requires human context we can't automate.
- **Client-side vulnerabilities** — XSS, DOM-based attacks. ApiTap captures API traffic, not rendered HTML.

---

## Summary

**5 of 10 OWASP API risks are detectable with high confidence from passive traffic analysis alone.** 3 more can be flagged with medium confidence (candidates requiring active confirmation). 2 require business context or multi-user comparison.

The auth analysis layer adds significant detection beyond OWASP — JWT weaknesses, token entropy, session cookie misconfiguration, and CSRF gaps are all directly observable from captured traffic.

The key architectural insight: **ApiTap Red doesn't need to be a scanner.** Its intelligence is in *knowing what to look for* based on the captured API surface. Nuclei (or manual testing) does the active verification. ApiTap Red is the analyst, not the weapon.
