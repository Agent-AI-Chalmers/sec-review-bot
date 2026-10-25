-- Every completed extractor invocation is registered, including invocations that produce no
-- observation. The stable extraction id is the idempotency and provenance boundary.
create table extractions (
  extraction_id text primary key,
  source_workflow text not null,
  source_run_id text not null,
  source_review_unit_id text not null,
  diagnostic_bundle_digest text not null,
  transcript_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table extractions is
  'Completed memory extractor invocations and their content-addressed transcripts.';
comment on column extractions.diagnostic_bundle_digest is
  'Digest of the immutable run diagnostic bundle supplied to the extraction workflow.';
comment on column extractions.transcript_reference is
  'Content-addressed compressed transcript for this extractor invocation.';

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

-- Immutable memory history. Every successful maintenance commit inserts one row; active state
-- advances by moving a separate pointer and never overwrites these artifact references.
create table revisions (
  revision bigint primary key check (revision > 0),
  memory_tree_reference jsonb not null,
  maintenance_transcript_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table revisions is
  'Immutable history of successfully committed memory tree revisions and the maintainer transcript that produced each one.';
comment on column revisions.memory_tree_reference is
  'Content-addressed memory tree artifact published before this revision committed.';
comment on column revisions.maintenance_transcript_reference is
  'Content-addressed compressed transcript for the maintainer invocation that produced this revision.';

alter table observations
  add constraint observations_consumed_revision_fkey
  foreign key (consumed_revision) references revisions(revision);

create index observations_pending_order
  on observations (created_at, extraction_id)
  where consumed_revision is null;

-- This singleton is only the mutable active pointer. Revision zero represents an empty catalog
-- before the first maintenance commit and deliberately has no revisions row.
create table active_revision (
  singleton boolean primary key default true check (singleton),
  revision bigint not null check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table active_revision is
  'Mutable pointer to the active immutable memory revision; revision zero means no memory tree has been committed.';

insert into active_revision (singleton, revision) values (true, 0);
