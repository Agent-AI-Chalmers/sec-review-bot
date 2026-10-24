-- Immutable memory history. Every successful maintenance commit inserts one row; active state
-- advances by moving a separate pointer and never overwrites these artifact or audit references.
create table revisions (
  revision bigint primary key check (revision > 0),
  artifact_reference jsonb not null,
  maintenance_audit_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table revisions is
  'Immutable history of successfully committed memory tree revisions and the maintenance audit that produced each one.';
comment on column revisions.artifact_reference is
  'Content-addressed memory version published before this revision committed.';
comment on column revisions.maintenance_audit_reference is
  'Content-addressed transcript bundle for the maintainer invocation that produced this revision.';

-- Observations retain their extraction audit independently. consumed_revision is both the
-- pending marker and the durable provenance edge to the revision that absorbed the observation.
create table observations (
  observation_id text primary key,
  source_workflow text not null,
  source_run_id text not null,
  source_review_unit_id text not null,
  transcript_digest text not null,
  body_markdown text not null,
  audit_reference jsonb not null,
  consumed_revision bigint references revisions(revision),
  created_at timestamptz not null default clock_timestamp()
);

comment on table observations is
  'Durable extracted observations, including their extraction audit and the immutable revision that consumed them.';
comment on column observations.consumed_revision is
  'NULL while pending; otherwise the immutable memory revision that consumed this observation.';

-- This singleton is only the mutable active pointer. Revision zero represents an empty catalog
-- before the first maintenance commit and deliberately has no revisions row.
create table active_revision (
  singleton boolean primary key default true check (singleton),
  revision bigint not null check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table active_revision is
  'Mutable pointer to the active immutable memory revision; revision zero means no memory version has been committed.';

insert into active_revision (singleton, revision) values (true, 0);
