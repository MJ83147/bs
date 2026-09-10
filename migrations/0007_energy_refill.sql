-- Energy refill reimbursement: members request a fixed cash amount (an "energy
-- refill token") through the normal request flow. Eligibility scales with the
-- competition: a member needs energy_min_attacks_per_day attacks for each day
-- since comp_start (leave comp_start blank to disable the eligibility check).
INSERT OR IGNORE INTO config (key, value) VALUES
  ('energy_refill_amount', '1000000'),
  ('energy_min_attacks_per_day', '30'),
  ('comp_start', '');
