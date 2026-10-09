# A gone Item keeps its row only while there is a money trail

Attic is about what the User has now, not everything they ever bought. An Item that leaves keeps its row only when its exit has a money trail worth asking about later: sold and given (sale and donation records), and lost, stolen, and destroyed (claims). An Item that was returned or thrown away is deleted.

An earlier design never deleted anything and had a `discarded` status. It was dropped as clutter.

## Consequences

- A replaced Fixture, such as the old dishwasher, is deleted. Its history survives as Work on the Property.
- Deleting is a normal operation and not a rare correction, so the change log has to be able to bring a deleted row back.
