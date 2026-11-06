-- F265: what a record line commits to, kept outside the hashed bytes so it can
-- be deleted (record-v1 section 9, ADR-033 D7). `subject` is the person the row
-- is about: account deletion removes their rows, and their lines still verify.
CREATE TABLE IF NOT EXISTS record_openings (
  chain_id BIGINT NOT NULL REFERENCES record_chains(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  commitment CHAR(67) NOT NULL,
  -- The path the commitment sits at on the line, which decides who may read it.
  field VARCHAR(96) NOT NULL,
  subject VARCHAR(128) NOT NULL,
  value VARCHAR(255) NOT NULL,
  salt CHAR(32) NOT NULL,
  PRIMARY KEY (chain_id, commitment)
);
CREATE INDEX IF NOT EXISTS idx_record_openings_subject ON record_openings (subject);
CREATE INDEX IF NOT EXISTS idx_record_openings_chain_seq ON record_openings (chain_id, seq);
