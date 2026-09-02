## ADDED Requirements

### Requirement: Safe source URL normalization
Source tools SHALL accept only credential-free public HTTP(S) URLs, normalize known host aliases and source identities, preserve the submitted URL for provenance, bound redirects and DNS resolution, and reject local, private, link-local, loopback, multicast, or otherwise special-use targets.

#### Scenario: Normalize a known YouTube URL
- **WHEN** a tool receives a supported `youtu.be` or YouTube watch URL with a valid video identity
- **THEN** it returns the canonical source type and video identity while retaining the submitted URL in provenance

#### Scenario: URL resolves to a private address
- **WHEN** an apparently public hostname resolves to a prohibited private or local address
- **THEN** the tool rejects the request before disclosing it to a downstream reader

### Requirement: Bounded webpage and X reading
The executor SHALL provide tools for reading public webpages and recognized X/Twitter status URLs through injected, allowlisted provider adapters. Results SHALL include normalized URL, available title/author/date metadata, and bounded readable content.

#### Scenario: Read an X status link
- **WHEN** a skill calls the X reader with a recognized public status URL
- **THEN** the tool returns bounded post-aware content and source provenance or a structured unavailable result

#### Scenario: Reader follows a disallowed redirect
- **WHEN** a provider response attempts to redirect outside the permitted contract or to a prohibited target
- **THEN** the tool stops and returns a sanitized non-retryable error

### Requirement: Replaceable YouTube transcript provider
The executor SHALL expose a `youtube_transcript` tool backed by a replaceable provider interface. The initial server adapter SHALL support Supadata immediate and asynchronous transcript responses, language metadata, cancellation, deadlines, and transcripts bounded to 100,000 characters without scraping captions or downloading audio.

#### Scenario: Transcript is immediately available
- **WHEN** the configured provider returns a valid transcript for a supported YouTube video
- **THEN** the tool returns the bounded text, language when available, video identity, and source URL

#### Scenario: Transcript requires asynchronous polling
- **WHEN** the provider accepts a transcript request for asynchronous processing
- **THEN** the adapter polls within configured interval and deadline bounds and returns the eventual result or a classified timeout

#### Scenario: Video has no available transcript
- **WHEN** the provider reports that a valid video cannot be transcribed
- **THEN** the tool returns a sanitized terminal unavailable error and does not attempt audio download or scraping

### Requirement: Untrusted and secret-free tool results
All externally acquired content SHALL be labelled as untrusted before entering model context. Tool results, activity, and errors SHALL be size bounded and SHALL redact provider keys, authorization values, raw internal errors, and deployment details.

#### Scenario: Source contains instructions for the agent
- **WHEN** fetched content includes text that attempts to change system instructions or request another tool
- **THEN** the runtime treats it only as quoted source material and retains the independently computed tool allowlist

#### Scenario: Provider error contains its API key
- **WHEN** an upstream error body or URL includes a configured secret
- **THEN** the executor replaces the secret before persisting or returning the error

### Requirement: Abortable and classified provider failures
Every source-provider call SHALL accept cancellation, enforce connection and total deadlines, and classify failures as transient or terminal for the run retry policy.

#### Scenario: Cancel transcript polling
- **WHEN** a run is cancelled while waiting for a transcript
- **THEN** provider polling stops promptly and no further request or result commit occurs

#### Scenario: Reader returns rate limiting
- **WHEN** a source provider returns a bounded rate-limit response
- **THEN** the tool reports a sanitized transient classification that the run scheduler can retry within its attempt policy
