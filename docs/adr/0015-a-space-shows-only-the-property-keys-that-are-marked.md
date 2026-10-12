# A Space shows only the Property keys that are marked

A Space comes back from `get_record` with `from_property`: what its Property's `data` says that is true of the Space as well, such as trim paint that is the same in every Space. It used to be the whole of the Property's `data`, less what the Space had an entry of its own for. So a fact about the Property as a whole, which is true of no one Space, showed on every Space under the same name and read as the Space's own. A Property saved with `sqft: 1800` gave a Garage with no size of its own a size of 1800. Its lease and the year it was built showed the same way (issue 47).

Now a Space shows a key of its Property's `data` only when the code marks the key as a fact that is the same in every Space. `paint` and `flooring` are marked. Every other key stays on the Property, whether or not it is one of the well-known keys in `get_schema`.

Under a marked key, what a Space shows is worked out as it was before:

- With no entry of its own, the Space shows the Property's entry whole.
- Where both have an entry and both entries are objects, the Space shows the objects inside the Property's that it has none of its own for. Paint is kept by surface, so a Space with wall paint of its own still shows the Property's trim.
- Anything else inside an entry is the Space's own to say. A Space with flooring of its own shows none of the Property's.

What this gives up: a fact that is the same in every Space, saved under a new key such as `blinds`, shows on no Space until the key is marked.

Whichever list is kept, some key will be missing from it, and what decided this was what a missing key does. Under this rule a key that is missed is left out of a Space. A client can recover from that, because the fact is still on the Property, and the description of `get_record` says to read it there. Under either option below, a key that is missed shows on every Space as the Space's own, and nothing says it is wrong. Asked how big the Garage is, a client has every reason to answer with the size of the Property.

Most of what a client puts on a Property is about the place as a whole, not a default for each Space. Paint is the exception. So a list of what to keep back would have to grow with every new kind of fact, and the list of what to show stays short.

## Considered options

- Show every key but the ones that are kept back: the code would name the keys that are facts about the Property as a whole, as `sqft` and `lease_until` are, and a Space would show the rest. A key nobody named would still show, so `blinds` would work with nothing done. But the next fact about the Property as a whole that a client saved, such as the year it was built or the size of the lot, would show on every Space until someone named it.
- Leave the rule and change the key: the Property's size would go under a key no Space has, such as `total_sqft`, so that it could not be read as a Space's size. Only the list in `get_schema` would change. But the size would still show on every Space, and so would every other fact about the Property as a whole.

## Consequences

- The marks are one list in the code, `FROM_PROPERTY_KEYS` in `packages/core/src/tools/get-schema.ts`. `get_record` reads it, `get_schema` publishes it as `from_property_keys` beside `data_keys`, and the description of `get_record` is written from it. So what a client is told and what a Space shows cannot differ.
- A marked key is one of the Property's well-known keys. The type of the list holds that when the code is checked, and a test holds it in what `get_schema` returns. That is why `flooring` joined the Property's keys.
- `sqft` joined them too, as the size of the whole Property, so that a client has a key to reach for. Either option above would have added it as well.
- Marking a key is a change to the code. Neither a client nor config can mark one.
- `counters` is not marked. A Property's counters would show on the Garage and the Exterior.
- What a Space shows goes by the keys as they are stored. A record shows a key ending in `_cents` in dollars, under the name without `_cents`, and that happens afterwards. So a Property's `flooring_cents` is never taken for its `flooring`, and a Space's `paint_cents` is never taken for paint of its own.
- Neither marked key is promoted to a generated column, which ADR 0002 asks for when a tool starts to branch on a `data` key. A generated column is there for SQL to join, filter, or sort on, and nothing does that with these. `get_record` already has the whole of both `data` objects in hand and copies an entry out of one. A Category's `expects` is read by its name in the same way.
- Nothing stored changes, and there is no migration. A Property that already has `sqft` or `lease_until` in its `data` keeps it there, and its Spaces stop showing it.
- `search` and `query` read `data` as it is stored, so a Property's facts are found there as before.
- The comment on a Property's `data` in the first migration was written for the old rule. It stays as it is, because an applied migration is never edited, and this ADR is where the rule is written down.
