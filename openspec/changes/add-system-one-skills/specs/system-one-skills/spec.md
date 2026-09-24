# Spec Delta

## Purpose

Provide the whole System One capability as an independently activated extension used through existing user-created skills, producing static ordinary linked output.

## ADDED Requirements

### Requirement: Whole-feature extension ownership
System One configuration, domain types/validation, model selection, candidate policy, Choice/Score/Noul evaluation, semantic filtering, ordering and output formatting SHALL live inside the System One extension. Desktop, public API and shared host production code SHALL use generic extension-backed skill contracts only, without System One/Jev imports, identity branches or question-specific logic.

#### Scenario: Feature is not installed
- **WHEN** the System One extension is absent
- **THEN** no built-in System One execution choice or question forms are available
- **AND** existing extension-backed definitions and plain results remain stored/readable

#### Scenario: Another extension adds a different capability
- **WHEN** a non-evaluation extension declares an executor through the same public contract
- **THEN** its forms, preparation, execution and output work without desktop or shared-host changes

### Requirement: Execution choice in existing skills
The extension SHALL declare a System One execution choice for the existing skill editor. Forage SHALL populate choices generically alongside LLM and render extension-declared fields. Both execution paths SHALL use existing user-created skills and slash invocation, with no extension-installed commands or skills. Missing/disabled executors SHALL retain their configuration and display an unavailable state.

#### Scenario: Create a System One skill
- **WHEN** the user selects the installed System One contribution while creating a skill
- **THEN** declared model/question/scope/presentation fields replace LLM-specific settings
- **AND** the user-defined label appears in the existing slash menu

#### Scenario: Temporarily unavailable feature
- **WHEN** a skill references a missing or unconfigured System One extension
- **THEN** its definition survives and invocation is blocked without automatic installation or fallback

### Requirement: Extension-owned typed question configuration
The extension SHALL declare and validate the reusable rubric: Choice comparison, Choice classification with at least two uniquely labelled categories, Score with at least two ordered nonempty levels, and Noul with optional yes/no definitions and a threshold. Category keys SHALL be derived from position, not authored. The question SHALL come from the text typed after the command; the configured question is an optional default used only when no text is typed. Invalid, duplicate or excessive fields SHALL prevent execution, and an invocation with neither typed text nor a default question SHALL fail before any provider request. Questions SHALL be explicit, not inferred from IDs.

#### Scenario: Configure idea scoring
- **WHEN** Score is configured with ordered descriptions
- **THEN** the extension preserves the rubric and its scale

#### Scenario: Distinguish Choice modes
- **WHEN** Choice classification is selected
- **THEN** category definitions are required
- **AND** comparison instead uses the complete prepared candidate set

#### Scenario: Typed question
- **WHEN** the user types text after the command
- **THEN** that text is the question sent to the provider and the configured default is not used

#### Scenario: Empty invocation prompt
- **WHEN** a skill with a default question is invoked without typed text
- **THEN** extension preparation/execution uses the default question if context and candidates are valid

#### Scenario: No question available
- **WHEN** a skill without a default question is invoked without typed text
- **THEN** preparation fails before any provider request

### Requirement: Extension-owned candidate preparation
Within the host-supplied bounded context, the extension SHALL select direct sibling text candidates with subtree evidence or descendant text notes in document order, excluding the invocation subtree. Ancestors and linked branches SHALL be shared evidence, not additional candidates. It SHALL return a generic bounded plan and preview annotations for host validation without requesting broader outline access. No candidates or fewer than two comparative choices SHALL fail before evaluation.

#### Scenario: Score siblings with linked constraints
- **WHEN** sibling scope links to a constraints branch
- **THEN** the extension selects local sibling candidates and treats constraints as shared evidence

#### Scenario: Filter descendants
- **WHEN** descendant scope is configured
- **THEN** nested text notes in the parent branch are selected in document order except the invocation subtree
- **AND** preview describes the exact prepared selection used for execution

#### Scenario: Invalid input
- **WHEN** links are missing, context exceeds host bounds or candidate requirements fail
- **THEN** no evaluation request or output insertion occurs

### Requirement: Direct bounded evaluation
The extension SHALL execute its admitted context/configuration/plan directly with scoped credentials, no LLM session and no LLM-dispatched tools. Preparation SHALL be deterministic and make no provider request. Execution SHALL validate complete domain answers before returning ordinary structured output. Host progress, cancellation, provenance, deadlines and late-result rejection SHALL remain generic.

#### Scenario: Only a TypeSafe credential is configured
- **WHEN** a ready local skill is invoked
- **THEN** evaluation requires no LLM account for question construction or output formatting

#### Scenario: Notes change after admission
- **WHEN** candidates are edited during evaluation
- **THEN** the extension uses the admitted snapshot rather than changing the running request

### Requirement: Extension-formatted plain linked output
The extension SHALL format valid results as ordinary text/reference nodes with one stable candidate link and at most one short value per row. Comparison SHALL mark the selected candidate; Score SHALL show the nearest rubric level label; classification SHALL group rows under category bullets in configured order, omitting empty categories, with rows below an optional minimum probability grouped last under Unclassified and showing their best-guess category; Noul SHALL list only matching links. Probabilities, scores and confidence SHALL appear in each row's plain bullet note, not in the row text. When the question was typed, rows SHALL be placed directly under the invocation; otherwise a single default-question root SHALL head them. It SHALL not fabricate explanations or mutate source nodes except through opt-in in-place output. Core SHALL only validate/materialize generic output through existing document paths.

#### Scenario: Produce scored rows
- **WHEN** evaluation completes
- **THEN** extension-formatted rows contain links and values and the application commits them atomically as ordinary child bullets
- **AND** numeric detail is written to each row's bullet note
- **AND** original candidates are unchanged

#### Scenario: Group classified rows
- **WHEN** Choice classification completes
- **THEN** each non-empty category is a bullet whose children link its candidates in document order

#### Scenario: Leave uncertain candidates unclassified
- **WHEN** a candidate's chosen category probability is below the configured minimum probability
- **THEN** list output places it under a final Unclassified bullet with its best-guess category as the row value
- **AND** reorder output moves it after every classified candidate and tag output leaves it untagged

### Requirement: Extension-owned ordering and semantic filtering
The extension SHALL order Choice comparison, Score and Noul rows highest value first and classification rows by configured category with rows below the minimum probability last, with document-order ties; in-place reordering SHALL use the same order. Noul filtering SHALL use an inclusive threshold on unrounded yes probabilities from zero to one; rounding SHALL affect display only. Empty filtered output SHALL contain an ordinary no-matches summary.

#### Scenario: Filter actionable notes
- **WHEN** the configured Noul threshold is 0.8
- **THEN** only candidates with raw yes probability at least 0.8 appear in result rows
- **AND** source notes are neither hidden nor edited

#### Scenario: No matches
- **WHEN** no candidate passes
- **THEN** extension output contains the condition and threshold in a plain summary

### Requirement: Opt-in in-place tag output
With tag output, the extension SHALL write no bullets and SHALL return host-applied inline tag edits for the candidates instead. Tag output SHALL be limited to Choice classification and Noul. Classification SHALL tag each candidate with its chosen category's tag, derived from the category label unless a tag is configured, and SHALL leave it untagged when an optional minimum probability is not met. Noul SHALL add its configured tag to candidates at or above the inclusive threshold and remove it from the rest. Each edit SHALL remove the skill's other tags so a rerun replaces the previous answer, and each candidate's answer SHALL be reported in run activity.

#### Scenario: Tag classified notes
- **WHEN** classification with tag output assigns a candidate to the "Build later" category
- **THEN** `#build-later` is appended to the candidate's text and the skill's other category tags are removed from it
- **AND** no result bullets are written

#### Scenario: Rerun Noul tagging
- **WHEN** a candidate previously tagged `#actionable` now falls below the threshold
- **THEN** its `#actionable` tag is removed and its other text is unchanged

#### Scenario: Tag output for an unsupported kind
- **WHEN** a Score or comparison skill selects tag output
- **THEN** configuration validation rejects it before any provider request

### Requirement: Ordinary output lifecycle without extension code
Saved output SHALL use normal persistence, provenance, sync, undo/redo and recoverable placement. It SHALL remain readable/editable/navigable without the extension installed. There SHALL be no special evaluation node, stored executable query, refresh/staleness UI or automatic reevaluation. New invocations SHALL create separate snapshots.

#### Scenario: Edit or reopen notes after removal
- **WHEN** inputs change or the document reopens without System One installed
- **THEN** saved values remain unchanged and no extension execution occurs

#### Scenario: Undo and redo output
- **WHEN** generated content is undone and redone
- **THEN** ordinary document history restores saved values without another evaluation

#### Scenario: Source changes or placement target disappears
- **WHEN** a source moves/renames/is trashed or the invocation target disappears
- **THEN** normal stable-link and completed-unplaced recovery behavior applies without domain-specific core logic

### Requirement: Configuration and execution authority
Supported historical LLM skills SHALL retain behavior. Generic extension references/configuration SHALL synchronize without secrets, paths or trust. Unsupported peers SHALL fail explicitly rather than discard fields. Local-only executor invocation in server mode SHALL fail before queueing without desktop fallback.

#### Scenario: Load old LLM configuration
- **WHEN** supported historical settings load
- **THEN** skill identity, agent, instructions and tool requirements remain equivalent

#### Scenario: Synchronize an unavailable extension skill
- **WHEN** another environment lacks its executor
- **THEN** configuration survives as unavailable without installation or credential transfer

#### Scenario: Invoke in server mode
- **WHEN** System One is invoked with server execution authoritative
- **THEN** generic executor availability checks reject it without desktop or Jev requests
