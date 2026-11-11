## Purpose

Let Inbox captures use a dispatcher model to choose skills without making the capture wait for, or depend on, a model provider.

## ADDED Requirements

### Requirement: Capture never waits for a model
The capture request SHALL commit and respond without performing network I/O. A capture transaction SHALL NOT call a model provider, refresh a credential, or hold an outline lock while another service is contacted.

#### Scenario: Slow provider
- **WHEN** a capture matches a dispatcher policy and the provider takes ten seconds to answer
- **THEN** the capture response returns without waiting and other writes to the outline are not delayed

### Requirement: Durable classification
When a capture matches a policy that delegates skill selection to a dispatcher, the server SHALL record a classification job in the capture transaction. A worker SHALL classify the capture and admit the selected runs. A job SHALL survive a server restart and SHALL be retried within a bounded number of attempts.

#### Scenario: Server restarts after capture
- **WHEN** the server stops after a capture commits and before its classification runs
- **THEN** the classification runs after restart and admits the selected runs once

#### Scenario: Repeated classification
- **WHEN** a classification job is retried after partially admitting runs
- **THEN** each selected skill has exactly one run for that capture

### Requirement: Provider failure keeps the capture
A dispatcher failure SHALL NOT remove, roll back or fail the capture. After the retry bound, the job SHALL end as failed with a recorded reason and admit no runs.

#### Scenario: Provider rejects the credential
- **WHEN** the dispatcher's credential is rejected
- **THEN** the note remains in the Inbox, no run is admitted, and the failure is recorded and logged

### Requirement: Rule-based policies stay atomic
A capture that matches a policy with fixed skills SHALL admit its runs in the capture transaction.

#### Scenario: Fixed-skill policy
- **WHEN** a capture matches a policy with a fixed skill list
- **THEN** the note and its runs are committed together or not at all

### Requirement: Bounded outbound calls
Every server call to an OAuth or model endpoint SHALL carry a deadline.

#### Scenario: Token endpoint hangs
- **WHEN** an OAuth token refresh receives no response
- **THEN** the call fails at its deadline and releases any database resources it held
