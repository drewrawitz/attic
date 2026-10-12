# Work is finished, Projects hold the rest

Work has no planned or in-progress state. A Work record always describes something that happened, so the work history and cost-basis totals never need filtering. An effort that is still being planned, or that spans several jobs, lives in a Project, which gathers Quotes, Notes, and Documents and has its own status: open, done, or dropped.

A status column on Work was rejected because one remodel is several pieces of Work, and Quotes need a home before any Work exists.

## Consequences

- A Project is at one Property and does not move to another, as a Space does not (issue 50). Its Spaces and its Work are there. So Work that is in a Project is at the Project's Property: `log_work` refuses a Project at another Property, and refuses to move Work that stays in its Project.
- `log_work` takes a Project by its id, and not by its title, because two Projects can have the same title. For the same reason a save of a Project without an id always creates one.
- With no Property given, new Work in a Project is still at the Current property, and not at the Project's. When the two differ the save is refused, and the error names the Project's Property. Taking the Project's Property in silence was the other choice. It was left out so that where Work is never depends on a field other than `property`.
- Closing a Project is a save that takes it from open to done or dropped. Its `end_on` is then today, unless the save gives one or clears it. A Project that is closed already keeps the `end_on` it has, so putting right a Project that was dropped and not finished does not move its end. Opening one again leaves `end_on` as it is, and the save can clear it. Nothing moves or is copied when a Project closes.
- A Project has one Quote from each Vendor, which the schema holds with a unique index. So a second save for the same Project and Vendor updates the Quote that is there, and a field it leaves out stays as it was. With an id, a save can give a Quote another Vendor or another Project, which is how one saved under a misspelled Vendor is put right without a delete.
- `get_record` takes no Quote, so a Change that touched only a Quote would show nowhere. A Project's `changes` list the Changes of its Quotes with its own, each with the Quote's id as `quote_id`. A Quote is the Project's by what the Change's own snapshots say, so the Change that deleted a Quote is listed, and one that took a Quote to another Project is on both.
- `save_quote` returns the Quote's Project as `project`, with every Quote it has, where another save returns the record it saved as `record`. The other choice was the one Quote, as its Project lists it. The Project was chosen because that is how `get_record` returns a Quote, and because a client that has just saved a Quote most often wants it beside the others.
