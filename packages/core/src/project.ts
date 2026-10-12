import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { noRecord } from "./tool.ts";

/** The statuses a Project can have. One that is open is still being planned or worked on. */
export const PROJECT_STATUSES = ["open", "done", "dropped"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A Project as a tool finds it, with the Property it is at. */
export interface Project {
  readonly id: string;
  readonly title: string;
  readonly status: ProjectStatus;
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

/**
 * The Project with an id, among the ones a call has read. It has to be there: one that is not
 * is an error that names the id.
 */
export const projectAmong = (id: string, projects: ReadonlyMap<string, Project>) => {
  const found = projects.get(id);
  return found !== undefined ? Effect.succeed(found) : Effect.fail(noRecord("project", id));
};

/** The Project with an id, read now. It has to be there. */
export const projectWith = Effect.fnUntraced(function* (id: string) {
  return yield* projectAmong(id, yield* projectsById([id]));
});
