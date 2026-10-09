-- 0001_init.sql
--
-- Vocabulary: see GLOSSARY.md. Property, Space, Item, Fixture, Belonging, Work, Project,
-- Quote, Vendor, Schedule, Document, Note, and Change mean what it says there.
--
-- Shape: a thin typed spine plus a `data` JSON object on every record (ADR 0002).
--   * Typed columns are only for things code joins, filters, sums, or branches on:
--     ids, links between records, kind/status, dates, money.
--   * Everything descriptive goes in `data`, in whatever shape fits the thing.
--     A water heater, a room, and a lease don't need the same fields.
--   * When a tool starts to branch on a `data` key, promote it with a generated column:
--       ALTER TABLE items ADD COLUMN filter_part AS (json_extract(data, '$.filter_part'));
--     No data migration, and it can be indexed. brand, model, serial, and warranty_until
--     below are examples.
--
-- Conventions:
--   ids are TEXT (ULIDs, so they sort by creation time)
--   money is INTEGER cents, in the one currency the deployment is configured for
--   dates are ISO text and may be partial: '2023', '2023-06', or '2023-06-12'.
--     A partial date stands for the whole period it names. Text comparison sorts them,
--     but '2023' < '2023-03-01', so a plain "date >= '2023-03'" misses year-only rows.
--   timestamps are full UTC ISO strings
--   names that tools look records up by (properties, spaces, vendors) ignore case
--   CHECK lists exist only where code branches on the value; everything else is free text.
--
-- Conventions inside `data`:
--   writes are JSON merge patches (json_patch): keys merge, null removes a key, and an
--     array is replaced whole. So a list that gets edited one entry at a time is an
--     object keyed by a slug, not an array.
--   money is integer cents under a key ending in _cents
--   dates follow the same partial ISO rule
--   key names come from the well-known list that the get_schema tool publishes
--
-- Deleting: a row that other rows point at can't be deleted until they are re-pointed.
-- That is why references to vendors, spaces, categories, and projects have no
-- ON DELETE action. Properties are never deleted.
--
-- No FTS5 table on purpose (ADR 0003): D1 can't export a database with virtual tables,
-- and a household's data is small enough that LIKE over text + data is instant.

CREATE TABLE properties (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,  -- "Maple Street house", "Downtown rental"
  tenure      TEXT NOT NULL DEFAULT 'own' CHECK (tenure IN ('own', 'rent', 'other')),
  address     TEXT,
  start_on    TEXT,                           -- purchase, move-in, or lease start
  end_on      TEXT,                           -- the day it stops being yours: sale or move-out.
                                              -- A lease expiry is not end_on; use data.lease_until.
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]'
      OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  CHECK (end_on IS NULL OR end_on GLOB '[0-9][0-9][0-9][0-9]'
      OR end_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR end_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);
-- data examples:
--   {"lease_until":"2027-06","paint":{"trim":{"brand":"Sherwin-Williams","color":"Pure White"}}}
-- House-wide facts live here. A Space's own entry wins over the Property's.

-- A room or area. Its size and what is on its surfaces are facts about the Space,
-- kept in data. They are not Items.
-- data examples:
--   {"sqft":240,
--    "paint":{"walls":{"brand":"Sherwin-Williams","color":"Agreeable Gray","code":"SW 7029","sheen":"eggshell"},
--             "trim":{"color":"Pure White"}},
--    "flooring":{"type":"oak hardwood","installed":"2019"}}
CREATE TABLE spaces (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name         TEXT NOT NULL COLLATE NOCASE,  -- "Kitchen", "Garage", "Crawlspace", "Exterior"
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  UNIQUE (property_id, name)
);

-- Any business or person you pay, buy from, or get a quote from:
-- contractors, stores, a landlord, an HOA, an insurer.
CREATE TABLE vendors (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role        TEXT,                           -- free text: plumber, hvac, retailer, landlord...
  data        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One shared list of categories, nestable (fitness > cardio). New ones can be added,
-- but reusing this list is what stops "fitness" from splitting into fitness/gym/exercise.
-- Every item has one primary category (so totals never double count) and can belong to
-- more through item_categories (a smart watch is electronics and fitness).
-- data.expects lists the `data` keys an item in this category should have. The gaps tool
-- reads it, and an item inherits the expectations of every category it sits under.
CREATE TABLE categories (
  id         TEXT PRIMARY KEY CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9-]*'),  -- slug: 'power-tools'
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES categories(id),
  data       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object')
);

-- Everything in or on a place, one row per line you would write on an insurance claim.
-- A matching set is one row with data.quantity, priced as a whole.
--   scope 'fixture':   stays with the place when you leave
--                      (water heater, ceiling fan, the landlord's fridge)
--   scope 'belonging': yours, moves with you
--                      (router, couch, bikes, jewelry, a car)
-- property_id is where it is now. For a belonging it changes when you move,
-- and it can be null (storage unit, office, lent out).
-- status: 'active' and 'listed' mean you still have it. The rest mean it is gone, and the
--   row stays only because the exit left a money trail (ADR 0009). Something returned or
--   thrown away is deleted, not given a status. 'lost' can go back to 'active'.
--   Details go in data:
--   {"listing":{"where":"Facebook Marketplace","asking_cents":15000,"url":"..."}}
--   {"sold_to":"neighbor","where":"Facebook Marketplace"}
--   {"donated_to":"Habitat ReStore"}
--   {"lost":"left at airport security","claim_number":"..."}
-- price_cents is what was paid. Attic stores no appraisals or resale estimates.
-- data examples:
--   {"brand":"Samsung","model":"RF28R7351SR","serial":"...","warranty_until":"2026-06",
--    "parts":{"water-filter":{"name":"Water filter","part_number":"DA97-17376B"}}}
--   {"brand":"eero","model":"Pro 6E","serial":"...","condition":"good","original_box":true}
--   {"quantity":6}
-- A part's cadence lives on its Schedule, and where it was last bought is the vendor on
-- the latest Work row for that Schedule. Neither is repeated here.
CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id) ON DELETE SET NULL,
  space_id     TEXT REFERENCES spaces(id),
  scope        TEXT NOT NULL DEFAULT 'belonging' CHECK (scope IN ('fixture', 'belonging')),
  category_id  TEXT NOT NULL DEFAULT 'other' REFERENCES categories(id),  -- primary category
  name         TEXT NOT NULL,                 -- "Fridge", "Office router", "Dining chairs"
  acquired_on  TEXT,                          -- bought, received, or installed
  price_cents  INTEGER,                       -- what you paid
  vendor_id    TEXT REFERENCES vendors(id),   -- where you got it
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                 ('active', 'listed', 'sold', 'given', 'lost', 'stolen', 'destroyed')),
  status_on    TEXT,                          -- when it was listed, sold, lost, etc.
  proceeds_cents INTEGER,                     -- what you got back: sale price, insurance payout, trade-in
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  brand          TEXT GENERATED ALWAYS AS (json_extract(data, '$.brand')) VIRTUAL,
  model          TEXT GENERATED ALWAYS AS (json_extract(data, '$.model')) VIRTUAL,
  serial         TEXT GENERATED ALWAYS AS (json_extract(data, '$.serial')) VIRTUAL,
  warranty_until TEXT GENERATED ALWAYS AS (json_extract(data, '$.warranty_until')) VIRTUAL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (acquired_on IS NULL OR acquired_on GLOB '[0-9][0-9][0-9][0-9]'
      OR acquired_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR acquired_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  CHECK (status_on IS NULL OR status_on GLOB '[0-9][0-9][0-9][0-9]'
      OR status_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR status_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  CHECK (scope = 'belonging' OR property_id IS NOT NULL)  -- a fixture has to belong to a place
);

-- Extra categories beyond the primary one.
CREATE TABLE item_categories (
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category_id  TEXT NOT NULL REFERENCES categories(id),
  PRIMARY KEY (item_id, category_id)
);

-- A folder for an effort on a property that is still being planned, or that takes more
-- than one piece of work: "Outdoor lighting", "Kitchen remodel". It gathers quotes, notes,
-- and documents. When a job happens it is logged as work under the project, and the project
-- stays as the story behind it. 'dropped' keeps the quotes for next time.
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  start_on     TEXT,
  end_on       TEXT,                          -- when it was finished or dropped
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]'
      OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  CHECK (end_on IS NULL OR end_on GLOB '[0-9][0-9][0-9][0-9]'
      OR end_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR end_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);

CREATE TABLE project_spaces (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (project_id, space_id)
);

-- What one vendor said a project would cost. One per vendor per project; a revised
-- quote replaces the old one. The PDF it came on is a document linked to the project.
CREATE TABLE quotes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  amount_cents  INTEGER,
  quoted_on     TEXT,
  data          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, vendor_id),
  CHECK (quoted_on IS NULL OR quoted_on GLOB '[0-9][0-9][0-9][0-9]'
      OR quoted_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR quoted_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);

-- Recurring maintenance on a property or on one item, never both. An item's schedule
-- follows the item when it moves. Due a fixed number of days after it was last done:
-- logging work with this schedule_id bumps last_done_on and next_due_on. next_due_on can
-- also be set directly, for a first due date, a snooze, or pulling a seasonal task back
-- to its month. It is always a full date.
CREATE TABLE schedules (
  id             TEXT PRIMARY KEY,
  property_id    TEXT REFERENCES properties(id) ON DELETE CASCADE,
  item_id        TEXT REFERENCES items(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,               -- "Replace fridge water filter"
  interval_days  INTEGER NOT NULL CHECK (interval_days > 0),
  last_done_on   TEXT,
  next_due_on    TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  data           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  CHECK ((property_id IS NULL) <> (item_id IS NULL)),
  CHECK (last_done_on IS NULL OR last_done_on GLOB '[0-9][0-9][0-9][0-9]'
      OR last_done_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR last_done_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  CHECK (next_due_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);

-- Something already done to a property or to items. Work is always finished; anything
-- planned or in progress belongs to a project (ADR 0010). A row needs a property or at
-- least one item, which code enforces because the item link is its own table.
-- kind is the one enum that really matters: for an owned home, improvements generally
-- add to cost basis and repairs don't.
-- cost_cents is everything paid for the job, materials included. It is never added to
-- an item's price: the two answer different questions.
-- On DIY work the vendor is where the materials came from.
-- data holds the rest: permit number, warranty on the work, payments, what was replaced.
CREATE TABLE work (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES projects(id),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('repair', 'maintenance', 'improvement', 'inspection', 'other')),
  title        TEXT NOT NULL,
  description  TEXT,
  date         TEXT,                          -- when it was done (or finished)
  cost_cents   INTEGER,
  diy          INTEGER NOT NULL DEFAULT 0 CHECK (diy IN (0, 1)),
  vendor_id    TEXT REFERENCES vendors(id),
  schedule_id  TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]'
      OR date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);

-- Deleting an item drops its links here. The work rows stay as history on the property.
CREATE TABLE work_items (
  work_id  TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, item_id)
);

CREATE TABLE work_spaces (
  work_id   TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  PRIMARY KEY (work_id, space_id)
);

-- Catch-all for facts that don't fit anywhere else:
-- "breaker 14 is the garage", "HOA approved the fence color", "landlord prefers texts".
-- Optionally attached to a record. Deleting that record deletes its notes, in code.
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id) ON DELETE CASCADE,
  entity_type  TEXT CHECK (entity_type IN ('item', 'work', 'vendor', 'space', 'project')),
  entity_id    TEXT,
  body         TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);

-- Every file. Originals live in R2; this row is the index card. The row is created when
-- the bytes arrive, not when the upload link is requested (ADR 0008).
-- kind: 'receipt' is any proof of what was paid, so invoices and order confirmations
--   are receipts. Finer types (lease, permit, inspection report) go in data.
-- status: pending (arrived, attached to nothing) -> needs_review or filed, or ignored.
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending', 'needs_review', 'filed', 'ignored')),
  kind         TEXT NOT NULL DEFAULT 'other' CHECK (kind IN
                 ('photo', 'receipt', 'quote', 'manual', 'warranty', 'other')),
  title        TEXT,
  doc_date     TEXT,                          -- date on the document, not arrival date
  total_cents  INTEGER,
  vendor_id    TEXT REFERENCES vendors(id),
  source       TEXT,                          -- upload, email...
  r2_key       TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER,
  sha256       TEXT NOT NULL UNIQUE,          -- the same file never gets stored twice
  text         TEXT,                          -- what the file says, for search
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (doc_date IS NULL OR doc_date GLOB '[0-9][0-9][0-9][0-9]'
      OR doc_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
      OR doc_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);

-- Attach any document to any record. This is the provenance trail
-- that makes "include receipts" a join instead of a search.
CREATE TABLE document_links (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN
                 ('work', 'item', 'vendor', 'property', 'space', 'project')),
  entity_id    TEXT NOT NULL,
  PRIMARY KEY (document_id, entity_type, entity_id)
);

-- The change log. A change is one write made through a tool. Every record it touched is
-- a row in change_records, as it was before and after, so a change can be undone and a
-- deleted row brought back. Written in the same atomic batch as the write itself
-- (ADR 0006). Append-only: an undo is a new change that points at the one it reversed.
CREATE TABLE changes (
  id          TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,                  -- the tool that made the write
  undoes      TEXT REFERENCES changes(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- before and after are the whole record: its row plus its link sets (an item's extra
-- categories, a work row's items and spaces). before is null for a create, after is
-- null for a delete.
CREATE TABLE change_records (
  change_id    TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,                 -- 'item', 'work', 'vendor', 'space', 'note'...
  entity_id    TEXT NOT NULL,
  before       TEXT CHECK (before IS NULL OR (json_valid(before) AND json_type(before) = 'object')),
  after        TEXT CHECK (after IS NULL OR (json_valid(after) AND json_type(after) = 'object')),
  PRIMARY KEY (change_id, entity_type, entity_id),
  CHECK (before IS NOT NULL OR after IS NOT NULL)
);

CREATE INDEX items_property         ON items (property_id, scope, category_id);
CREATE INDEX items_space            ON items (space_id);
CREATE INDEX items_category         ON items (category_id);
CREATE INDEX items_vendor           ON items (vendor_id);
CREATE INDEX items_status           ON items (status, status_on);
CREATE INDEX items_model            ON items (model);
CREATE INDEX items_warranty         ON items (warranty_until);
CREATE INDEX item_categories_cat    ON item_categories (category_id);
CREATE INDEX categories_parent      ON categories (parent_id);
CREATE INDEX projects_property      ON projects (property_id, status);
CREATE INDEX project_spaces_space   ON project_spaces (space_id);
CREATE INDEX quotes_vendor          ON quotes (vendor_id);
CREATE INDEX schedules_due          ON schedules (active, next_due_on);
CREATE INDEX schedules_item         ON schedules (item_id);
CREATE INDEX work_property_date     ON work (property_id, date);
CREATE INDEX work_kind_date         ON work (kind, date);
CREATE INDEX work_project           ON work (project_id);
CREATE INDEX work_vendor            ON work (vendor_id, date);
CREATE INDEX work_schedule          ON work (schedule_id, date);
CREATE INDEX work_items_item        ON work_items (item_id);
CREATE INDEX work_spaces_space      ON work_spaces (space_id);
CREATE INDEX notes_entity           ON notes (entity_type, entity_id);
CREATE INDEX documents_status       ON documents (status, received_at);
CREATE INDEX documents_vendor       ON documents (vendor_id);
CREATE INDEX document_links_entity  ON document_links (entity_type, entity_id);
CREATE INDEX change_records_entity  ON change_records (entity_type, entity_id);

-- A property that is still yours today: no end date, or an end date that hasn't passed.
-- A partial end date counts through the whole period it names, so end_on = '2026' is
-- current for all of 2026.
CREATE VIEW current_properties AS
SELECT * FROM properties
WHERE end_on IS NULL
   OR end_on >= substr(date('now'), 1, length(end_on));

-- Flat view for the most common question, and an easy target for model-written SQL:
--   SELECT * FROM work_log
--   WHERE kind IN ('repair', 'improvement') AND date >= '2023-03'
--   ORDER BY date;
-- (That misses rows dated just '2023'. Add OR date = '2023' to catch them.)
CREATE VIEW work_log AS
SELECT
  w.id,
  p.name        AS property,
  pr.title      AS project,
  w.kind,
  w.title,
  w.description,
  w.date,
  w.cost_cents,
  w.diy,
  v.name        AS vendor,
  (SELECT json_group_array(i.name)
     FROM work_items wi JOIN items i ON i.id = wi.item_id
    WHERE wi.work_id = w.id) AS items,
  (SELECT json_group_array(s.name)
     FROM work_spaces ws JOIN spaces s ON s.id = ws.space_id
    WHERE ws.work_id = w.id) AS spaces,
  (SELECT json_group_array(json_object('id', d.id, 'kind', d.kind, 'title', d.title))
     FROM document_links l JOIN documents d ON d.id = l.document_id
    WHERE l.entity_type = 'work' AND l.entity_id = w.id) AS documents,
  w.data
FROM work w
LEFT JOIN properties p ON p.id = w.property_id
LEFT JOIN projects pr  ON pr.id = w.project_id
LEFT JOIN vendors v    ON v.id = w.vendor_id;

-- Every category an item belongs to: its primary, its extras, and all their parents.
-- So a treadmill filed under cardio (a child of fitness) still answers "what fitness stuff do I own":
--   SELECT * FROM inventory
--    WHERE id IN (SELECT item_id FROM item_in_category WHERE category_id = 'fitness');
CREATE VIEW item_in_category AS
WITH RECURSIVE
  direct (item_id, category_id) AS (
    SELECT id, category_id FROM items
    UNION
    SELECT item_id, category_id FROM item_categories
  ),
  up (item_id, category_id) AS (
    SELECT item_id, category_id FROM direct
    UNION
    SELECT up.item_id, c.parent_id
      FROM up JOIN categories c ON c.id = up.category_id
     WHERE c.parent_id IS NOT NULL
  )
SELECT item_id, category_id FROM up;

-- What you have right now, with proof attached. For insurance and selling:
--   SELECT sum(price_cents) FROM inventory WHERE scope = 'belonging';          -- what you paid for your things
--   SELECT name, price_cents FROM inventory WHERE photos = 0 OR receipts = 0;  -- missing proof
--   SELECT * FROM inventory WHERE property = 'Maple Street house' ORDER BY space;  -- room by room
--   SELECT name, json_extract(data, '$.listing.asking_cents') FROM inventory WHERE status = 'listed';
-- Fixtures drop out once you've left the property; your belongings follow you.
CREATE VIEW inventory AS
SELECT
  i.id,
  i.name,
  c.name        AS category,
  (SELECT json_group_array(ic.category_id) FROM item_in_category ic
    WHERE ic.item_id = i.id) AS categories,
  i.scope,
  i.status,
  p.name        AS property,
  s.name        AS space,
  i.brand,
  i.model,
  i.serial,
  i.warranty_until,
  i.acquired_on,
  i.price_cents,
  v.name        AS bought_from,
  (SELECT count(*) FROM document_links l JOIN documents d ON d.id = l.document_id
    WHERE l.entity_type = 'item' AND l.entity_id = i.id AND d.kind = 'photo') AS photos,
  (SELECT count(*) FROM document_links l JOIN documents d ON d.id = l.document_id
    WHERE l.entity_type = 'item' AND l.entity_id = i.id AND d.kind = 'receipt') AS receipts,
  (SELECT json_group_array(json_object('id', d.id, 'kind', d.kind, 'title', d.title))
     FROM document_links l JOIN documents d ON d.id = l.document_id
    WHERE l.entity_type = 'item' AND l.entity_id = i.id) AS documents,
  i.data
FROM items i
JOIN categories c      ON c.id = i.category_id
LEFT JOIN properties p ON p.id = i.property_id
LEFT JOIN spaces s     ON s.id = i.space_id
LEFT JOIN vendors v    ON v.id = i.vendor_id
WHERE i.status IN ('active', 'listed')
  AND NOT (i.scope = 'fixture'
           AND i.property_id NOT IN (SELECT id FROM current_properties));

-- Gone items aren't in inventory, but their rows stay while the money trail matters:
--   SELECT name, status_on, price_cents, proceeds_cents FROM items
--    WHERE status = 'sold' AND status_on >= '2026';                         -- what I sold this year
--   SELECT name, price_cents, status_on FROM items
--    WHERE status IN ('stolen', 'destroyed') AND proceeds_cents IS NULL;    -- claim not paid yet
--   SELECT name, status_on, json_extract(data, '$.donated_to') FROM items
--    WHERE status = 'given' AND status_on >= '2026';                        -- donations for taxes

-- Starter categories. Add, rename, or nest freely; ids are what queries use.
INSERT INTO categories (id, name, parent_id, data) VALUES
  ('appliances',        'Appliances',             NULL,          '{"expects":["brand","model","serial"]}'),
  ('systems',           'Home systems',           NULL,          '{"expects":["brand","model","serial"]}'),  -- hvac, plumbing, electrical, roof
  ('lighting-plumbing', 'Lighting and plumbing',  NULL,          '{}'),  -- light fittings, fans, faucets, toilets
  ('furniture',         'Furniture',              NULL,          '{}'),
  ('electronics',       'Electronics',            NULL,          '{"expects":["brand","model","serial"]}'),
  ('computers',         'Computers',              'electronics', '{}'),
  ('networking',        'Networking',             'electronics', '{}'),
  ('audio-video',       'Audio and video',        'electronics', '{}'),
  ('kitchen',           'Kitchen',                NULL,          '{}'),
  ('tools',             'Tools',                  NULL,          '{}'),
  ('power-tools',       'Power tools',            'tools',       '{}'),
  ('fitness',           'Fitness',                NULL,          '{}'),
  ('outdoor',           'Outdoor and yard',       NULL,          '{}'),
  ('sports',            'Sports and recreation',  NULL,          '{}'),
  ('vehicles',          'Vehicles',               NULL,          '{}'),
  ('office',            'Office',                 NULL,          '{}'),
  ('clothing',          'Clothing',               NULL,          '{}'),
  ('jewelry',           'Jewelry and watches',    NULL,          '{}'),
  ('decor',             'Art and decor',          NULL,          '{}'),
  ('kids',              'Kids and toys',          NULL,          '{}'),
  ('media',             'Books and media',        NULL,          '{}'),
  ('instruments',       'Musical instruments',    NULL,          '{}'),
  ('other',             'Other',                  NULL,          '{}');
