begin;

insert into lab_api.accounts (
  id, email, display_name, role, avatar_path, preferences, created_at, updated_at
) values
  (
    '11111111-1111-4111-8111-111111111111',
    'approved-owner@example.test',
    'Approved Test Owner',
    'owner',
    '11111111-1111-4111-8111-111111111111/avatar.txt',
    '{"theme":"mint","notifications":{"email":true,"push":false}}',
    '2025-01-01T12:00:00Z',
    '2025-01-02T12:00:00Z'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'other-owner@example.test',
    'Other Test Owner',
    'viewer',
    '22222222-2222-4222-8222-222222222222/avatar.txt',
    '{"theme":"slate","notifications":{"email":false,"push":true}}',
    '2025-02-01T12:00:00Z',
    '2025-02-02T12:00:00Z'
  );

insert into lab_api.projects (id, owner_id, name, slug, settings, created_at)
overriding system value
values
  (100, '11111111-1111-4111-8111-111111111111', 'Primary Synthetic Project', 'primary-synthetic', '{"currency":"USD","archived":false}', '2025-01-03T12:00:00Z'),
  (200, '22222222-2222-4222-8222-222222222222', 'Scope Control Project', 'scope-control', '{"currency":"EUR","archived":false}', '2025-02-03T12:00:00Z');

insert into lab_api.entries (
  id, project_id, owner_id, title, amount, status, details, occurred_on, created_at
)
overriding system value
select
  series,
  case when series <= 10000 then 100 else 200 end,
  case
    when series <= 10000 then '11111111-1111-4111-8111-111111111111'::uuid
    else '22222222-2222-4222-8222-222222222222'::uuid
  end,
  'Synthetic entry ' || series,
  ((series % 25000) + 1)::numeric / 100,
  case
    when series % 11 = 0 then 'archived'::lab_api.entry_status
    when series % 3 = 0 then 'draft'::lab_api.entry_status
    else 'active'::lab_api.entry_status
  end,
  jsonb_build_object(
    'category', case when series % 2 = 0 then 'even' else 'odd' end,
    'sequence', series,
    'flags', jsonb_build_array('synthetic', case when series <= 10000 then 'approved' else 'control' end)
  ),
  date '2025-01-01' + ((series - 1) % 365),
  timestamptz '2025-01-01T00:00:00Z' + ((series - 1) * interval '3 minutes')
from generate_series(1, 10003) as series;

insert into lab_api.audit_events (id, owner_id, event_type, payload, occurred_at)
overriding system value
select
  series,
  '11111111-1111-4111-8111-111111111111'::uuid,
  case when series % 2 = 0 then 'entry.reviewed' else 'entry.created' end,
  jsonb_build_object('synthetic', true, 'ordinal', series),
  timestamptz '2025-03-01T00:00:00Z' + (series * interval '1 hour')
from generate_series(1, 30) as series;

insert into publication.documents (id, owner_id, slug, title, published_at, metadata)
overriding system value
values
  (500, '11111111-1111-4111-8111-111111111111', 'welcome', 'Welcome', '2025-04-01T12:00:00Z', '{"audience":"public"}'),
  (501, '11111111-1111-4111-8111-111111111111', 'migration-guide', 'Migration Guide', '2025-04-02T12:00:00Z', '{"audience":"members"}'),
  (600, '22222222-2222-4222-8222-222222222222', 'scope-control', 'Scope Control', null, '{"audience":"private"}');

insert into publication.document_items (id, document_id, position, body)
overriding system value
values
  (700, 500, 1, 'Synthetic public introduction.'),
  (701, 500, 2, 'Synthetic second section.'),
  (702, 501, 1, 'Synthetic migration content.'),
  (800, 600, 1, 'This control row belongs to another synthetic owner.');

select setval(pg_get_serial_sequence('lab_api.projects', 'id'), (select max(id) from lab_api.projects), true);
select setval(pg_get_serial_sequence('lab_api.entries', 'id'), (select max(id) from lab_api.entries), true);
select setval(pg_get_serial_sequence('lab_api.audit_events', 'id'), (select max(id) from lab_api.audit_events), true);
select setval(pg_get_serial_sequence('publication.documents', 'id'), (select max(id) from publication.documents), true);
select setval(pg_get_serial_sequence('publication.document_items', 'id'), (select max(id) from publication.document_items), true);

commit;
