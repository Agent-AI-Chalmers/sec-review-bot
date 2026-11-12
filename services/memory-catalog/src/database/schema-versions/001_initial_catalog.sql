-- Every completed extractor invocation is registered, including invocations that produce no
-- observation. The stable extraction id is the idempotency and provenance boundary.
create table extractions (
  extraction_id text primary key,
  source_workflow text not null,
  source_run_id text not null,
  source_unit_id text not null,
  execution_archive_digest text not null,
  trajectory_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table extractions is
  'Completed memory extractor invocations and their content-addressed trajectories.';
comment on column extractions.execution_archive_digest is
  'Digest of the immutable execution archive supplied to the extraction workflow.';
comment on column extractions.trajectory_reference is
  'Content-addressed compressed trajectory for this extractor invocation.';

-- Each extraction produces zero or more independently maintained observations.
create table observations (
  observation_id text primary key,
  extraction_id text not null references extractions(extraction_id),
  body_markdown text not null,
  consumed_revision bigint,
  created_at timestamptz not null default clock_timestamp()
);

comment on table observations is
  'Independent durable observations produced by completed extractions.';
create index observations_extraction on observations (extraction_id);
comment on column observations.consumed_revision is
  'NULL while pending; otherwise the immutable memory revision that consumed this observation.';

-- Immutable memory history. Learning, reorganization, and manual edits share the same revision
-- sequence; active state advances through a separate pointer.
create table memory_tree_revisions (
  revision bigint primary key check (revision > 0),
  predecessor_revision bigint references memory_tree_revisions(revision),
  memory_tree_reference jsonb not null,
  source_kind text not null check (source_kind in ('learning', 'reorganization', 'manual')),
  operation_id text not null,
  trajectory_reference jsonb,
  maintenance_report jsonb,
  actor jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (operation_id),
  constraint memory_tree_revisions_source_shape_check check (
    (
      source_kind in ('learning', 'reorganization') and
      trajectory_reference is not null and maintenance_report is not null and
      actor is null
    ) or (
      source_kind = 'manual' and
      trajectory_reference is null and maintenance_report is null and
      actor is not null
    )
  )
);

comment on table memory_tree_revisions is
  'Immutable history of learning, reorganization, and manual memory tree revisions.';
comment on column memory_tree_revisions.predecessor_revision is
  'Revision that was active when this revision was created; NULL for the first revision.';
comment on column memory_tree_revisions.memory_tree_reference is
  'Content-addressed memory tree artifact published before this revision committed.';
comment on column memory_tree_revisions.trajectory_reference is
  'Content-addressed compressed trajectory for the maintainer invocation that produced this revision.';
comment on column memory_tree_revisions.source_kind is
  'Tagged provenance kind: learning, reorganization, or manual.';
comment on column memory_tree_revisions.operation_id is
  'Globally unique idempotency identity of a revision operation.';
comment on column memory_tree_revisions.actor is
  'Server-authenticated actor identity for a manual revision.';

alter table observations
  add constraint observations_consumed_revision_fkey
  foreign key (consumed_revision) references memory_tree_revisions(revision);

create index observations_pending_order
  on observations (created_at, observation_id)
  where consumed_revision is null;

-- This singleton is only the mutable active pointer. Revision zero represents an empty catalog
-- before the first revision commit and deliberately has no memory_tree_revisions row.
create table memory_tree_state (
  singleton boolean primary key default true check (singleton),
  active_revision bigint not null check (active_revision >= 0)
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

create table memory_tree_automation (
  singleton boolean primary key default true check (singleton),
  state text not null check (state in ('enabled', 'paused')),
  generation bigint not null check (generation >= 0),
  changed_by jsonb not null,
  changed_at timestamptz not null default clock_timestamp()
);

comment on table memory_tree_automation is
  'Durable singleton controlling whether new learning and reorganization memory-tree revisions may commit.';

insert into memory_tree_automation (
  singleton, state, generation, changed_by
) values (
  true, 'enabled', 0, '{"kind":"service","id":"memory-catalog"}'
);

create table memory_tree_automation_operations (
  operation_id text primary key,
  target_state text not null check (target_state in ('enabled', 'paused')),
  expected_generation bigint not null check (expected_generation >= 0),
  actor jsonb not null,
  changed_at timestamptz not null
);

comment on table memory_tree_automation_operations is
  'Idempotency ledger for explicit pause and resume transitions.';

-- Full intents survive worker/BFF loss between object publication and attachment.
-- Multiple model attempts may produce different bytes for the same logical owner.
create table extraction_publications (
  extraction_id text not null,
  digest text not null,
  intent jsonb not null,
  status text not null default 'reserved' check (status in ('reserved', 'present', 'selected')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (extraction_id, digest),
  check (extraction_id = intent #>> '{registration,extraction_id}'),
  check (digest = intent #>> '{registration,trajectory_reference,digest}')
);
create unique index extraction_publications_selected on extraction_publications (extraction_id) where status = 'selected';

create table memory_revision_publications (
  source_kind text not null check (source_kind in ('learning', 'reorganization', 'manual')),
  operation_id text not null,
  tree_digest text not null,
  trajectory_digest text not null,
  intent jsonb not null,
  status text not null default 'reserved' check (status in ('reserved', 'present', 'selected', 'abandoned')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (source_kind, operation_id, tree_digest, trajectory_digest),
  check (source_kind = intent #>> '{source,kind}'),
  check (operation_id = intent #>> '{source,operation_id}'),
  check (tree_digest = intent #>> '{memory_tree_reference,digest}'),
  check (trajectory_digest = coalesce(intent #>> '{source,trajectory_reference,digest}', ''))
);
create unique index memory_revision_publications_selected on memory_revision_publications (operation_id) where status = 'selected';
