## Purpose

Let skill calls that ran on the server continue as conversations from any connected device, with transcripts kept in the server's database under the same rules as local call conversations.

## ADDED Requirements

### Requirement: Server calls are conversations
In server mode, a manual skill run SHALL start a call, and replies to it SHALL resume the call's agent conversation on the server with the behavior defined for call conversations: full prior transcript, fresh outline context each turn, inline answers, and replacing revisions. Inbox automation runs SHALL NOT be replyable.

#### Scenario: Ask about a server run
- **WHEN** the user replies with a question to a completed server-mode call
- **THEN** the server resumes that call's conversation and the answer appears inline in the call's thread
- **AND** the outline is unchanged

#### Scenario: Automation run
- **WHEN** the user opens an Inbox automation run in the activity panel
- **THEN** no reply box is offered

### Requirement: Transcripts stored on the server
The transcript of a server call SHALL be stored in the server database, scoped to the outline owner, and SHALL NOT depend on files on the server host. Stored transcripts SHALL NOT contain credential values. Any device bound to the outline SHALL be able to view the call's thread and reply to it.

#### Scenario: Continue on another device
- **WHEN** a call is started on one desktop and the user replies from another desktop bound to the same outline
- **THEN** the reply resumes the same conversation with the earlier turns intact

### Requirement: Retry-safe turns
A turn's transcript entries SHALL be stored only when the run settles successfully, in the same transaction that records its outcome. A retried or lease-recovered attempt SHALL resume from the last stored turn, so a turn's entries are never duplicated or partially stored.

#### Scenario: Worker lost mid-turn
- **WHEN** a worker loses its lease during a reply turn and another worker retries the run
- **THEN** the stored transcript contains that turn exactly once, after the retry succeeds

### Requirement: One active turn per server call
The server SHALL reject a reply while any run of the same call is not finished, with a call-busy error, including replies sent from different devices.

#### Scenario: Two devices reply at once
- **WHEN** two devices send replies to the same call at the same time
- **THEN** one reply is admitted and the other is rejected as call-busy

### Requirement: Atomic replacing revision
When a server reply produces an outline result, the server SHALL remove the previous version's generated nodes that still exist and insert the new result in one outline event, which synchronizes and undoes as one unit. If the invocation bullet no longer exists, the result SHALL be retained unplaced and the turn SHALL still be recorded.

#### Scenario: Revision synchronized to another device
- **WHEN** a server reply replaces version 1 with version 2
- **THEN** every bound device receives one event that removes version 1's generated nodes and adds version 2
- **AND** one undo on the originating device restores version 1

### Requirement: Bounded server transcripts
The server SHALL enforce a per-call transcript size limit and an owner-configurable age limit. A reply to a call over its size limit SHALL be refused with a message telling the user to start a new call. Clearing finished activity history SHALL delete the transcripts of the cleared calls, except calls kept for a retained unplaced result.

#### Scenario: Oversized conversation
- **WHEN** the user replies to a call whose stored transcript exceeds the size limit
- **THEN** the reply is refused with the conversation-too-large error and no run is admitted

### Requirement: Engine rollback keeps data safe
If the server is switched back to its previous agent engine, stored transcripts SHALL be retained, and replies to server calls SHALL be refused with a conversation-unavailable error instead of running without history.

#### Scenario: Rolled-back server
- **WHEN** an operator switches the server back to the previous engine and a user replies to a server call
- **THEN** the reply is refused with the conversation-unavailable error and the transcript remains stored
