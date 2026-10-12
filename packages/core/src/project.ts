import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** The statuses a Project can have. One that is open is still being planned or worked on. */
export const PROJECT_STATUSES = ["open", "done", "dropped"] as const;

/** A Project as a tool finds it, with the Property it is at. */
export interface Project {
  readonly id: string;
  readonly title: string;
  readonly status: (typeof PROJECT_STATUSES)[number];
  readonly property_id: string;
  /** The name of its Property. */
  readonly property: string;
}

/**
 * The Projects among these ids, each by its id. One that is not there is not among them, and a
 * caller that names none reads nothing. A Project is found by its id and never by its title,
 * because two Projects can have the same title.
 */
export const projectsById = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return new Map<string, Project>();
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql<Project>`
    SELECT project.id, project.title, project.status, project.property_id,
           property.name AS property
      FROM projects AS project
      JOIN properties AS property ON property.id = project.property_id
     WHERE project.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  return new Map(projects.map((project): [string, Project] => [project.id, project]));
});
