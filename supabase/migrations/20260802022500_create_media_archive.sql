create table public.media_events (
  id text primary key,
  name text not null,
  starts_at timestamptz not null,
  uploads_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.media_events (id, name, starts_at)
values ('homedred-2026', 'Homedred Miler 2026', '2026-08-08T10:00:00-07:00')
on conflict (id) do update
set name = excluded.name,
    starts_at = excluded.starts_at;

create table public.media_items (
  id uuid primary key,
  event_id text not null references public.media_events(id),
  uploader_id uuid not null references auth.users(id) on delete cascade,
  contributor_name text not null check (
    char_length(trim(contributor_name)) between 1 and 60
  ),
  media_type text not null check (media_type in ('photo', 'video', 'audio')),
  storage_path text not null unique,
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 36700160),
  duration_ms integer check (
    duration_ms is null or duration_ms between 0 and 180000
  ),
  captured_at timestamptz not null,
  device_time_zone text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m is null or accuracy_m between 0 and 10000),
  altitude_m double precision,
  heading_deg double precision check (heading_deg is null or heading_deg between 0 and 360),
  nearest_mile double precision check (nearest_mile is null or nearest_mile between 0 and 101),
  route_offset_m double precision check (route_offset_m is null or route_offset_m >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  caption text check (caption is null or char_length(caption) <= 500),
  status text not null default 'ready' check (status in ('ready', 'hidden')),
  uploaded_at timestamptz not null default now(),
  check (
    (media_type = 'photo' and file_size <= 8388608 and duration_ms is null)
    or (media_type = 'video' and file_size <= 36700160 and duration_ms between 1 and 11000)
    or (media_type = 'audio' and file_size <= 15728640 and duration_ms between 1 and 180000)
  )
);

create index media_items_event_time_idx
  on public.media_items (event_id, captured_at desc);

create index media_items_type_time_idx
  on public.media_items (media_type, captured_at desc);

alter table public.media_events enable row level security;
alter table public.media_items enable row level security;

revoke all on public.media_events from anon, authenticated;
revoke all on public.media_items from anon, authenticated;

grant select on public.media_events to anon, authenticated;
grant select on public.media_items to anon;
grant select, insert, update, delete on public.media_items to authenticated;

create policy "Anyone can read media event status"
on public.media_events
for select
to anon, authenticated
using (true);

create policy "Anyone can read published media"
on public.media_items
for select
to anon
using (status = 'ready');

create policy "Contributors can read published and own media"
on public.media_items
for select
to authenticated
using (status = 'ready' or uploader_id = auth.uid());

create policy "Contributors can create their own media records"
on public.media_items
for insert
to authenticated
with check (
  uploader_id = auth.uid()
  and status = 'ready'
  and exists (
    select 1
    from public.media_events event
    where event.id = event_id
      and event.uploads_enabled
  )
);

create policy "Contributors can update their own media records"
on public.media_items
for update
to authenticated
using (uploader_id = auth.uid())
with check (uploader_id = auth.uid());

create policy "Contributors can delete their own media records"
on public.media_items
for delete
to authenticated
using (uploader_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  true,
  36700160,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/webm'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Contributors can upload media files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.media_events
    where id = 'homedred-2026'
      and uploads_enabled
  )
);

create policy "Contributors can update their own media files"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'media'
  and owner_id = auth.uid()::text
)
with check (
  bucket_id = 'media'
  and owner_id = auth.uid()::text
);

create policy "Contributors can delete their own media files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'media'
  and owner_id = auth.uid()::text
);
