insert into lab_api.accounts (id, email, display_name, created_at)
values
  ('11111111-1111-4111-8111-111111111111', 'approved-owner@example.test', 'Approved Test Owner', '2025-01-01T12:00:00Z'),
  ('22222222-2222-4222-8222-222222222222', 'other-owner@example.test', 'Other Test Owner', '2025-02-01T12:00:00Z');

insert into lab_api.entries (id, owner_id, title, amount, details, created_at)
overriding system value
select
  series,
  case
    when series <= 10000 then '11111111-1111-4111-8111-111111111111'::uuid
    else '22222222-2222-4222-8222-222222222222'::uuid
  end,
  'Synthetic entry ' || series,
  ((series % 25000) + 1)::numeric / 100,
  jsonb_build_object('synthetic', true, 'sequence', series),
  timestamptz '2025-01-01T00:00:00Z' + ((series - 1) * interval '3 minutes')
from generate_series(1, 10003) as series;

insert into publication.documents (id, owner_id, slug, title, published_at, metadata)
overriding system value
values
  (500, '11111111-1111-4111-8111-111111111111', 'welcome', 'Welcome', '2025-04-01T12:00:00Z', '{"audience":"public"}'),
  (501, '11111111-1111-4111-8111-111111111111', 'migration-guide', 'Migration Guide', '2025-04-02T12:00:00Z', '{"audience":"members"}'),
  (600, '22222222-2222-4222-8222-222222222222', 'scope-control', 'Scope Control', null, '{"audience":"private"}');

select setval(pg_get_serial_sequence('lab_api.entries', 'id'), (select max(id) from lab_api.entries), true);
select setval(pg_get_serial_sequence('publication.documents', 'id'), (select max(id) from publication.documents), true);

insert into rehearsal_migrations.schema_migrations (version, name, statements)
values (
  '20261004000100',
  'create_lab_model',
  array['Synthetic lab schema installed from the reviewed migration file.']
);
