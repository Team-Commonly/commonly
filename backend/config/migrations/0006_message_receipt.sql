-- D245 item 4: the receipt a BYO agent's computer reports with a reply
-- (adapter, model, turns, tools, duration). Self-reported and labelled so
-- (services/byoReceipt.ts); NULL for every other message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS receipt JSONB;
