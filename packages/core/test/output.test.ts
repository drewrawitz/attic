import { expect, it } from "@effect/vitest";
import { formatRow } from "../src/output.ts";

it("a JSON column comes out parsed", () => {
  const row = {
    id: "i1",
    name: "Fridge",
    data: '{"brand":"Samsung","parts":{"water-filter":{"part_number":"DA97-17376B"}}}',
    documents: '[{"id":"d1","kind":"receipt","title":null}]',
  };

  expect(formatRow(row)).toEqual({
    id: "i1",
    name: "Fridge",
    data: { brand: "Samsung", parts: { "water-filter": { part_number: "DA97-17376B" } } },
    documents: [{ id: "d1", kind: "receipt", title: null }],
  });
});

it("a _cents column comes out in dollars, under the same name without _cents", () => {
  const row = { name: "Treadmill", price_cents: 129999, proceeds_cents: null, quantity: 2 };

  expect(formatRow(row)).toEqual({
    name: "Treadmill",
    price: 1299.99,
    proceeds: null,
    quantity: 2,
  });
});

it("a data key ending in _cents comes out in dollars too, however deep it sits", () => {
  const row = {
    data: JSON.stringify({
      listing: { where: "Facebook Marketplace", asking_cents: 15000 },
      payments: [{ paid_on: "2024-05", amount_cents: 250050 }],
    }),
  };

  expect(formatRow(row)).toEqual({
    data: {
      listing: { where: "Facebook Marketplace", asking: 150 },
      payments: [{ paid_on: "2024-05", amount: 2500.5 }],
    },
  });
});

it("a _cents value stays as stored when its plain name is already taken, so neither is lost", () => {
  const row = { data: JSON.stringify({ asking: "or best offer", asking_cents: 15000 }) };

  expect(formatRow(row)).toEqual({ data: { asking: "or best offer", asking_cents: 15000 } });
});

// A JSON column always holds an object or a list. Text that parses to anything else is not
// one, whatever its column is called.
it("text that is not a JSON object or list is left as it is", () => {
  const row = { documents: "2023", data: "not json", items: null };

  expect(formatRow(row)).toEqual({ documents: "2023", data: "not json", items: null });
});
