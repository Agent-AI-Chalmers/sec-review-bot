-- Every completed extractor invocation is registered, including invocations that produce no
-- observation. The stable extraction id is the idempotency and provenance boundary.
create table extractions (
  extraction_id text primary key,
  source_workflow text not null,
  source_run_id text not null,
  source_unit_id text not null,
  diagnostic_bundle_digest text not null,
  trajectory_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table extractions is
  'Completed memory extractor invocations and their content-addressed trajectories.';
comment on column extractions.diagnostic_bundle_digest is
  'Digest of the immutable run diagnostic bundle supplied to the extraction workflow.';
comment on column extractions.trajectory_reference is
  'Content-addressed compressed trajectory for this extractor invocation.';

-- An extraction produces zero or one observation. Reusing extraction_id as the primary key keeps
-- the one-to-zero-or-one relationship structural instead of maintaining a second identity.
create table observations (
  extraction_id text primary key references extractions(extraction_id),
  body_markdown text not null,
  consumed_revision bigint,
  created_at timestamptz not null default clock_timestamp()
);

comment on table observations is
  'Optional durable observations produced by completed extractions.';
comment on column observations.consumed_revision is
  'NULL while pending; otherwise the immutable memory revision that consumed this observation.';

-- Immutable memory history. Automatic maintenance and authenticated operator actions share the
-- same revision sequence; active state advances through a separate pointer.
create table memory_tree_revisions (
  revision bigint primary key check (revision > 0),
  predecessor_revision bigint references memory_tree_revisions(revision),
  memory_tree_reference jsonb not null,
  source_kind text not null check (source_kind in ('maintenance', 'operator')),
  maintenance_id text unique,
  maintenance_trajectory_reference jsonb,
  operation_id text,
  actor jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint memory_tree_revisions_source_shape_check check (
    (
      source_kind = 'maintenance' and
      maintenance_id is not null and
      maintenance_trajectory_reference is not null and
      operation_id is null and actor is null
    ) or (
      source_kind = 'operator' and
      maintenance_id is null and maintenance_trajectory_reference is null and
      operation_id is not null and actor is not null
    )
  )
);

comment on table memory_tree_revisions is
  'Immutable history of automatic maintenance and authenticated operator memory tree revisions.';
comment on column memory_tree_revisions.maintenance_id is
  'Stable idempotency and provenance identity of the logical maintainer invocation.';
comment on column memory_tree_revisions.predecessor_revision is
  'Revision that was active when this revision was created; NULL for the first revision.';
comment on column memory_tree_revisions.memory_tree_reference is
  'Content-addressed memory tree artifact published before this revision committed.';
comment on column memory_tree_revisions.maintenance_trajectory_reference is
  'Content-addressed compressed trajectory for the maintainer invocation that produced this revision.';
comment on column memory_tree_revisions.source_kind is
  'Tagged provenance kind: automatic maintenance or an authenticated operator action.';
comment on column memory_tree_revisions.operation_id is
  'Stable idempotency identity for an operator edit.';
comment on column memory_tree_revisions.actor is
  'Server-authenticated actor identity for an operator revision.';

create unique index memory_tree_revisions_operation_id_unique
  on memory_tree_revisions (operation_id)
  where operation_id is not null;

alter table observations
  add constraint observations_consumed_revision_fkey
  foreign key (consumed_revision) references memory_tree_revisions(revision);

create index observations_pending_order
  on observations (created_at, extraction_id)
  where consumed_revision is null;

-- This singleton is only the mutable active pointer. Revision zero represents an empty catalog
-- before the first maintenance commit and deliberately has no memory_tree_revisions row.
create table memory_tree_state (
  singleton boolean primary key default true check (singleton),
  active_revision bigint not null check (active_revision >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table memory_tree_state is
  'Mutable pointer to the active immutable memory revision; revision zero means no memory tree has been committed.';

insert into memory_tree_state (singleton, active_revision) values (true, 0);

create table memory_tree_restore_operations (
  operation_id text primary key,
  expected_active_revision bigint not null references memory_tree_revisions(revision),
  restored_revision bigint not null references memory_tree_revisions(revision),
  actor jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table memory_tree_restore_operations is
  'Idempotent audit ledger for active-pointer restores; restores never create revisions.';

create table maintenance_control (
  singleton boolean primary key default true check (singleton),
  state text not null check (state in ('enabled', 'paused')),
  generation bigint not null check (generation >= 0),
  changed_by jsonb not null,
  changed_at timestamptz not null default clock_timestamp()
);

comment on table maintenance_control is
  'Durable singleton controlling whether automatic memory maintenance may commit revisions.';

insert into maintenance_control (
  singleton, state, generation, changed_by
) values (
  true, 'enabled', 0, '{"kind":"service","id":"memory-catalog"}'
);

create table maintenance_control_operations (
  operation_id text primary key,
  target_state text not null check (target_state in ('enabled', 'paused')),
  expected_generation bigint not null check (expected_generation >= 0),
  actor jsonb not null,
  resulting_state text not null check (resulting_state in ('enabled', 'paused')),
  resulting_generation bigint not null check (resulting_generation > 0),
  changed_at timestamptz not null
);

comment on table maintenance_control_operations is
  'Idempotency ledger for explicit pause and resume transitions.';
