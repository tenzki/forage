## Purpose

Let the user continue a local skill call from the activity panel as a conversation with the same agent session, getting inline answers to questions or a replacing version of the outline output.

## ADDED Requirements

### Requirement: Call conversation identity
Every local LLM skill run SHALL belong to exactly one call. The first run of a skill on a bullet SHALL start a new call, and each reply to that call SHALL be recorded as the next turn of the same call. The activity panel SHALL group turns by call identity, not by matching bullet and label. History recorded before call identities existed SHALL still group as it does today.

#### Scenario: Reply joins the same call
- **WHEN** the user sends a reply to a completed local call
- **THEN** the new turn appears in the same activity entry as the earlier turns

#### Scenario: Same skill and prompt run again on the same bullet
- **WHEN** the user runs the same skill with the same prompt on the same bullet from the outline, not from the activity reply box
- **THEN** it starts a new call with its own activity entry

### Requirement: Resumed agent conversation
A reply to a local call SHALL continue the agent conversation of that call. The agent SHALL have its complete prior transcript, including earlier user messages, its own responses, tool calls and tool results, and SHALL NOT need to repeat earlier research to refer to it. Session transcripts SHALL be stored only on the local device and SHALL NOT contain credentials.

#### Scenario: Question about earlier research
- **WHEN** the user replies "which source said that?" after a call that searched and read web pages
- **THEN** the agent can answer from the tool results already in the conversation without searching again

#### Scenario: Earlier replies are remembered
- **WHEN** the user sends a third reply after two earlier replies
- **THEN** the agent's conversation contains both earlier replies and its responses to them

### Requirement: Fresh outline context on every turn
Each reply turn SHALL include the current outline context for the invocation bullet, resolved with the same scope rules and safety budget as a first run, plus the current contents under the invocation bullet with agent-written bullets distinguished from the user's bullets. A reply whose context exceeds the budget or references a missing node SHALL fail before the agent runs and SHALL leave the outline unchanged.

#### Scenario: User edited the outline between turns
- **WHEN** the user adds a child bullet under the invocation and then replies "use my note too"
- **THEN** the agent receives that bullet's text in the reply turn

#### Scenario: Context over budget
- **WHEN** the resolved context for a reply exceeds the context safety budget
- **THEN** the reply fails with the budget error and no agent turn starts

### Requirement: Inline answers
When the agent responds to a reply with text and does not produce an outline result, the response SHALL be shown in the call's thread as an answer and SHALL NOT modify the outline. The answer SHALL stream into the thread while it is generated. Answers SHALL be persisted with the call and SHALL be shown again after the app restarts.

#### Scenario: User asks to learn more
- **WHEN** the user replies "why is spaced repetition effective?" to a call that produced a study outline
- **THEN** the explanation appears in the thread under the reply
- **AND** the outline is unchanged

#### Scenario: Answer survives restart
- **WHEN** the app restarts after an answered reply
- **THEN** reopening the call shows the reply and its answer in order

### Requirement: Revisions replace the previous version
When the agent produces an outline result for a reply, the result SHALL become the call's next version. The previous version's agent-written bullets under the invocation SHALL be replaced by the new result in one edit, and bullets the user wrote under the invocation SHALL be kept. The replaced version SHALL remain viewable in the thread for the current session. Version numbers SHALL count only turns that produced an outline result.

#### Scenario: User asks for a change
- **WHEN** the user replies "make it one bullet per technique" and the agent emits a new outline
- **THEN** the previous agent output is replaced by the new result
- **AND** the thread shows the new version as the latest and the old one as superseded

#### Scenario: Answer between versions
- **WHEN** a call has version 1, then an answered question, then a revision
- **THEN** the revision is labeled version 2

### Requirement: Failed or cancelled replies preserve the outline
A reply turn that fails or is cancelled SHALL leave the outline exactly as it was before the reply. The failure or cancellation SHALL be shown in the thread, and the user SHALL be able to reply again.

#### Scenario: Cancelled revision
- **WHEN** the user cancels a reply turn before it completes
- **THEN** the current version's bullets remain in the outline

#### Scenario: Conversation history missing
- **WHEN** the call's stored conversation is missing or unreadable
- **THEN** the reply fails with a message telling the user to run the skill again
- **AND** no new agent conversation is started silently

### Requirement: Single active turn per call
A call SHALL run at most one turn at a time. The reply box SHALL be disabled while a turn of that call is running and SHALL allow the running turn to be cancelled.

#### Scenario: Reply while running
- **WHEN** a turn of the call is running
- **THEN** a new reply cannot be sent until the turn completes, fails or is cancelled

### Requirement: Conversation storage lifecycle
Clearing agent activity history SHALL delete the stored conversations of the removed calls. Calls kept because of a retained unplaced result SHALL keep their conversation. Stored conversations with no remaining call SHALL be deleted when the app starts.

#### Scenario: Clear activity
- **WHEN** the user clears agent activity
- **THEN** the conversations of the cleared calls are deleted from the device

### Requirement: Legacy single-shot steering
Replies to calls without a stored conversation — server-mode calls, extension-backed skills and calls recorded before conversations existed — SHALL keep the existing single-shot behavior: the reply always produces a replacing version from a rebuilt prompt.

#### Scenario: Server-mode call
- **WHEN** the user replies to a call that ran in server mode
- **THEN** the reply produces a new replacing version as before, and no local conversation is created
