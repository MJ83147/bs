-- Record who acted on a request (approved / declined / sent) so the banker column is never blank.
ALTER TABLE requests ADD COLUMN handled_by TEXT;
