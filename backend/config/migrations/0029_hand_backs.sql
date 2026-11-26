-- ADR-037 §3 (F654): the hand-back record. An agent sends a plan to one named
-- person for review, does the work once it's accepted, then hands back what
-- was asked, planned, changed, checked and left unverified for that same
-- person to accept or refuse with a reason. Read and written only through
-- repositories/handBackRepository.ts. ADR-034 D4: new state is a Postgres
-- table; Mongo keeps only the two decision cards a record drives.
--
-- id is a server-made UUID. Agent-written fields (task_id, asked text, plan,
-- next, supersedes, changed, checked, unverified) are written once: the plan
-- fields at plan-send, the result fields at hand-back. Every state change is a
-- compare-and-set on status (UPDATE ... WHERE id = $1 AND status = $2), so a
-- lost race returns no row and the caller answers stale_state.
--
-- asked is {text, requesterUserId, requesterAgentUserId?, provenance,
-- sourceMessageId?}; provenance is 'message', 'task' or 'owner' and says how
-- the server derived the requester. next is {agentUserId, agentName,
-- instanceId}. plan_ruling and handback_ruling copy the card's ruling as
-- {verdict, reason, byUserId, at}. owner_installed_by and owner_user_id are
-- the agent's two owner sources, each null when it isn't a person.
--
-- received_enqueued_at is when handback.received was queued for the next
-- agent. It is set once (WHERE received_enqueued_at IS NULL) after a
-- successful enqueue; an accepted record with a next agent and no stamp is
-- what the sweep retries.
--
-- Self-contained, and a no-op where the table already exists.
CREATE TABLE IF NOT EXISTS hand_backs (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  thread_root_id TEXT,
  task_id TEXT,
  author_agent_user_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  owner_installed_by TEXT,
  owner_user_id TEXT,
  asked JSONB NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  plan JSONB NOT NULL,
  plan_decision_id TEXT,
  plan_ruling JSONB,
  next JSONB,
  changed JSONB,
  checked JSONB,
  unverified JSONB,
  handback_decision_id TEXT,
  handback_ruling JSONB,
  supersedes TEXT,
  status TEXT NOT NULL,
  withdrawn_by JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  plan_ruled_at TIMESTAMPTZ,
  handed_back_at TIMESTAMPTZ,
  ruled_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  received_enqueued_at TIMESTAMPTZ
);

-- A pod's records, newest first (GET /api/pods/:podId/hand-backs).
CREATE INDEX IF NOT EXISTS hand_backs_pod_created ON hand_backs (pod_id, created_at DESC);
-- The reconcile sweep reads open records only.
CREATE INDEX IF NOT EXISTS hand_backs_status ON hand_backs (status);
