-- What request_upload_link was asked for, kept until its link runs out: the details the model
-- read from a file, and the records the Document will be attached to. The Document is made
-- when the file arrives, from what is here (ADR 0008).
--
-- The link is asked for from the client's server and opened a moment later from the User's
-- phone, so the request waits in D1, which every location reads the same. KV can take up to a
-- minute to show a write in another location.
--
-- A request is not a record. No Change has one, and asking for a link deletes the ones that
-- have run out.
CREATE TABLE upload_requests (
  id       TEXT PRIMARY KEY,
  request  TEXT NOT NULL CHECK (json_valid(request) AND json_type(request) = 'object'),
  until    INTEGER NOT NULL              -- when the link runs out, in milliseconds since 1970
);
